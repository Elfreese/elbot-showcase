// ElBot 的独立网页客户端；登录保留在当前标签页，历史从会话分页读取。
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
  const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
  const state = {
    ws: null, ready: false, generation: 0, mediaToken: "", credentials: null,
    reconnectTimer: null, reconnectAttempt: 0, http: new AbortController(),
    streams: new Map(), inputs: new Map(), completions: new Map(), sequence: 0,
    draftFiles: [], fileItems: new Set(), snapshot: null, completion: null,
    noticeCount: 0, unread: false, modelQuery: 0, currentModel: "",
    statusQuery: null, refreshedTurn: "", statusPhase: "idle", streamPhase: "",
    contextUsage: null, totalTokens: null, cacheUsage: null,
    messages: [], storageWarned: false, commands: new Map(),
    sessionID: "", home: true, homeReady: false, opened: false, navigating: false, account: "",
    sessionPage: null, sessionQuery: "", listVersion: 0, listing: false,
    viewVersion: 0, historyPage: 0, historyNext: false, historyLoading: false, messageIDs: new Set(),
  };
  const phaseNames = { idle: "空闲", await_append_confirm: "等待追加确认", await_risk_confirm: "等待风险确认", preparing: "准备中", llm: "生成中", tool: "工具执行中", sending: "发送中", stopping: "停止中", done: "已完成", error: "发生错误" };
  const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dirty = new Set();
  let renderFrame = 0;
  let dragDepth = 0;
  let modelTimer;
  const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

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
    ui.welcome.hidden = !state.home || ui.messages.childElementCount > 0;
  }

  function storageWarning() {
    if (state.storageWarned) return;
    state.storageWarned = true;
    addNotice("WARN", "登录信息无法保存在当前标签页，刷新后需要重新登录。");
  }

  function saveCredentials(credentials) {
    try {
      if (credentials) sessionStorage.setItem("elbot.credentials", JSON.stringify(credentials));
      else sessionStorage.removeItem("elbot.credentials");
    } catch { storageWarning(); }
  }

  function readCredentials() {
    try {
      const credentials = JSON.parse(sessionStorage.getItem("elbot.credentials"));
      if (credentials == null) return null;
      if (typeof credentials.clientID !== "string" || !credentials.clientID || typeof credentials.token !== "string" || !credentials.token) {
        throw new Error("Invalid saved credentials");
      }
      return credentials;
    } catch {
      saveCredentials(null);
      storageWarning();
      return null;
    }
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

  function newMessage(role, data = {}, createdAt = new Date().toISOString()) {
    const follow = nearBottom();
    const node = element("article", `message ${role}`);
    const header = element("div", "message-header");
    if (role === "assistant") {
      const avatar = element("span", "message-avatar");
      const image = document.createElement("img");
      image.src = "assets/elbot-logo.svg";
      image.alt = "";
      avatar.append(image);
      header.append(avatar);
    }
    const time = element("time", "message-time", timeFormat.format(new Date(createdAt)));
    time.dateTime = createdAt;
    const body = element("div", "message-body");
    const reasoning = element("details", "reasoning");
    reasoning.open = true;
    const reasoningSummary = element("summary", "", "思考过程");
    const reasoningContent = element("div", "reasoning-content");
    reasoning.append(reasoningSummary, reasoningContent);
    reasoning.hidden = true;
    const files = element("div", "message-files");
    const actions = element("div", "message-actions");
    const status = element("div", "message-state");
    const view = { node, body, reasoning, reasoningSummary, reasoningContent, files, actions, status, role, createdAt, attachments: [],
      data: { text: "", reasoning: "", actions: [], committed: true, ...data }, renderedText: null };
    const copy = iconButton("copy", "复制消息", () => copyText(view.data.statusData ? view.body.innerText : view.data.text, copy));
    view.copy = copy;
    copy.classList.add("message-copy");
    header.append(element("span", "message-author", role === "assistant" ? "ElBot" : state.account), copy, time);
    node.append(header, reasoning, body, files, actions, status);
    state.messages.push(view);
    ui.messages.append(node);
    renderMessage(view);
    refreshWelcome();
    if (follow) scrollBottom();
    return view;
  }

  function renderMessage(view) {
    const data = view.data;
    if (view.renderedText !== data.text) {
      if (data.statusData) view.body.replaceChildren(renderStatusCard(data.statusData, data.statusError));
      else if (view.role === "assistant") renderMarkdown(view.body, data.text);
      else view.body.textContent = data.text;
      view.renderedText = data.text;
    }
    view.body.hidden = !data.text;
    view.copy.hidden = !data.text;
    view.reasoning.hidden = !data.reasoning;
    view.reasoningContent.textContent = data.reasoning;
    view.reasoningSummary.textContent = data.reasoningDone ? "思考过程" : "正在思考";
    view.status.textContent = data.error || (!data.committed ? (data.finished ? "正在整理回复…" : "生成中…") : "");
    view.status.classList.toggle("error", !!data.error);
    view.status.hidden = !view.status.textContent;
    renderActions(view);
  }

  function updateActionControls(view) {
    for (const control of view.actions.querySelectorAll("button, textarea")) {
      control.disabled = !state.ready || state.navigating || !!view.actionBusy || !!view.actionResolved;
    }
  }

  function renderActions(view) {
    const key = JSON.stringify(view.data.actions);
    // 正文增量不重建操作区，保留焦点、拒绝原因草稿与展开状态。
    if (view.actionsKey === key) { updateActionControls(view); return; }
    view.actionsKey = key;
    view.actions.replaceChildren();
    for (const action of view.data.actions) {
      const button = element("button", "message-action", action.label);
      button.type = "button";
      button.addEventListener("click", () => runAction(view, action));
      if (action.id !== "reject") { view.actions.append(button); continue; }
      const control = element("div", "reject-control");
      const buttons = element("div", "reject-buttons");
      const toggle = element("button", "message-action reject-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-label", "填写拒绝原因");
      toggle.setAttribute("aria-expanded", "false");
      toggle.append(icon("chevron"));
      const form = element("form", "reject-form");
      form.hidden = true;
      const label = element("label", "", "拒绝原因（可选）");
      const reason = document.createElement("textarea");
      reason.rows = 3;
      reason.placeholder = "说明原因，帮助 ElBot 调整后续处理";
      const reasonID = `reject-reason-${++state.sequence}`;
      reason.id = reasonID;
      label.htmlFor = reasonID;
      toggle.setAttribute("aria-controls", `${reasonID}-form`);
      form.id = `${reasonID}-form`;
      const submit = element("button", "message-action", "拒绝并提交");
      submit.type = "submit";
      form.append(label, reason, submit);
      form.addEventListener("submit", event => { event.preventDefault(); runAction(view, action, reason.value); });
      toggle.addEventListener("click", () => {
        form.hidden = !form.hidden;
        toggle.setAttribute("aria-expanded", String(!form.hidden));
        if (!form.hidden) reason.focus();
      });
      buttons.append(button, toggle);
      control.append(buttons, form);
      view.actions.append(control);
    }
    updateActionControls(view);
  }

  async function runAction(view, action, reason = "") {
    if (!state.ready || state.navigating || view.actionBusy || view.actionResolved) return;
    view.actionBusy = true;
    updateActionControls(view);
    try {
      const command = action.command + (reason.trim() ? ` ${reason.trim()}` : "");
      const response = await requestCommand(command);
      view.actionResolved = !response.error;
      if (view.actionResolved) {
        for (const form of view.actions.querySelectorAll(".reject-form")) form.hidden = true;
        for (const toggle of view.actions.querySelectorAll(".reject-toggle")) toggle.setAttribute("aria-expanded", "false");
      }
      applyCommandState(response.result);
      showCommandResult(response.result, response.error);
      refreshStatus();
    } catch (error) { if (state.ready) addNotice("WARN", error.message); }
    finally { view.actionBusy = false; updateActionControls(view); }
  }

  function applyCommandState(result) {
    if (!result) return;
    const data = result.data;
    if (result.kind === "status") applyStatus(data);
    if (result.kind === "model") {
      if (data.target === "current") {
        state.currentModel = [data.model.provider, data.model.model].filter(Boolean).join("/");
        state.contextUsage = null;
        updateRuntime();
      }
      refreshStatus();
    }
    if (result.kind === "session" && !result.confirmation) {
      if (data.operation === "new" || (!data.current_session_id && state.sessionID)) activateSession(null);
      else if (data.session?.id === data.current_session_id) {
        if (["resume", "fork"].includes(data.operation) || (["chat", "work"].includes(data.operation) && (state.home || data.session.id !== state.sessionID))) {
          activateSession(data.session);
          loadHistory();
        } else if (!state.home && data.session.id === state.sessionID) ui["conversation-heading"].textContent = data.session.title || "未命名会话";
      }
      refreshStatus();
      refreshSessions();
    }
    if (result.kind === "compact") {
      activateSession(data);
      loadHistory();
      refreshStatus();
      refreshSessions();
    }
  }

  function showCommandResult(result, error) {
    if (!result && !error) return;
    if (result?.kind === "status") {
      newMessage("assistant", { text: "会话状态", statusData: result.data, statusError: error });
      return;
    }
    const text = result ? resultMarkdown(result) : "";
    const view = newMessage("assistant", { text: text ?? `暂不支持展示此结果类别：${result.kind}。可展开查看原始数据。`, actions: result?.confirmation?.actions || [], error: error ? `${error.message}\n${error.kind} · ${error.code}` : "" });
    if (text === null) {
      const details = element("details", "result-data");
      details.append(element("summary", "", "原始数据"), element("pre", "", JSON.stringify(result.data, null, 2)));
      view.node.append(details);
    }
  }

  function usagePercentages(usage, contextWindow) {
    return {
      context: usage?.total_tokens != null && contextWindow > 0 ? usage.total_tokens / contextWindow * 100 : null,
      cache: usage?.cache_hit_tokens != null && usage.prompt_tokens > 0 ? usage.cache_hit_tokens / usage.prompt_tokens * 100 : null,
    };
  }

  function renderStatusCard(data, failure) {
    const card = element("section", "status-card");
    card.setAttribute("aria-label", "会话状态");
    const integer = value => value == null ? "—" : value.toLocaleString("zh-CN");
    const percent = value => value == null ? "—" : `${value.toFixed(1)}%`;
    const model = value => [value.provider, value.model].filter(Boolean).join("/") || "—";
    const stamp = value => value ? new Date(value).toLocaleString("zh-CN") : "—";
    const context = data.context;
    const usage = context.usage;
    const ratios = usagePercentages(usage, context.context_window);

    const heading = element("header", "status-card-heading");
    const title = element("div", "status-card-heading-text");
    title.append(element("span", "eyebrow", "会话状态"), element("h3", "status-card-title", data.session ? data.session.title || "未命名会话" : "尚未开始会话"));
    const phase = element("span", "status-card-phase");
    const busy = ["preparing", "llm", "tool", "sending", "stopping", "await_append_confirm", "await_risk_confirm"].includes(data.phase);
    phase.append(element("span", `status-dot ${data.phase === "error" ? "error" : busy ? "busy" : "online"}`), element("span", "", phaseNames[data.phase] || data.phase));
    heading.append(title, phase);
    card.append(heading, element("p", "status-card-model", `${data.mode} · ${model(data.model)}`));

    const metrics = element("div", "status-card-metrics");
    for (const [label, ratio, count] of [
      ["上下文占用", ratios.context, `${integer(usage?.total_tokens)} / ${integer(context.context_window > 0 ? context.context_window : null)} token`],
      ["缓存命中", ratios.cache, `${integer(usage?.cache_hit_tokens)} / ${integer(usage?.prompt_tokens)} 输入 token`],
    ]) {
      const metric = element("div", "status-card-metric");
      const line = element("div", "status-card-metric-heading");
      line.append(element("span", "", label), element("strong", "", percent(ratio)));
      const progress = element("progress", "status-card-progress");
      progress.max = 100;
      progress.hidden = ratio == null;
      if (ratio != null) progress.value = ratio;
      progress.setAttribute("aria-label", label);
      progress.setAttribute("aria-valuetext", percent(ratio));
      metric.append(line, progress, element("span", "status-card-metric-count", count));
      metrics.append(metric);
    }
    card.append(metrics);

    function values(entries, className = "status-card-stats") {
      const list = element("dl", className);
      for (const [label, value] of entries) {
        const item = document.createElement("div");
        item.append(element("dt", "", label), element("dd", "", typeof value === "number" ? integer(value) : value ?? "—"));
        list.append(item);
      }
      return list;
    }

    card.append(values([
      ["输入 token", usage?.prompt_tokens], ["输出 token", usage?.completion_tokens],
      ["总 token", usage?.total_tokens], ["缓存 token", usage?.cache_hit_tokens],
      ["消息数量", data.message_count], ["待处理输入", data.pending_count],
      ["自动压缩", context.compact_enabled ? "开启" : "关闭"], ["压缩阈值", `${context.compact_trigger_ratio * 100}%`],
    ]));

    function details(label, content) {
      const section = element("details", "status-card-details");
      section.append(element("summary", "", label), content);
      card.append(section);
    }

    if (data.session) {
      const session = data.session;
      const entries = [
        ["会话 ID", session.id], ["创建时间", stamp(session.created_at)], ["更新时间", stamp(session.updated_at)],
        ["所属平台", session.platform], ["平台会话", session.chat_id], ["保存状态", session.status],
      ];
      if (session.parent_session_id) entries.push(["父会话", session.parent_session_id]);
      if (session.fork_from_message_id) entries.push(["分支起点", session.fork_from_message_id]);
      if (session.archived_at) entries.push(["归档时间", stamp(session.archived_at)]);
      if (session.pinned_at) entries.push(["置顶时间", stamp(session.pinned_at)]);
      details("会话详情", values(entries, "status-card-detail-values"));
    } else {
      details("默认设置", values([
        ["默认模式", data.default_mode], ["压缩模型", model(data.compact_model)],
        ["所属平台", data.platform], ["平台会话", data.chat_id],
      ], "status-card-detail-values"));
    }

    if (data.requests?.length) {
      const requests = element("div", "status-card-requests");
      for (const request of data.requests) {
        const item = element("section", "status-card-request");
        item.append(element("strong", "", request.label || request.kind), values([
          ["请求 ID", request.id], ["类型", request.kind], ["开始时间", stamp(request.started_at)],
          ["状态", request.stopping ? "正在停止" : "执行中"],
        ], "status-card-detail-values"));
        requests.append(item);
      }
      details(`当前请求 · ${integer(data.requests.length)}`, requests);
    }

    for (const [label, counts] of [["会话工具调用", data.tool_usage], ["本轮工具调用", data.turn_tool_usage]]) {
      const entries = Object.entries(counts || {});
      if (entries.length) details(label, values(entries, "status-card-tool-list"));
    }

    for (const [role, label, content] of [
      ["user", "最近用户消息", data.last_user_content],
      ["assistant", "最近助手消息", data.last_assistant_content],
    ]) {
      if (!content) continue;
      const preview = element("div", `status-card-preview ${role}`);
      preview.append(element("strong", "status-card-preview-label", role === "user" ? `用户 · ${state.account}` : "助手 · ElBot"));
      const body = element("div", "status-card-preview-content");
      if (role === "assistant") renderMarkdown(body, content);
      else body.textContent = content;
      preview.append(body);
      details(label, preview);
    }

    const failures = [...(data.errors || [])];
    if (failure) failures.push({ id: "status", error: failure });
    if (failures.length) {
      const errors = element("div", "status-card-errors");
      for (const item of failures) {
        errors.append(element("p", "", `${item.id}：${item.error.message}`), element("small", "", `${item.error.kind} · ${item.error.code}`));
      }
      card.append(errors);
    }
    return card;
  }


  function resultMarkdown(result) {
    const data = result.data;
    const items = data?.items || [];
    const md = value => String(value ?? "—").replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&").replace(/\r?\n/g, "<br>");
    const table = (headers, rows) => rows.length ? [headers, headers.map(() => "---"), ...rows.map(row => row.map(md))].map(row => `| ${row.join(" | ")} |`).join("\n") : "暂无记录。";
    const fields = rows => table(["项目", "值"], rows);
    const modelName = model => [model.provider, model.model].filter(Boolean).join("/") || "—";
    const stamp = value => value ? new Date(value).toLocaleString("zh-CN") : "—";
    const fence = value => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const marker = "`".repeat(Math.max(3, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
      return `${marker}\n${text}\n${marker}`;
    };
    const usageRow = row => [row.key, row.calls, row.prompt_tokens, row.completion_tokens, row.total_tokens, row.cache_hit_tokens, row.elapsed_ms].map(value => value === -1 ? "溢出" : value);
    const itemErrors = errors => (errors || []).map(item => `- ${md(item.id)}：${md(item.error.message)}（${md(item.error.kind)} / ${md(item.error.code)}）`).join("\n");
    const messages = rows => rows.map(row => `### ${row.role === "user" ? md(state.account) : "ElBot"} · ${md(stamp(row.created_at))}\n\n${row.content}${row.attachments?.length ? `\n\n附件：${row.attachments.map(file => md(file.name)).join("、")}` : ""}`).join("\n\n");
    switch (result.kind) {
      case "text": return data.content;
      case "session": {
        if (result.confirmation) return data.prompt;
        const operations = { new: "已开始新对话", resume: "已恢复会话", fork: "已创建分支", chat: "已切换对话模式", work: "已切换工作模式", archive: "已归档会话", unarchive: "已取消归档", pin: "已置顶会话", unpin: "已取消置顶", rename: "已重命名会话", delete: "已删除会话", clean: "已清理会话" };
        return `${operations[data.operation] || md(data.operation)}${data.unchanged ? "（设置未变）" : ""}${data.session ? `：${md(data.session.title || "未命名会话")}` : ""}${data.affected_count ? `\n\n影响数量：${data.affected_count}` : ""}`;
      }
      case "sessions": return `### 会话 · 第 ${data.page} 页\n\n${table(["名称", "更新时间", "消息数", "ID"], items.map(row => [row.title || "未命名会话", stamp(row.updated_at), row.message_count, row.id]))}`;
      case "messages": return `第 ${data.page} 页 / ${data.total_pages} 页\n\n${messages(items) || "暂无历史消息。"}`;
      case "model": return `已选择模型：${md(modelName(data.model))}（${md(data.target)}）`;
      case "models": return table(["编号", "提供方", "模型", "模式"], items.map(row => [row.index, row.provider, row.model, (row.modes || []).join("、")])) + (data.errors?.length ? `\n\n${itemErrors(data.errors)}` : "");
      case "requests": return table(["ID", "类型", "会话", "说明", "开始时间", "停止中"], items.map(row => [row.id, row.kind, row.session_title || row.session_id, row.label, stamp(row.started_at), row.stopping ? "是" : "否"]));
      case "stop": return `${data.state === "stopping" ? "已接受停止请求，正在退出" : "已停止"}。接受取消 ${data.accepted_count} 个请求。`;
      case "tools": return result.confirmation ? data.prompt : data.operation ? `${md(data.operation)}：${md(data.name)}` : table(["名称", "说明", "来源", "风险", "标签"], items.map(row => [row.name, row.description, row.source, row.risk, (row.tags || []).join("、")]));
      case "rollback": return fields([["撤销编号", data.id], ["文件", data.path], ["结果", data.deleted ? "已删除新建文件" : "已恢复文件"], ["版本", data.revision]]);
      case "rollbacks": return table(["编号", "文件", "新建文件", "编辑时间"], items.map(row => [row.id, row.path, row.created ? "是" : "否", stamp(row.edited_at)]));
      case "logs": return `### ${md(data.title)}\n\n${items.map(row => `**${md(stamp(row.time))} · ${md(row.level)} · ${md(row.module)} · ${md(row.event_name)}**\n\n${fence(row.raw || row.content)}`).join("\n\n") || "暂无日志。"}${data.damaged_count ? `\n\n损坏记录：${data.damaged_count}${data.damaged_lines?.length ? `\n\n${fence(data.damaged_lines.join("\n"))}` : ""}` : ""}`;
      case "usage": return `### 用量统计 · ${md(data.range)}\n\n${table([data.group_by || "分组", "调用", "输入 token", "输出 token", "总 token", "缓存 token", "耗时 ms"], [...items, data.total].map(usageRow))}${data.range_truncated ? "\n\n查询范围超过可用记录，已使用实际范围。" : ""}${data.damaged_count ? `\n\n损坏记录：${data.damaged_count}` : ""}`;
      case "doctor": return `配置：${md(data.config_path)}\n\n${items.length ? table(["级别", "主题", "配置项", "问题"], items.map(row => [row.level, row.topic, (row.field || []).join("."), row.message])) : "未发现配置问题。"}`;
      case "hooks": return (data.operation ? `操作：${md(data.operation)} ${md(data.target)}\n\n` : "") + table(["ID", "名称", "注册点", "优先级", "模式", "状态", "执行中", "等待", "说明"], items.map(row => [row.id, row.name, row.point, row.priority, row.mode, row.status, row.active, row.waiting, row.detail || row.description])) + (data.notices?.length ? `\n\n${data.notices.map(md).join("\n\n")}` : "");
      case "compact": return `已压缩并切换到会话：${md(data.title || "未命名会话")}`;
      case "help": return table(["用法", "说明", "别名"], items.map(row => [row.usage, row.description, (row.aliases || []).join("、")])) + (items.length === 1 && items[0].help ? `\n\n${items[0].help}` : "") + (data.help_command ? `\n\n详细帮助：${md(data.help_command)}` : "");
      default: return null;
    }
  }

  function handleStream(message) {
    const type = message.event.type;
    if (type === "reasoning_delta") state.streamPhase = "思考中";
    else if (["text_delta", "reasoning_done"].includes(type)) state.streamPhase = "生成中";
    else if (["finish", "send", "reset"].includes(type)) state.streamPhase = "";
    updateRuntime();
    const key = message.stream_id;
    const existing = state.streams.get(key);
    const data = reduceStream(existing?.data, message.event);
    if (!data) {
      existing?.node.remove();
      state.messages = state.messages.filter(view => view !== existing);
      state.streams.delete(key);
      refreshWelcome();
      return;
    }
    if (data.committed && !data.text && !data.reasoning && !data.actions.length) {
      existing?.node.remove();
      state.messages = state.messages.filter(view => view !== existing);
      state.streams.delete(key);
      refreshWelcome();
      return;
    }
    const view = existing || newMessage("assistant", data);
    view.data = data;
    state.streams.set(key, view);
    scheduleRender(view);
    if (message.event.type === "send") state.streams.delete(key);
    if (message.event.actions?.length) refreshStatus();
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
    if (show && matchMedia("(max-width: 760px)").matches) toggleSessions(false);
    ui.workspace.classList.toggle("notices-hidden", !show);
    ui["notice-toggle"].setAttribute("aria-expanded", String(show));
    ui["notice-backdrop"].hidden = !show || !matchMedia("(max-width: 1000px)").matches;
    if (show) { state.unread = false; ui["notice-unread"].hidden = true; }
  }

  function updateRuntime() {
    const snapshot = state.home ? null : state.snapshot;
    const phase = state.home ? "idle" : state.statusPhase.startsWith("await_") ? state.statusPhase : snapshot?.Phase || state.statusPhase;
    const displayPhase = phase === "done" ? "idle" : phase;
    const busy = ["preparing", "llm", "tool", "sending", "stopping"].includes(displayPhase);
    const label = displayPhase === "llm" && state.streamPhase ? state.streamPhase : phaseNames[displayPhase] || displayPhase;
    ui["phase-label"].textContent = state.ready ? label : "等待连接";
    ui["phase-label"].title = snapshot?.Error || "";
    ui["phase-dot"].className = `status-dot ${state.ready ? (busy ? "busy" : displayPhase === "error" ? "error" : "online") : ""}`;
    ui["tool-label"].textContent = displayPhase === "tool" ? snapshot?.ToolName || "" : "";
    const startTime = Date.parse(snapshot?.TurnStartedAt || "");
    const finishTime = Date.parse(snapshot?.FinishedAt || "");
    if (startTime > 0) {
      const seconds = Math.max(0, Math.floor(((finishTime > 0 ? finishTime : Date.now()) - startTime) / 1000));
      ui.elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    } else ui.elapsed.textContent = "";
    const context = state.home ? null : state.contextUsage;
    const contextText = context ? `上下文 ${context.percent.toFixed(1)}%` : "上下文 —";
    const cacheText = state.home || state.cacheUsage?.percent == null ? "缓存 —" : `缓存 ${state.cacheUsage.percent.toFixed(1)}%`;
    ui.usage.textContent = state.ready ? `${contextText} · ${cacheText}` : "";
    ui.usage.title = state.ready && !state.home ? `token 用量：${state.totalTokens == null ? "—" : state.totalTokens.toLocaleString()}${context ? ` / ${context.window.toLocaleString()}` : ""}；缓存 token：${state.cacheUsage?.tokens == null ? "—" : state.cacheUsage.tokens.toLocaleString()}` : "";
    const model = state.currentModel;
    ui["model-label"].textContent = model ? model.slice(model.indexOf("/") + 1) : state.ready ? "读取模型…" : "未连接";
    ui["model-button"].title = model || "选择当前模式的模型";
  }

  function applyStatus(data) {
    if (state.snapshot?.SessionID !== data.session?.id) state.snapshot = null;
    state.currentModel = [data.model.provider, data.model.model].filter(Boolean).join("/");
    state.statusPhase = data.phase;
    if (!state.home && data.session) {
      const changed = state.sessionID && state.sessionID !== data.session.id;
      if (changed) activateSession(data.session);
      state.sessionID = data.session.id;
      ui["conversation-heading"].textContent = data.session.title || "未命名会话";
      renderSessions();
      if (changed) loadHistory();
    }
    const context = data.context;
    const usage = context.usage;
    const ratios = usagePercentages(usage, context.context_window);
    state.totalTokens = usage?.total_tokens ?? null;
    state.contextUsage = ratios.context == null ? null : {
      tokens: state.totalTokens, window: context.context_window, percent: ratios.context,
    };
    state.cacheUsage = usage ? { tokens: usage.cache_hit_tokens, percent: ratios.cache } : null;
    updateRuntime();
  }

  async function refreshStatus() {
    if (!state.ready) return;
    if (state.statusQuery) { state.statusQuery.again = true; return; }
    const query = { again: false };
    state.statusQuery = query;
    try {
      const response = await requestCommand("/status");
      if (state.statusQuery !== query) return;
      if (response.result?.kind === "status") applyStatus(response.result.data);
      if (response.error) reportError(response.error);
    } catch (error) { if (state.ready && state.statusQuery === query) addNotice("WARN", error.message); }
    finally {
      if (state.statusQuery === query) {
        state.statusQuery = null;
        if (query.again) refreshStatus();
      }
    }
  }

  function updateControls() {
    const disabled = !state.ready || state.navigating;
    ui["message-input"].disabled = disabled;
    ui["attach-button"].disabled = disabled;
    ui["model-button"].disabled = disabled;
    ui["new-session"].disabled = disabled;
    for (const button of ui["session-list"].querySelectorAll("button")) button.disabled = disabled;
    const uploading = state.draftFiles.some(file => file.status !== "ready");
    ui["send-button"].disabled = disabled || uploading || (!ui["message-input"].value.trim() && !state.draftFiles.length);
    ui["disconnect-button"].hidden = !state.credentials;
    ui["session-prev"].disabled = disabled || state.listing || !state.sessionPage?.prev_command;
    ui["session-next"].disabled = disabled || state.listing || !state.sessionPage?.next_command;
    ui["history-more"].disabled = disabled || state.historyLoading;
    for (const view of state.messages) updateActionControls(view);
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
    state.statusQuery = null;
    for (const pending of state.commands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("连接已断开；已发送的操作不会自动重发。"));
    }
    state.commands.clear();
    state.listVersion++;
    state.viewVersion++;
    state.listing = false;
    state.historyLoading = false;
    state.navigating = false;
    state.refreshedTurn = "";
    state.statusPhase = "idle";
    state.streamPhase = "";
    state.contextUsage = null;
    state.totalTokens = null;
    state.cacheUsage = null;
    state.currentModel = "";
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
    if (state.account !== credentials.clientID) {
      clearConversation();
      state.account = credentials.clientID;
      state.home = true;
      state.homeReady = false;
      state.opened = false;
      state.sessionID = "";
      state.sessionPage = null;
      state.sessionQuery = "";
      ui["session-search"].value = "";
      renderSessions();
    }
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
        saveCredentials(credentials);
        ui["client-id"].value = credentials.clientID;
        ui["login-submit"].disabled = false;
        ui["login-error"].hidden = true;
        ui["login-dialog"].close();
        setConnection("已连接", "online");
        addNotice("INFO", `已连接 · ${credentials.clientID}`);
        if (!state.opened) { state.opened = true; changeSession(null, true); }
        else { refreshStatus(); refreshSessions(); }
        for (const file of state.draftFiles) uploadFile(file);
        ui["message-input"].focus();
      } else if (!authenticated && message.type === "error") {
        rejected = true;
        saveCredentials(null);
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
      case "command_result": {
        const { result, error, request_id: id } = message;
        if (settleCommand(id, message)) break;
        applyCommandState(result);
        showCommandResult(result, error);
        state.inputs.delete(id);
        break;
      }
      case "status": {
        const snapshot = message.snapshot;
        if (state.home || (state.sessionID && snapshot.SessionID !== state.sessionID)) break;
        if (!state.sessionID && snapshot.SessionID) { state.sessionID = snapshot.SessionID; renderSessions(); }
        if (state.snapshot && snapshot.SessionID !== state.snapshot.SessionID) state.contextUsage = null;
        if (snapshot.Phase !== "llm" || snapshot.RequestID !== state.snapshot?.RequestID) state.streamPhase = "";
        state.statusPhase = snapshot.Phase;
        state.snapshot = snapshot;
        if (snapshot.Model) state.currentModel = [snapshot.Provider, snapshot.Model].filter(Boolean).join("/");
        const usage = snapshot.Usage;
        if (usage) {
          state.totalTokens = usage.TotalTokens;
          const ratios = usagePercentages({
            total_tokens: usage.TotalTokens, prompt_tokens: usage.PromptTokens, cache_hit_tokens: usage.CacheHitTokens,
          }, state.contextUsage?.window || 0);
          if (ratios.context != null) state.contextUsage = { ...state.contextUsage, tokens: usage.TotalTokens, percent: ratios.context };
          state.cacheUsage = { tokens: usage.CacheHitTokens, percent: ratios.cache };
        }
        updateRuntime();
        if (snapshot.Kind === "turn" && snapshot.RequestID && ["done", "error"].includes(snapshot.Phase) && snapshot.RequestID !== state.refreshedTurn) {
          state.refreshedTurn = snapshot.RequestID;
          refreshStatus();
          refreshSessions();
        }
        break;
      }
      case "attachment": {
        const follow = nearBottom();
        const item = makeFileItem(null, message.attachment);
        const view = newMessage("assistant", { text: "" });
        view.files.append(item.card);
        view.attachments.push(item);
        refreshWelcome();
        if (follow) scrollBottom();
        if (previewable(item.media.mime_type)) loadFile(item, true);
        break;
      }
      case "complete_result": settleCompletion(message.id, message.items || []); break;
      case "error": {
        if (settleCommand(message.id, null, message.text || "请求失败")) break;
        if (state.completions.has(message.id)) { settleCompletion(message.id, null, message.text); break; }
        const input = state.inputs.get(message.id);
        if (input) { input.data.error = message.text || "发送失败"; scheduleRender(input); state.inputs.delete(message.id); }
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
    state.storageWarned = false;
    saveCredentials(null);
    state.account = "";
    state.sessionID = "";
    state.home = true;
    state.homeReady = false;
    state.opened = false;
    state.sessionPage = null;
    renderSessions();
    state.snapshot = null;
    ui["login-token"].value = "";
    ui["login-error"].hidden = true;
    setConnection("未连接");
    showLogin();
  }

  function clearConversation(preserveDraft = false) {
    state.messages = [];
    state.streams.clear();
    dirty.clear();
    for (const item of state.fileItems) {
      if (preserveDraft && item.draft) continue;
      item.xhr?.abort();
      if (item.blobURL) URL.revokeObjectURL(item.blobURL);
      state.fileItems.delete(item);
    }
    if (!preserveDraft) state.draftFiles = [];
    state.inputs.clear();
    state.messageIDs.clear();
    state.historyPage = 0;
    state.historyNext = false;
    state.historyLoading = false;
    ui["history-more"].hidden = true;
    ui.messages.replaceChildren();
    if (!preserveDraft) ui["message-input"].value = "";
    resizeInput();
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
        view.attachments.push(file);
      }
      state.inputs.set(id, view);
      refreshWelcome();
      scrollBottom();
    }
    return id;
  }

  function sendCommand(command, quiet = true) {
    return sendPayload(command, [], quiet);
  }

  // 关联输入 ID；等待超时只结束客户端等待，不宣称后端已取消。
  function requestCommand(command) {
    const id = sendCommand(command);
    if (!id) return Promise.reject(new Error("命令尚未发送，请等待连接恢复。"));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, expired: false, timer: null };
      pending.timer = setTimeout(() => {
        pending.expired = true;
        reject(new Error("等待命令结果超时；后端操作可能仍在执行，不会自动重发。"));
      }, 15000);
      state.commands.set(id, pending);
    });
  }

  function settleCommand(id, response, transportError = "") {
    const pending = state.commands.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    state.commands.delete(id);
    if (!pending.expired) {
      if (transportError) pending.reject(new Error(transportError));
      else pending.resolve(response);
    }
    return true;
  }

  function reportError(error) {
    const names = { input: "命令错误", rejected: "操作未接受", internal: "内部错误", interrupted: "操作中断" };
    addNotice(error.kind === "internal" ? "ERROR" : "WARN", `${names[error.kind] || error.kind} · ${error.code}\n${error.message}`);
  }

  function toggleSessions(show) {
    if (show) toggleNotices(false);
    ui.workspace.classList.toggle("sessions-open", show);
    ui["session-toggle"].setAttribute("aria-expanded", String(show));
    ui["session-backdrop"].hidden = !show || !matchMedia("(max-width: 760px)").matches;
  }

  function renderSessions() {
    ui["session-list"].replaceChildren();
    for (const row of state.sessionPage?.items || []) {
      const button = element("button", `session-item${!state.home && row.id === state.sessionID ? " current" : ""}`);
      button.type = "button";
      button.title = row.title || "未命名会话";
      if (!state.home && row.id === state.sessionID) button.setAttribute("aria-current", "true");
      button.append(element("span", "session-title", row.title || "未命名会话"), element("time", "session-date", dateFormat.format(new Date(row.updated_at))));
      button.addEventListener("click", () => changeSession(row.id));
      ui["session-list"].append(button);
    }
    ui["session-page"].textContent = state.sessionPage?.page || 1;
    updateControls();
  }

  async function refreshSessions(command = `/sessions 1 ${state.sessionQuery}`.trimEnd()) {
    if (!state.ready) return;
    const version = ++state.listVersion;
    state.listing = true;
    ui["session-feedback"].textContent = "正在读取会话…";
    ui["session-feedback"].classList.remove("error");
    updateControls();
    try {
      const response = await requestCommand(command);
      if (version !== state.listVersion) return;
      if (response.result?.kind === "sessions") {
        state.sessionPage = response.result.data;
        renderSessions();
        ui["session-feedback"].textContent = state.sessionPage.items?.length ? "" : state.sessionQuery ? "没有匹配的会话" : "还没有会话，开始聊聊吧。";
      }
      if (response.error) {
        ui["session-feedback"].textContent = response.error.message;
        ui["session-feedback"].classList.add("error");
        reportError(response.error);
      }
    } catch (error) {
      if (version === state.listVersion) {
        ui["session-feedback"].textContent = error.message;
        ui["session-feedback"].classList.add("error");
      }
    } finally {
      if (version === state.listVersion) { state.listing = false; updateControls(); }
    }
  }

  function activateSession(session, preserveDraft = false) {
    state.viewVersion++;
    state.statusQuery = null;
    state.sessionID = session?.id || "";
    state.home = !session;
    state.homeReady = !session;
    state.snapshot = null;
    state.statusPhase = "idle";
    state.streamPhase = "";
    state.contextUsage = null;
    state.totalTokens = null;
    state.cacheUsage = null;
    clearConversation(preserveDraft);
    ui["conversation-heading"].textContent = session ? session.title || "未命名会话" : "新对话";
    renderSessions();
    updateRuntime();
    scrollBottom();
  }

  async function changeSession(id, preserveDraft = false) {
    if (!state.ready || state.navigating) return false;
    state.navigating = true;
    updateControls();
    const generation = state.generation;
    try {
      const response = await requestCommand(id ? `/resume ${id}` : "/new");
      if (generation !== state.generation) return false;
      const result = response.result;
      const changed = result?.kind === "session" && !result.confirmation;
      if (changed) {
        activateSession(result.data.session, preserveDraft);
        toggleSessions(false);
        if (!state.home) await loadHistory();
      }
      if (response.error) reportError(response.error);
      return changed;
    } catch (error) {
      if (generation === state.generation && state.ready) addNotice("ERROR", error.message);
      return false;
    } finally {
      if (generation === state.generation) {
        state.navigating = false;
        updateControls();
        refreshStatus();
        refreshSessions();
        if (state.ready) ui["message-input"].focus();
      }
    }
  }

  async function loadHistory() {
    if (!state.ready || !state.sessionID || state.historyLoading || (state.historyPage > 0 && !state.historyNext)) return;
    const version = state.viewVersion;
    const sessionID = state.sessionID;
    const page = state.historyPage + 1;
    state.historyLoading = true;
    ui["history-more"].hidden = false;
    ui["history-more"].disabled = true;
    ui["history-more"].textContent = "正在读取历史…";
    try {
      const response = await requestCommand(`/messages ${page}`);
      if (version !== state.viewVersion) return;
      if (response.result?.kind === "messages" && response.result.data.session_id === sessionID) {
        const data = response.result.data;
        const scroll = ui["chat-scroll"];
        const oldHeight = scroll.scrollHeight;
        const oldTop = scroll.scrollTop;
        const previous = state.messages.slice();
        const added = [];
        const nodes = document.createDocumentFragment();
        for (const row of data.items || []) {
          if (state.messageIDs.has(row.id)) continue;
          state.messageIDs.add(row.id);
          const view = newMessage(row.role, { text: row.content }, row.created_at);
          for (const file of row.attachments || []) {
            const card = element("div", "file-card");
            const main = element("div", "file-card-main");
            const details = element("div", "file-details");
            details.append(element("span", "file-name", file.name), element("span", "file-meta", "历史附件"));
            main.append(icon("file"), details);
            card.append(main);
            view.files.append(card);
          }
          added.push(view);
          nodes.append(view.node);
        }
        ui.messages.prepend(nodes);
        state.messages = added.concat(previous);
        state.historyPage = data.page;
        state.historyNext = data.has_next;
        ui["history-more"].hidden = !data.has_next;
        ui["history-more"].textContent = "加载更早消息";
        if (page === 1) scrollBottom();
        else scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
      }
      if (response.error) {
        reportError(response.error);
        ui["history-more"].textContent = "读取失败，点击重试";
      }
    } catch (error) {
      if (version === state.viewVersion) {
        ui["history-more"].textContent = "读取失败，点击重试";
        if (state.ready) addNotice("WARN", error.message);
      }
    } finally {
      if (version === state.viewVersion) {
        state.historyLoading = false;
        ui["history-more"].disabled = !state.ready;
      }
    }
  }

  async function submitInput() {
    if (state.navigating) return;
    const text = ui["message-input"].value;
    const wasHome = state.home;
    if ((!text.trim() && !state.draftFiles.length) || state.draftFiles.some(file => file.status !== "ready")) return;
    if (state.home && !text.trimStart().startsWith("/")) {
      if (!state.homeReady && !await changeSession(null, true)) return;
      state.home = false;
      refreshWelcome();
    }
    if (!sendPayload(text, state.draftFiles)) { state.home = wasHome; refreshWelcome(); return; }
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
      const current = state.currentModel;
      for (const item of items.filter(item => item.Kind === "model")) {
        const button = element("button", `model-option${current === item.Text ? " current" : ""}`);
        button.type = "button";
        const label = element("span", "", item.Label || item.Text);
        label.append(element("small", "", item.Description || ""));
        button.append(label, element("span", "", current === item.Text ? "✓" : ""));
        button.addEventListener("click", () => {
          if (sendCommand(`/model ${item.Text}`)) {
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

  function applyTheme(preference = document.documentElement.dataset.themePreference || "") {
    const root = document.documentElement;
    const dark = preference ? preference === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.themePreference = preference;
    const label = dark ? "切换到浅色主题" : "切换到深色主题";
    ui["theme-toggle"].replaceChildren(icon(dark ? "sun" : "moon"));
    ui["theme-toggle"].setAttribute("aria-label", label);
    ui["theme-toggle"].setAttribute("aria-pressed", String(dark));
    ui["theme-toggle"].title = label;
    document.querySelector('meta[name="theme-color"]').content = dark ? "#2d3c4f" : "#f5f7fa";
  }

  ui["theme-toggle"].addEventListener("click", () => {
    const preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(preference);
    try { localStorage.setItem("elbot.theme", preference); } catch {}
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.dataset.themePreference) applyTheme();
  });
  ui["session-toggle"].addEventListener("click", () => toggleSessions(!ui.workspace.classList.contains("sessions-open")));
  ui["session-backdrop"].addEventListener("click", () => toggleSessions(false));
  ui["new-session"].addEventListener("click", () => changeSession(null));
  ui["session-search-toggle"].addEventListener("click", () => {
    const form = ui["session-search-form"];
    form.hidden = !form.hidden;
    ui["session-search-toggle"].setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) ui["session-search"].focus();
    else if (state.sessionQuery) {
      ui["session-search"].value = "";
      state.sessionQuery = "";
      refreshSessions();
    }
  });
  ui["session-search-form"].addEventListener("submit", event => {
    event.preventDefault();
    state.sessionQuery = ui["session-search"].value.trim();
    refreshSessions();
  });
  ui["session-search"].addEventListener("search", () => {
    if (!ui["session-search"].value) { state.sessionQuery = ""; refreshSessions(); }
  });
  ui["session-prev"].addEventListener("click", () => refreshSessions(state.sessionPage.prev_command));
  ui["session-next"].addEventListener("click", () => refreshSessions(state.sessionPage.next_command));
  ui["history-more"].addEventListener("click", loadHistory);

  ui["login-form"].addEventListener("submit", event => {
    event.preventDefault();
    const credentials = { clientID: ui["client-id"].value.trim(), token: ui["login-token"].value };
    if (!credentials.clientID || !credentials.token) return;
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
  ui["chat-scroll"].addEventListener("scroll", () => {
    ui["scroll-bottom"].hidden = nearBottom();
    if (ui["chat-scroll"].scrollTop < 80 && state.historyNext) loadHistory();
  });
  matchMedia("(max-width: 1000px)").addEventListener("change", () => toggleNotices(!ui.workspace.classList.contains("notices-hidden")));
  matchMedia("(max-width: 760px)").addEventListener("change", () => toggleSessions(false));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { toggleSessions(false); toggleNotices(false); }
  });
  window.addEventListener("pagehide", () => {
    for (const pending of state.commands.values()) clearTimeout(pending.timer);
    for (const pending of state.completions.values()) clearTimeout(pending.timer);
    clearTimeout(state.reconnectTimer);
    state.credentials = null;
    state.generation++;
    state.http.abort();
    state.ws?.close();
    for (const item of state.fileItems) { item.xhr?.abort(); if (item.blobURL) URL.revokeObjectURL(item.blobURL); }
  });
  setInterval(updateRuntime, 1000);
  applyTheme();
  toggleNotices(false);
  updateControls();
  const savedCredentials = readCredentials();
  if (savedCredentials) {
    ui["client-id"].value = savedCredentials.clientID;
    connect(savedCredentials);
  } else showLogin();
}
