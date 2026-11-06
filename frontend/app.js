// ElBot 的独立网页客户端；凭据、消息与附件状态只保留在当前页面。
const utf8 = new TextEncoder();

export function byteOffset(text, position) {
  return utf8.encode(text.slice(0, position)).length;
}

export function utf16Offset(text, position) {
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    if (bytes >= position) break;
    bytes += utf8.encode(character).length;
    index += character.length;
  }
  return index;
}

export function applyCompletion(text, item) {
  // 与 TUI 一致：0,0 表示候选是完整输入行。
  if (item.ReplaceStart === 0 && item.ReplaceEnd === 0) {
    return { text: item.Text, cursor: item.Text.length };
  }
  const start = utf16Offset(text, item.ReplaceStart);
  const end = utf16Offset(text, item.ReplaceEnd);
  return { text: text.slice(0, start) + item.Text + text.slice(end), cursor: start + item.Text.length };
}

export function fileCompletions(text, cursor, names) {
  const prefix = text.slice(0, cursor);
  const match = /(?:^|\s)#(?:"([^"]*)|([^\s"]*))$/u.exec(prefix);
  if (!match) return [];
  const start = match.index + match[0].indexOf("#");
  const query = (match[1] ?? match[2]).toLocaleLowerCase();
  const end = text[cursor] === '"' ? cursor + 1 : cursor;
  return [...new Set(names)].filter(name => name.toLocaleLowerCase().includes(query)).map(name => ({
    Text: `#${/[\s"\\]/u.test(name) ? JSON.stringify(name) : name}`,
    Label: name, Description: "当前消息的附件", Kind: "local_file",
    ReplaceStart: byteOffset(text, start), ReplaceEnd: byteOffset(text, end),
  }));
}

// finish 仅结束生成；send 才用完整正文（包括空正文）替换预览。
export function reduceStream(current, event) {
  if (event.type === "reset") return null;
  if (!current && ["finish", "reasoning_done"].includes(event.type)) return null;
  const next = { text: "", reasoning: "", actions: [], finished: false, reasoningDone: false, committed: false, ...current };
  switch (event.type) {
    case "text_delta": next.text += event.text ?? ""; break;
    case "reasoning_delta": next.reasoning += event.text ?? ""; break;
    case "reasoning_done": next.reasoningDone = true; break;
    case "finish": next.finished = true; break;
    case "send": next.text = event.text ?? ""; next.actions = event.actions ?? []; next.committed = true; next.reasoningDone = true; break;
    default: return current;
  }
  return next;
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

if (typeof document !== "undefined") start();

function start() {
  const $ = id => document.getElementById(id);
  const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
  const state = {
    ws: null, ready: false, generation: 0, mediaToken: "", credentials: null,
    reconnectTimer: null, reconnectAttempt: 0, http: new AbortController(),
    streams: new Map(), inputs: new Map(), completions: new Map(), sequence: 0,
    draftFiles: [], fileItems: new Set(), snapshot: null, completion: null,
    noticeCount: 0, unread: false, modelQuery: 0,
  };
  const phaseNames = { idle: "空闲", preparing: "准备中", llm: "生成中", tool: "工具执行中", sending: "发送中", done: "已完成", error: "发生错误" };
  const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dirty = new Set();
  let renderFrame = 0;
  let dragDepth = 0;
  let modelTimer;

  // Markdown 内的图片只显示替代文字，附件图片由带认证的 HTTP 请求独立获取。
  marked.use({ gfm: true, renderer: { image({ text }) { return escapeHTML(text || "图片"); } } });

  function escapeHTML(text) {
    const element = document.createElement("span");
    element.textContent = text;
    return element.innerHTML;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconButton(name, label, action) {
    const button = element("button", "icon-button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(name));
    button.addEventListener("click", action);
    return button;
  }

  function nearBottom() {
    const scroll = ui["chat-scroll"];
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }

  function scrollBottom() {
    ui["chat-scroll"].scrollTop = ui["chat-scroll"].scrollHeight;
    ui["scroll-bottom"].hidden = true;
  }

  function refreshWelcome() {
    ui.welcome.hidden = ui.messages.childElementCount > 0;
  }

  function scheduleRender(view) {
    dirty.add(view);
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      const follow = nearBottom();
      for (const item of dirty) if (item.node.isConnected) renderMessage(item);
      dirty.clear();
      renderFrame = 0;
      refreshWelcome();
      if (follow) scrollBottom();
    });
  }

  function renderMarkdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["img", "video", "audio", "style", "form", "input", "button"],
      FORBID_ATTR: ["style", "id", "name"],
    });
    for (const link of target.querySelectorAll("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    for (const block of target.querySelectorAll("pre")) {
      const code = block.querySelector("code");
      if (!code) continue;
      const copy = iconButton("copy", "复制代码", () => copyText(code.textContent, copy));
      copy.classList.add("code-copy");
      block.append(copy);
    }
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.title = "已复制";
      setTimeout(() => { button.title = "复制"; }, 1500);
    } catch {
      addNotice("WARN", "无法访问剪贴板，可以选中文字后复制。");
    }
  }

  function newMessage(role, data = {}) {
    const follow = nearBottom();
    const node = element("article", `message ${role}`);
    const header = element("div", "message-header");
    const avatar = element("span", "message-avatar");
    if (role === "assistant") {
      const image = document.createElement("img");
      image.src = "assets/elbot-logo.svg";
      image.alt = "";
      avatar.append(image);
    } else avatar.textContent = "你";
    const time = element("time", "message-time", timeFormat.format(new Date()));
    time.dateTime = new Date().toISOString();
    const body = element("div", "message-body");
    const reasoning = element("details", "reasoning");
    const reasoningSummary = element("summary", "", "思考过程");
    const reasoningContent = element("div", "reasoning-content");
    reasoning.append(reasoningSummary, reasoningContent);
    reasoning.hidden = true;
    const files = element("div", "message-files");
    const actions = element("div", "message-actions");
    const status = element("div", "message-state");
    const view = { node, body, reasoning, reasoningSummary, reasoningContent, files, actions, status, role,
      data: { text: "", reasoning: "", actions: [], committed: true, ...data }, renderedText: null };
    const copy = iconButton("copy", "复制消息", () => copyText(view.data.text, copy));
    view.copy = copy;
    copy.classList.add("message-copy");
    header.append(avatar, element("span", "message-author", role === "assistant" ? "ElBot" : "你"), copy, time);
    node.append(header, reasoning, body, files, actions, status);
    ui.messages.append(node);
    renderMessage(view);
    refreshWelcome();
    if (follow) scrollBottom();
    return view;
  }

  function renderMessage(view) {
    const data = view.data;
    if (view.renderedText !== data.text) {
      if (view.role === "assistant") renderMarkdown(view.body, data.text);
      else view.body.textContent = data.text;
      view.renderedText = data.text;
    }
    view.body.hidden = !data.text;
    view.copy.hidden = !data.text;
    view.reasoning.hidden = !data.reasoning;
    view.reasoningContent.textContent = data.reasoning;
    view.reasoningSummary.textContent = data.reasoningDone ? "思考过程" : "正在思考";
    view.status.textContent = data.error || (!data.committed ? (data.finished ? "正在整理回复…" : "生成中…") : "");
    view.status.hidden = !view.status.textContent;
    view.actions.replaceChildren();
    for (const action of data.actions) {
      const button = element("button", "message-action", action.Label);
      button.type = "button";
      button.disabled = !state.ready;
      button.addEventListener("click", () => sendCommand(action.Command, false));
      view.actions.append(button);
    }
  }

  function handleStream(message) {
    const key = message.stream_id;
    const existing = state.streams.get(key);
    const data = reduceStream(existing?.data, message.event);
    if (!data) {
      existing?.node.remove();
      state.streams.delete(key);
      refreshWelcome();
      return;
    }
    if (data.committed && !data.text && !data.reasoning && !data.actions.length) {
      existing?.node.remove();
      state.streams.delete(key);
      refreshWelcome();
      return;
    }
    const view = existing || newMessage("assistant", data);
    view.data = data;
    state.streams.set(key, view);
    scheduleRender(view);
    if (message.event.type === "send") state.streams.delete(key);
  }

  function addNotice(level, text) {
    const follow = ui["notice-scroll"].scrollHeight - ui["notice-scroll"].scrollTop - ui["notice-scroll"].clientHeight < 80;
    const notice = element("article", `notice ${level}`);
    const meta = element("div", "notice-meta");
    const time = element("time", "", timeFormat.format(new Date()));
    time.dateTime = new Date().toISOString();
    meta.append(element("span", "notice-level", level), time);
    notice.append(meta);
    if (text.length > 400) {
      const details = document.createElement("details");
      details.append(element("summary", "", text.split("\n")[0].slice(0, 90)), element("div", "notice-text", text));
      notice.append(details);
    } else notice.append(element("div", "notice-text", text));
    ui.notices.append(notice);
    while (ui.notices.childElementCount > 200) ui.notices.firstElementChild.remove();
    state.noticeCount = ui.notices.childElementCount;
    ui["notice-count"].textContent = state.noticeCount;
    ui["notice-empty"].hidden = true;
    if (follow) ui["notice-scroll"].scrollTop = ui["notice-scroll"].scrollHeight;
    if (ui.workspace.classList.contains("notices-hidden")) {
      state.unread = true;
      ui["notice-unread"].hidden = false;
    }
  }

  function clearNotices() {
    ui.notices.replaceChildren();
    state.noticeCount = 0;
    ui["notice-count"].textContent = "0";
    ui["notice-empty"].hidden = false;
    ui["notice-unread"].hidden = true;
    state.unread = false;
  }

  function toggleNotices(show) {
    ui.workspace.classList.toggle("notices-hidden", !show);
    ui["notice-toggle"].setAttribute("aria-expanded", String(show));
    ui["notice-backdrop"].hidden = !show || !matchMedia("(max-width: 700px)").matches;
    if (show) { state.unread = false; ui["notice-unread"].hidden = true; }
  }

  function updateRuntime() {
    const snapshot = state.snapshot;
    const phase = snapshot?.phase || "idle";
    ui["phase-label"].textContent = state.ready ? (phaseNames[phase] || phase) : "等待连接";
    ui["phase-dot"].className = `status-dot ${state.ready ? (["preparing", "llm", "tool", "sending"].includes(phase) ? "busy" : phase === "error" ? "error" : "online") : ""}`;
    ui["tool-label"].textContent = phase === "tool" ? snapshot.tool_name || "" : "";
    const startTime = Date.parse(snapshot?.turn_started_at || "");
    const finishTime = Date.parse(snapshot?.finished_at || "");
    if (startTime > 0) {
      const seconds = Math.max(0, Math.floor(((finishTime > 0 ? finishTime : Date.now()) - startTime) / 1000));
      ui.elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    } else ui.elapsed.textContent = "";
    const usage = snapshot?.usage;
    const parts = [];
    if (usage) {
      parts.push(`tokens ${usage.total_tokens == null ? "—" : Number(usage.total_tokens).toLocaleString()}`);
      if (usage.cache_hit_tokens != null) parts.push(`cache ${Number(usage.cache_hit_tokens).toLocaleString()}`);
    }
    ui.usage.textContent = parts.join(" · ");
    const model = [snapshot?.provider, snapshot?.model].filter(Boolean).join("/");
    ui["model-label"].textContent = model || "选择模型";
    ui["model-button"].title = model || "选择当前模式的模型";
  }

  function updateControls() {
    ui["message-input"].disabled = !state.ready;
    ui["attach-button"].disabled = !state.ready;
    ui["model-button"].disabled = !state.ready;
    const uploading = state.draftFiles.some(file => file.status !== "ready");
    ui["send-button"].disabled = !state.ready || uploading || (!ui["message-input"].value.trim() && !state.draftFiles.length);
    ui["draft-status"].textContent = uploading ? "附件就绪后即可发送" : state.draftFiles.length ? `${state.draftFiles.length} 个附件` : "让ElBot感知一切";
    ui["disconnect-button"].hidden = !state.credentials;
  }

  function setConnection(label, kind = "") {
    ui["connection-label"].textContent = label;
    ui["connection-dot"].className = `status-dot ${kind}`;
    updateControls();
    updateRuntime();
  }

  function clearCompletions() {
    for (const entry of state.completions.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("连接已断开"));
    }
    state.completions.clear();
    hideCompletion();
  }

  function invalidateConnection() {
    state.ready = false;
    state.snapshot = null;
    state.mediaToken = "";
    state.http.abort();
    clearCompletions();
    hideModels();
    for (const view of state.streams.values()) {
      view.data = { ...view.data, committed: true, reasoningDone: true, error: "连接中断，已保留收到的内容" };
      scheduleRender(view);
    }
    state.streams.clear();
    for (const item of state.draftFiles) {
      item.xhr?.abort();
      item.media = null;
      item.status = "waiting";
      item.progress = 0;
    }
    for (const item of state.fileItems) renderFileCard(item);
    updateControls();
  }

  function connect(credentials) {
    clearTimeout(state.reconnectTimer);
    invalidateConnection();
    state.generation++;
    const generation = state.generation;
    state.ws?.close();
    state.credentials = credentials;
    state.http = new AbortController();
    setConnection("连接中", "busy");
    ui["login-submit"].disabled = true;
    const address = new URL("/cli/v1/ws", location.href);
    address.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(address);
    state.ws = socket;
    let authenticated = false;
    let rejected = false;
    const timeout = setTimeout(() => socket.close(), 12000);
    socket.addEventListener("open", () => {
      if (generation !== state.generation) return;
      socket.send(JSON.stringify({ type: "hello", client_id: credentials.clientID, token: credentials.token }));
    });
    socket.addEventListener("message", event => {
      if (generation !== state.generation) return;
      const message = JSON.parse(event.data);
      if (message.type === "hello_ok") {
        clearTimeout(timeout);
        authenticated = true;
        state.ready = true;
        state.mediaToken = message.media_token;
        state.reconnectAttempt = 0;
        ui["login-submit"].disabled = false;
        ui["login-error"].hidden = true;
        ui["login-dialog"].close();
        ui["client-label"].textContent = credentials.clientID;
        setConnection("已连接", "online");
        addNotice("INFO", `已连接 · ${credentials.clientID}`);
        for (const file of state.draftFiles) uploadFile(file);
        ui["message-input"].focus();
      } else if (!authenticated && message.type === "error") {
        rejected = true;
        state.credentials = null;
        ui["login-error"].textContent = "认证失败，请检查 Client ID 和 Token。";
        ui["login-error"].hidden = false;
        showLogin();
        socket.close();
      } else if (authenticated) handleMessage(message);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      if (generation !== state.generation) return;
      invalidateConnection();
      ui["login-submit"].disabled = false;
      if (!state.credentials || rejected) { setConnection("未连接"); return; }
      const wait = Math.min(1000 * 2 ** state.reconnectAttempt++, 10000);
      setConnection("重新连接中", "busy");
      if (authenticated || state.reconnectAttempt === 1) addNotice("WARN", "连接已断开，正在重新连接；已发送的消息不会自动重发。");
      if (ui["login-dialog"].open) {
        ui["login-error"].textContent = "暂时无法连接，正在重试。请确认服务地址和远程服务已启用。";
        ui["login-error"].hidden = false;
      }
      state.reconnectTimer = setTimeout(() => connect(state.credentials), wait);
    });
  }

  function handleMessage(message) {
    switch (message.type) {
      case "chat": if (message.text) newMessage("assistant", { text: message.text }); break;
      case "stream": handleStream(message); break;
      case "notice": addNotice(message.level || "INFO", message.text || ""); break;
      case "status": state.snapshot = message.snapshot; updateRuntime(); break;
      case "attachment": {
        const follow = nearBottom();
        const item = makeFileItem(null, message.attachment);
        const view = newMessage("assistant", { text: "" });
        view.files.append(item.card);
        refreshWelcome();
        if (follow) scrollBottom();
        if (previewable(item.media.mime_type)) loadFile(item, true);
        break;
      }
      case "complete_result": settleCompletion(message.id, message.items || []); break;
      case "error": {
        if (state.completions.has(message.id)) { settleCompletion(message.id, null, message.text); break; }
        const input = state.inputs.get(message.id);
        if (input) { input.data.error = message.text || "发送失败"; scheduleRender(input); }
        addNotice("ERROR", message.text || "请求失败");
        break;
      }
    }
  }

  function showLogin() {
    if (!ui["login-dialog"].open) ui["login-dialog"].showModal();
    ui["disconnect-button"].hidden = !state.credentials;
  }

  function disconnect() {
    clearTimeout(state.reconnectTimer);
    state.credentials = null;
    state.generation++;
    state.ws?.close();
    state.ws = null;
    invalidateConnection();
    clearConversation();
    clearNotices();
    state.snapshot = null;
    ui["login-token"].value = "";
    ui["client-label"].textContent = "ElBot";
    ui["login-error"].hidden = true;
    setConnection("未连接");
    showLogin();
  }

  function clearConversation() {
    for (const item of state.fileItems) if (item.blobURL) URL.revokeObjectURL(item.blobURL);
    state.fileItems.clear();
    state.draftFiles = [];
    state.inputs.clear();
    ui.messages.replaceChildren();
    ui["message-input"].value = "";
    renderDraftFiles();
    refreshWelcome();
  }

  function sendPayload(text, files = [], quiet = false) {
    if (!state.ready) { showLogin(); return false; }
    const id = `m-${++state.sequence}`;
    try { state.ws.send(JSON.stringify({ type: "input", id, text, file_ids: files.map(file => file.media.id) })); }
    catch { addNotice("ERROR", "消息尚未发送，请等待连接恢复。"); return false; }
    if (!quiet) {
      const view = newMessage("user", { text });
      for (const file of files) {
        file.draft = false;
        file.local = null;
        renderFileCard(file);
        view.files.append(file.card);
      }
      state.inputs.set(id, view);
      refreshWelcome();
      scrollBottom();
    }
    return true;
  }

  function sendCommand(command, quiet = true) {
    return sendPayload(command, [], quiet);
  }

  function submitInput() {
    const text = ui["message-input"].value;
    if ((!text.trim() && !state.draftFiles.length) || state.draftFiles.some(file => file.status !== "ready")) return;
    if (!sendPayload(text, state.draftFiles)) return;
    state.draftFiles = [];
    ui["message-input"].value = "";
    resizeInput();
    hideCompletion();
    renderDraftFiles();
    updateControls();
  }

  function requestCompletion(text, cursor) {
    if (!state.ready) return Promise.reject(new Error("请先连接 ElBot"));
    const id = `c-${++state.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.completions.delete(id); reject(new Error("补全请求超时")); }, 5000);
      state.completions.set(id, { resolve, reject, timer });
      state.ws.send(JSON.stringify({ type: "complete", id, text, cursor }));
    });
  }

  function settleCompletion(id, items, error) {
    const pending = state.completions.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.completions.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(items);
  }

  function hideCompletion() {
    state.completion = null;
    ui["completion-menu"].hidden = true;
    ui["completion-menu"].replaceChildren();
    ui["message-input"].removeAttribute("aria-activedescendant");
  }

  function applySelectedCompletion() {
    const current = state.completion;
    const applied = applyCompletion(current.base, current.items[current.index]);
    ui["message-input"].value = applied.text;
    ui["message-input"].setSelectionRange(applied.cursor, applied.cursor);
    resizeInput();
    renderCompletion();
    updateControls();
  }

  function renderCompletion() {
    const current = state.completion;
    ui["completion-menu"].replaceChildren();
    current.items.forEach((item, index) => {
      const button = element("button", `completion-option${index === current.index ? " selected" : ""}`);
      button.type = "button";
      button.id = `completion-option-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === current.index));
      button.append(element("span", "", item.Label || item.Text));
      if (item.Description) button.append(element("small", "", item.Description));
      button.addEventListener("pointerdown", event => event.preventDefault());
      button.addEventListener("click", () => { current.index = index; applySelectedCompletion(); hideCompletion(); ui["message-input"].focus(); });
      ui["completion-menu"].append(button);
    });
    ui["completion-menu"].hidden = false;
    ui["message-input"].setAttribute("aria-activedescendant", `completion-option-${current.index}`);
    ui["completion-menu"].children[current.index]?.scrollIntoView({ block: "nearest" });
  }

  async function completeInput(delta) {
    if (state.completion) {
      state.completion.index = (state.completion.index + delta + state.completion.items.length) % state.completion.items.length;
      applySelectedCompletion();
      return;
    }
    const base = ui["message-input"].value;
    const cursor = ui["message-input"].selectionStart;
    const local = fileCompletions(base, cursor, state.draftFiles.map(file => file.media?.name || file.local.name));
    try {
      const items = local.length ? local : await requestCompletion(base, byteOffset(base, cursor));
      if (base !== ui["message-input"].value || cursor !== ui["message-input"].selectionStart || !items.length) return;
      state.completion = { base, items, index: delta < 0 ? items.length - 1 : 0 };
      applySelectedCompletion();
      if (items.length === 1) hideCompletion();
    } catch (error) { if (state.ready) addNotice("WARN", error.message); }
  }

  function hideModels() {
    ui["model-popover"].hidden = true;
    ui["model-button"].setAttribute("aria-expanded", "false");
    state.modelQuery++;
    clearTimeout(modelTimer);
  }

  async function searchModels() {
    const query = ++state.modelQuery;
    ui["model-list"].replaceChildren(element("div", "model-empty", "正在获取模型…"));
    const text = `/model ${ui["model-search"].value}`;
    try {
      const items = await requestCompletion(text, byteOffset(text, text.length));
      if (query !== state.modelQuery || ui["model-popover"].hidden) return;
      ui["model-list"].replaceChildren();
      const current = [state.snapshot?.provider, state.snapshot?.model].filter(Boolean).join("/");
      for (const item of items.filter(item => item.Kind === "model")) {
        const button = element("button", `model-option${current === item.Text ? " current" : ""}`);
        button.type = "button";
        const label = element("span", "", item.Label || item.Text);
        label.append(element("small", "", item.Description || ""));
        button.append(label, element("span", "", current === item.Text ? "✓" : ""));
        button.addEventListener("click", () => {
          if (sendCommand(`/model ${item.Text}`)) {
            addNotice("INFO", `已请求切换模型 · ${item.Text}\n切换结果见服务端通知，模型显示随运行状态更新。`);
            hideModels();
            ui["message-input"].focus();
          }
        });
        ui["model-list"].append(button);
      }
      if (!ui["model-list"].childElementCount) ui["model-list"].append(element("div", "model-empty", "没有可选模型"));
    } catch (error) {
      if (query === state.modelQuery) ui["model-list"].replaceChildren(element("div", "model-empty", error.message));
    }
  }

  function makeFileItem(local, media = null) {
    const item = { local, media, generation: state.generation, draft: !!local, status: media ? "ready" : "waiting",
      progress: 0, xhr: null, blobURL: null, loading: false, error: "", card: element("div", "file-card") };
    state.fileItems.add(item);
    renderFileCard(item);
    return item;
  }

  function previewable(mime) {
    return /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(mime);
  }

  function renderFileCard(item) {
    const follow = nearBottom();
    const name = item.media?.name || item.local?.name || "文件";
    const size = item.media?.size ?? item.local?.size ?? 0;
    const current = item.generation === state.generation && state.ready;
    item.card.replaceChildren();
    if (item.blobURL && previewable(item.media?.mime_type)) {
      const image = document.createElement("img");
      image.className = "file-preview";
      image.src = item.blobURL;
      image.alt = name;
      item.card.append(image);
      image.addEventListener("load", () => { if (follow) scrollBottom(); }, { once: true });
    }
    const main = element("div", "file-card-main");
    const details = element("div", "file-details");
    const nameLabel = element("span", "file-name", name);
    nameLabel.title = name;
    let label = formatBytes(size);
    if (item.draft) {
      if (item.status === "uploading") label += ` · 上传 ${item.progress}%`;
      else if (item.status === "waiting") label += " · 等待连接";
      else if (item.status === "error") label += ` · ${item.error}`;
    } else if (!current && !item.blobURL) label += " · 当前连接附件已失效";
    details.append(nameLabel, element("span", "file-meta", label));
    const buttons = element("div", "file-buttons");
    if (item.draft) {
      if (item.status === "error") {
        const retry = element("button", "file-retry", "重试");
        retry.type = "button";
        retry.disabled = !state.ready;
        retry.addEventListener("click", () => uploadFile(item));
        buttons.append(retry);
      }
      buttons.append(iconButton("close", "移除附件", () => removeDraftFile(item)));
    } else {
      const download = iconButton("download", item.loading ? "正在获取附件" : "下载附件", () => loadFile(item, false));
      download.disabled = item.loading || (!current && !item.blobURL);
      buttons.append(download);
    }
    main.append(icon("file"), details, buttons);
    item.card.append(main);
    if (item.draft && item.status === "uploading") {
      const progress = element("div", "file-progress");
      const bar = element("span");
      bar.style.width = `${item.progress}%`;
      progress.append(bar);
      item.card.append(progress);
    }
  }

  function renderDraftFiles() {
    ui["draft-files"].replaceChildren(...state.draftFiles.map(item => item.card));
    ui["draft-files"].hidden = !state.draftFiles.length;
    updateControls();
  }

  function addFiles(files) {
    if (!state.ready) { showLogin(); return; }
    for (const file of files) {
      const item = makeFileItem(file);
      state.draftFiles.push(item);
      uploadFile(item);
    }
    renderDraftFiles();
  }

  function uploadFile(item) {
    if (!state.ready || !item.local) return;
    const generation = state.generation;
    item.generation = generation;
    item.status = "uploading";
    item.error = "";
    item.progress = 0;
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("POST", "/cli/v1/files");
    xhr.setRequestHeader("Authorization", `Bearer ${state.mediaToken}`);
    xhr.timeout = 120000;
    xhr.responseType = "json";
    const update = () => { renderFileCard(item); updateControls(); };
    const failed = text => {
      if (generation !== state.generation || !state.fileItems.has(item)) return;
      item.status = state.ready ? "error" : "waiting";
      item.error = text;
      item.xhr = null;
      update();
    };
    xhr.upload.addEventListener("progress", event => {
      if (generation !== state.generation) return;
      item.progress = event.lengthComputable ? Math.round(100 * event.loaded / event.total) : 0;
      update();
    });
    xhr.addEventListener("load", () => {
      if (generation !== state.generation || !state.fileItems.has(item)) return;
      if (xhr.status !== 201) { failed(xhr.status === 401 ? "连接已失效" : "上传失败"); return; }
      item.media = xhr.response;
      item.status = "ready";
      item.xhr = null;
      update();
    });
    xhr.addEventListener("error", () => failed("网络错误"));
    xhr.addEventListener("timeout", () => failed("上传超时"));
    xhr.addEventListener("abort", () => failed("上传已取消"));
    const data = new FormData();
    data.append("file", item.local);
    xhr.send(data);
    update();
  }

  function removeDraftFile(item) {
    state.draftFiles = state.draftFiles.filter(file => file !== item);
    state.fileItems.delete(item);
    item.xhr?.abort();
    if (item.blobURL) URL.revokeObjectURL(item.blobURL);
    if (item.media && item.generation === state.generation && state.ready) {
      fetch(`/cli/v1/files/${encodeURIComponent(item.media.id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${state.mediaToken}` }, signal: state.http.signal,
      }).catch(() => {}); // 断连时服务端也会释放该连接的附件授权。
    }
    hideCompletion();
    renderDraftFiles();
  }

  async function loadFile(item, preview) {
    if (item.loading) return;
    const generation = state.generation;
    item.loading = true;
    renderFileCard(item);
    try {
      if (!item.blobURL) {
        const response = await fetch(`/cli/v1/files/${encodeURIComponent(item.media.id)}`, {
          headers: { Authorization: `Bearer ${state.mediaToken}` }, signal: state.http.signal,
        });
        if (!response.ok) throw new Error(response.status === 404 ? "附件已失效" : "无法获取附件");
        const blob = await response.blob();
        if (generation !== state.generation || !state.fileItems.has(item)) return;
        item.blobURL = URL.createObjectURL(blob);
      }
      if (!preview) {
        const link = document.createElement("a");
        link.href = item.blobURL;
        link.download = item.media.name;
        document.body.append(link);
        link.click();
        link.remove();
      }
    } catch (error) {
      if (error.name !== "AbortError" && generation === state.generation) addNotice("ERROR", error.message);
    } finally {
      item.loading = false;
      if (state.fileItems.has(item)) renderFileCard(item);
    }
  }

  function resizeInput() {
    ui["message-input"].style.height = "auto";
    ui["message-input"].style.height = `${Math.min(230, ui["message-input"].scrollHeight)}px`;
  }

  ui["login-form"].addEventListener("submit", event => {
    event.preventDefault();
    const credentials = { clientID: ui["client-id"].value.trim(), token: ui["login-token"].value };
    if (!credentials.clientID || !credentials.token) return;
    if (state.credentials && state.credentials.clientID !== credentials.clientID) clearConversation();
    ui["login-token"].value = "";
    ui["login-error"].hidden = true;
    connect(credentials);
  });
  ui["connection-button"].addEventListener("click", showLogin);
  ui["login-close"].addEventListener("click", () => ui["login-dialog"].close());
  ui["disconnect-button"].addEventListener("click", disconnect);
  ui["composer-form"].addEventListener("submit", event => { event.preventDefault(); submitInput(); });
  ui["message-input"].addEventListener("input", () => { hideCompletion(); resizeInput(); updateControls(); });
  ui["message-input"].addEventListener("click", hideCompletion);
  ui["message-input"].addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Tab") { event.preventDefault(); completeInput(event.shiftKey ? -1 : 1); }
    else if (state.completion && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); completeInput(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Escape") { hideCompletion(); hideModels(); }
    else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (state.completion) hideCompletion();
      else submitInput();
    }
  });
  ui["message-input"].addEventListener("paste", event => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  ui["attach-button"].addEventListener("click", () => ui["file-input"].click());
  ui["file-input"].addEventListener("change", () => { addFiles(Array.from(ui["file-input"].files)); ui["file-input"].value = ""; });
  document.addEventListener("dragenter", event => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth++;
    ui["drop-overlay"].hidden = false;
  });
  document.addEventListener("dragover", event => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); });
  document.addEventListener("dragleave", event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; ui["drop-overlay"].hidden = true; } });
  document.addEventListener("drop", event => {
    event.preventDefault(); dragDepth = 0; ui["drop-overlay"].hidden = true;
    if (event.dataTransfer.files.length) addFiles(Array.from(event.dataTransfer.files));
  });
  ui["model-button"].addEventListener("click", () => {
    if (!ui["model-popover"].hidden) { hideModels(); return; }
    hideCompletion();
    ui["model-popover"].hidden = false;
    ui["model-button"].setAttribute("aria-expanded", "true");
    ui["model-search"].value = "";
    ui["model-search"].focus();
    searchModels();
  });
  ui["model-search"].addEventListener("input", () => { clearTimeout(modelTimer); modelTimer = setTimeout(searchModels, 130); });
  ui["model-search"].addEventListener("keydown", event => {
    if (event.key === "Escape") { hideModels(); ui["model-button"].focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); ui["model-list"].querySelector("button")?.focus(); }
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".model-control")) hideModels();
    if (!event.target.closest("#completion-menu") && event.target !== ui["message-input"]) hideCompletion();
  });
  ui["notice-toggle"].addEventListener("click", () => toggleNotices(ui.workspace.classList.contains("notices-hidden")));
  ui["notice-backdrop"].addEventListener("click", () => toggleNotices(false));
  ui["clear-notices"].addEventListener("click", clearNotices);
  ui["scroll-bottom"].addEventListener("click", scrollBottom);
  ui["chat-scroll"].addEventListener("scroll", () => { ui["scroll-bottom"].hidden = nearBottom(); });
  matchMedia("(max-width: 700px)").addEventListener("change", event => toggleNotices(!event.matches));
  window.addEventListener("pagehide", () => {
    clearTimeout(state.reconnectTimer);
    state.credentials = null;
    state.generation++;
    state.http.abort();
    state.ws?.close();
    for (const item of state.fileItems) { item.xhr?.abort(); if (item.blobURL) URL.revokeObjectURL(item.blobURL); }
  });
  setInterval(updateRuntime, 1000);
  toggleNotices(!matchMedia("(max-width: 700px)").matches);
  updateControls();
  showLogin();
}
