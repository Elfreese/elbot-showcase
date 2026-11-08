import { element, icon, iconButton, escapeHTML, copyText } from "../core/dom.js";

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


export function createMessages({ ui, state, renderStatusCard, resultMarkdown, refreshStatus, updateRuntime, runAction }) {
  const dirty = new Set();
  let renderFrame = 0;
  const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  marked.use({ gfm: true, renderer: { image({ text }) { return escapeHTML(text || "图片"); } } });

  function nearBottom() {
    if (!state.visible) return state.followBottom;
    const scroll = ui["chat-scroll"];
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  }

  function scrollBottom() {
    state.followBottom = true;
    if (!state.visible) return;
    ui["chat-scroll"].scrollTop = ui["chat-scroll"].scrollHeight;
    ui["scroll-bottom"].hidden = true;
  }

  function refreshWelcome() {
    ui.welcome.hidden = !state.home || ui.messages.childElementCount > 0;
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
    header.append(element("span", "message-author", ({ assistant: "ElBot", user: state.account, tool: "工具", system: "系统" })[role] || role), copy, time);
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
    view.status.textContent = data.error || (!data.committed ? (data.finished ? "整理回复…" : "生成中…") : "");
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
      reason.placeholder = "补充拒绝原因";
      const reasonID = `reject-reason-${++state.sequence}`;
      reason.id = reasonID;
      label.htmlFor = reasonID;
      toggle.setAttribute("aria-controls", `${reasonID}-form`);
      form.id = `${reasonID}-form`;
      const submit = element("button", "message-action", "拒绝");
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

  function showCommandResult(result, error) {
    if (!result && !error) return;
    if (result?.kind === "status") {
      newMessage("assistant", { text: "会话状态", statusData: result.data, statusError: error });
      return;
    }
    const text = result ? resultMarkdown(result) : "";
    const view = newMessage("assistant", { text: text ?? `未知结果类型：${result.kind}，请展开原始数据`, actions: result?.confirmation?.actions || [], error: error ? `${error.message}\n${error.kind} · ${error.code}` : "" });
    if (text === null) {
      const details = element("details", "result-data");
      details.append(element("summary", "", "原始数据"), element("pre", "", JSON.stringify(result.data, null, 2)));
      view.node.append(details);
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

  return { nearBottom, scrollBottom, refreshWelcome, scheduleRender, renderMarkdown, newMessage, renderMessage, updateActionControls, renderActions, showCommandResult, handleStream, clearRenderQueue() { dirty.clear(); } };
}
