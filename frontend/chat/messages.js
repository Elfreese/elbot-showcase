import { element, icon, iconButton, escapeHTML } from "../core/dom.js";
import { renderDiff } from "./diff.js";

// finish 仅结束生成；send 才用完整正文（包括空正文）替换预览。
export function reduceStream(current, event) {
  if (event.type === "reset") return null;
  if (!current && ["finish", "reasoning_done"].includes(event.type)) return null;
  const next = { text: "", reasoning: "", blocks: [], actions: [], finished: false, reasoningDone: false, committed: false, ...current };
  switch (event.type) {
    case "text_delta": next.text += event.text ?? ""; break;
    case "reasoning_delta": next.reasoning += event.text ?? ""; break;
    case "reasoning_done": next.reasoningDone = true; break;
    case "finish": next.finished = true; break;
    case "send": {
      next.text = event.text ?? "";
      next.actions = event.actions ?? [];
      next.blocks = event.blocks ?? [];
      next.committed = true;
      next.reasoningDone = true;
      break;
    }
    default: return current;
  }
  return next;
}


export function createMessages({ ui, state, renderStatusCard, refreshStatus, updateRuntime, runAction, notify, clipboard, mermaid }) {
  let raw = false;
  const dirty = new Set();
  let renderFrame = 0;
  const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  marked.use({ gfm: true, renderer: { image({ text }) { return escapeHTML(text || "图片"); } } });

  const scroll = ui["chat-scroll"];
  let jumpFrame = 0;
  let lastTop = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function setFollowing(follow) {
    state.followBottom = follow;
    ui["scroll-bottom"].hidden = follow;
  }

  function syncFollowing() {
    if (!state.visible) return;
    const top = scroll.scrollTop;
    const movingUp = top < lastTop;
    lastTop = top;
    if (movingUp && state.followBottom) cancelJump();
    if (!jumpFrame) setFollowing(scroll.scrollHeight - scroll.clientHeight - top <= (movingUp ? 1 : 24));
  }

  function cancelJump() {
    cancelAnimationFrame(jumpFrame);
    jumpFrame = 0;
  }

  function scrollBottom() {
    cancelJump();
    setFollowing(true);
    if (state.visible) scroll.scrollTop = scroll.scrollHeight;
  }

  function followContent() {
    if (!state.visible || !state.followBottom || jumpFrame) return;
    let previous = performance.now();
    // 流式换行只改变底部的位置，不重启动画。
    function step(now) {
      const bottom = scroll.scrollHeight - scroll.clientHeight;
      const top = scroll.scrollTop;
      const gap = bottom - top;
      if (gap <= 1 || reducedMotion.matches) {
        scroll.scrollTop = bottom;
        jumpFrame = 0;
      } else {
        const fraction = 1 - Math.exp(-(now - previous) / 70);
        scroll.scrollTop = top + Math.max(1, gap * fraction);
        previous = now;
        jumpFrame = requestAnimationFrame(step);
      }
      lastTop = scroll.scrollTop;
    }
    jumpFrame = requestAnimationFrame(step);
  }

  function jumpTo(edge) {
    cancelJump();
    setFollowing(false);
    const from = scroll.scrollTop;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / 200);
      const to = edge === "bottom" ? scroll.scrollHeight - scroll.clientHeight : 0;
      scroll.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (Math.abs(scroll.scrollTop - to) <= 1 || t === 1) {
        scroll.scrollTop = to;
        jumpFrame = 0;
        syncFollowing();
      } else jumpFrame = requestAnimationFrame(step);
    }
    jumpFrame = requestAnimationFrame(step);
  }

  scroll.addEventListener("scroll", syncFollowing);
  scroll.addEventListener("wheel", event => {
    if (event.ctrlKey || !event.deltaY) return;
    cancelJump();
    if (event.deltaY < 0 && scroll.scrollTop > 0) setFollowing(false);
  }, { passive: true });
  scroll.addEventListener("pointerdown", cancelJump);
  scroll.addEventListener("touchstart", cancelJump, { passive: true });

  ui["raw-toggle"].addEventListener("click", () => {
    const top = scroll.getBoundingClientRect().top + scroll.clientTop;
    const anchor = state.followBottom ? null : state.messages.find(({ node }) => node.getBoundingClientRect().bottom > top)?.node;
    const before = anchor?.getBoundingClientRect();

    raw = !raw;
    ui["raw-toggle"].setAttribute("aria-pressed", String(raw));
    for (const view of state.messages) renderMessage(view, true);
    if (state.followBottom) scrollBottom();
    else if (anchor) {
      cancelJump();
      const after = anchor.getBoundingClientRect();
      // 视口在长消息内时按比例还原进度；消息头尚在下方时保留它的像素偏移。
      const offset = top - before.top;
      scroll.scrollTop += after.top - top + (offset > 0 ? offset / before.height * after.height : offset);
    }
  });

  function refreshWelcome() {
    ui.welcome.hidden = !state.home || ui.messages.childElementCount > 0;
  }

  function scheduleRender(view) {
    dirty.add(view);
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      for (const item of dirty) if (item.node.isConnected) renderMessage(item);
      dirty.clear();
      renderFrame = 0;
      refreshWelcome();
      followContent();
    });
  }

  function renderBlocks(target, detail, toolResult = false) {
    target.replaceChildren();
    target.hidden = false;
    if (!Array.isArray(detail) || detail.length === 0) {
      target.append(element("div", "detail-text", "暂无待确认项"));
      return;
    }
    for (const block of detail) {
      switch (block.kind) {
        case "text": target.append(element("div", "detail-text", block.content ?? "")); break;
        case "operation": {
          if (!block.content.blocks?.length) break;
          const group = element("div");
          if (toolResult) target.append(element("strong", "", `${block.content.name} · 成功 · ${block.content.tool_call_id}`));
          renderBlocks(group, block.content.blocks);
          target.append(group);
          break;
        }
        case "session_list": {
          const page = block.content;
          for (const row of page.items || []) {
            const item = element("details", "result-data");
            item.append(element("summary", "", `${row.title || "未命名会话"} · ${row.message_count} 条 · ${row.id}`));
            for (const msg of row.messages || []) item.append(element("p", "", `${msg.role}: ${msg.content}`));
            target.append(item);
          }
          target.append(element("div", "detail-text", `第 ${page.page} 页 / ${page.total_pages} 页`));
          break;
        }
        case "question": {
          const q = block.content;
          target.append(element("div", "detail-text", `#${q.id} ${q.question}\n${q.options.join("\n")}`));
          break;
        }
        case "fields": {
          const rendered = element("dl", "detail-fields");
          for (const field of block.content) {
            rendered.append(element("dt", "", field.label),
              element("dd", "", typeof field.value === "string" ? field.value : JSON.stringify(field.value, null, 2)));
          }
          target.append(rendered);
          break;
        }
        case "code": {
          const rendered = element("pre", "detail-code");
          const code = element("code", "", block.content.content);
          rendered.append(code);
          const language = block.content.language;
          if (!raw && language && hljs.getLanguage(language)) {
            code.classList.add(`language-${language}`);
            hljs.highlightElement(code);
          }
          const copy = iconButton("copy", "复制代码", () => clipboard.copy(block.content.content, copy, "代码已复制"));
          copy.classList.add("code-copy");
          rendered.append(copy);
          target.append(rendered);
          break;
        }
        case "diff": {
          const rendered = element("div", "detail-diff");
          if (!block.content) rendered.append(element("span", "", "此次更改未提供 diff"));
          else if (raw) rendered.append(element("pre", "", block.content));
          else renderDiff(rendered, block.content ?? "");
          target.append(rendered);
          break;
        }
        default:
          target.append(element("pre", "detail-unknown", JSON.stringify(block, null, 2)));
      }
    }
  }
  function renderToolSegments(target, segments, fallback) {
    const items = segments?.length ? segments : [{ type: "text", text: fallback || "" }];
    for (const segment of items) {
      if (segment.type === "text") {
        target.append(element("div", "tool-result-text", segment.text || ""));
      } else {
        const label = [segment.type, segment.name, segment.mime_type].filter(Boolean).join(" · ");
        target.append(element("div", "tool-result-meta", label || JSON.stringify(segment)));
      }
    }
  }
  function renderMarkdown(target, text, settled = true) {
    // innerHTML 会丢弃旧节点，先释放目标区域内图的观察器。
    mermaid.clear(target);
    if (raw) {
      target.replaceChildren(element("div", "raw-text", text));
      return;
    }
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
      if (code.classList.contains("language-diff") || code.classList.contains("language-patch")) {
        const holder = element("div");
        renderDiff(holder, code.textContent);
        block.replaceWith(holder.firstElementChild);
        continue;
      }
      if (code.classList.contains("language-mermaid")) {
        // 流式期间不 mount：每帧重建会反复触发 ResizeObserver，导致页面抖动。
        if (!settled) continue;
        // mount 按容器宽度排版，必须先入 DOM 且有宽度；失败则换回原代码块。
        const diagram = element("div", "mermaid-block");
        block.replaceWith(diagram);
        if (!mermaid.render(code.textContent, diagram)) diagram.replaceWith(block);
        continue;
      }
      const copy = iconButton("copy", "复制代码", () => clipboard.copy(code.textContent, copy, "代码已复制"));
      const languageClass = [...code.classList].find(name => name.startsWith("language-"));
      const language = languageClass?.slice("language-".length);
      if (settled && language && hljs.getLanguage(language)) hljs.highlightElement(code);
      copy.classList.add("code-copy");
      block.append(copy);
    }
  }

  function toolStatusLabel(status) {
    return ({ pending: "执行中", awaiting_confirmation: "等待确认", completed: "已完成", interrupted: "已中断" })[status] || "";
  }

  function createMessage(role, data = {}, createdAt = new Date().toISOString()) {
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
    const reasoningSummary = element("summary", "", "思考过程");
    const reasoningContent = element("div", "reasoning-content");
    reasoning.append(reasoningSummary, reasoningContent);
    reasoning.hidden = true;
    const toolCalls = role === "assistant" ? element("details", "message-tool-calls") : null;
    const toolCallsSummary = element("summary", "message-tool-calls-summary");
    const toolCallList = element("div", "message-tool-call-list");
    if (toolCalls) toolCalls.append(toolCallsSummary, toolCallList);
    const sourceContent = role === "assistant" ? element("details", "source-content") : null;
    const sourceSummary = element("summary", "", "模型原文");
    const sourceText = element("pre", "source-content-text");
    if (sourceContent) sourceContent.append(sourceSummary, sourceText);
    const files = element("div", "message-files");
    const actions = element("div", "message-actions");
    const status = element("div", "message-state");
    const toolResult = role === "tool" ? element("details", "tool-result") : null;
    const toolArguments = role === "tool" ? element("pre", "message-tool-call-arguments") : null;
    const view = { node, body, reasoning, reasoningSummary, reasoningContent, toolCalls, toolCallsSummary, toolCallList, sourceContent, sourceText, files, actions, status, toolResult, toolArguments, role, createdAt, attachments: [],
      data: { text: "", reasoning: "", toolCalls: [], actions: [], committed: true, ...data }, renderedText: null, renderedSegments: null };
    reasoning.open = !view.data.committed;
    if (toolCalls && view.data.toolCalls.length) {
      const batchStatus = toolStatusLabel(view.data.toolBatchStatus);
      toolCallsSummary.textContent = `工具调用 · ${view.data.toolCalls.length}${batchStatus ? ` · ${batchStatus}` : ""}`;
      toolCalls.open = true;
      for (const call of view.data.toolCalls) {
        const item = element("details", "message-tool-call");
        const summary = element("summary", "", `${call.name || "工具"} · ${call.arguments || "无参数"}`);
        const args = element("pre", "message-tool-call-arguments", call.arguments || "");
        item.append(summary, args);
        toolCallList.append(item);
      }
    }
    const copy = iconButton("copy", "复制消息", () => clipboard.copy(view.data.statusData || view.data.blocks?.length ? view.body.innerText : view.data.text, copy, "消息已复制"));
    view.copy = copy;
    copy.classList.add("message-copy");
    header.append(element("span", "message-author", ({ assistant: "ElBot", user: state.account, tool: "工具", system: "系统" })[role] || role), copy, time);
    if (toolResult) {
      const summary = element("summary", "tool-result-summary");
      view.toolResultSummary = summary;
      // 长结果展开后无需滚回顶部：右下角悬浮按钮直接收起，并把标题带回视野。
      const collapse = iconButton("chevron", "收起工具结果", () => {
        toolResult.open = false;
        summary.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      collapse.classList.add("tool-collapse");
      toolResult.append(summary, toolArguments, reasoning, body, files, actions, status, collapse);
      node.append(header, toolResult);
    } else {
      if (toolCalls) node.append(header, reasoning, toolCalls, sourceContent, body, files, actions, status);
      else node.append(header, reasoning, body, files, actions, status);
    }
    return view;
  }

  function newMessage(role, data, createdAt) {
    const view = createMessage(role, data, createdAt);
    state.messages.push(view);
    ui.messages.append(view.node);
    renderMessage(view);
    refreshWelcome();
    followContent();
    return view;
  }

  function renderMessage(view, force = false) {
    const data = view.data;
    // 先定可见性：隐藏元素量到 0 宽，mermaid 会直接跳过排版。
    view.body.hidden = !(data.text || data.blocks?.length || (view.role === "tool" && data.segments?.length));
    if (view.toolResult) {
      const resultStatus = data.error || (data.toolSuccess === undefined
        ? data.toolResultStatus === "pending" && data.toolArguments !== undefined ? "正在调用" : toolStatusLabel(data.toolResultStatus)
        : data.toolSuccess ? "成功" : "失败");
      view.toolResultSummary.textContent = (data.toolName || "工具结果") + (resultStatus ? ` · ${resultStatus}` : "");
      view.toolArguments.textContent = data.toolArguments ?? "";
      view.toolArguments.hidden = data.toolArguments === undefined;
    }
    if (view.role === "tool") {
      if (force || view.renderedSegments !== data.segments || view.renderedBlocks !== data.blocks || view.renderedText !== data.text) {
        view.body.replaceChildren();
        if (data.blocks?.length) renderBlocks(view.body, data.blocks, data.toolSuccess !== undefined);
        if (data.segments?.length || data.text) renderToolSegments(view.body, data.segments, data.text);
        view.renderedSegments = data.segments;
      }
    } else if (force || view.renderedText !== data.text || view.renderedBlocks !== data.blocks || view.renderedSettled !== !!data.committed) {
      if (data.statusData) {
        mermaid.clear(view.body);
        view.body.replaceChildren(renderStatusCard(data.statusData));
      }
      else if (view.role === "assistant" && data.blocks?.length) renderBlocks(view.body, data.blocks);
      else if (view.role === "assistant") renderMarkdown(view.body, data.text, !!data.committed);
      else view.body.textContent = data.text;
    }
    view.renderedText = data.text;
    view.renderedBlocks = data.blocks;
    view.renderedSettled = !!data.committed;
    view.copy.hidden = !(data.text || data.blocks?.length);
    view.reasoning.hidden = !data.reasoning;
    view.reasoningContent.textContent = data.reasoning;
    view.reasoningSummary.textContent = data.reasoningDone ? "思考过程" : "正在思考";
    if (view.toolCalls) view.toolCalls.hidden = !data.toolCalls?.length;
    if (view.sourceContent) {
      view.sourceContent.hidden = !data.sourceContent || data.sourceContent === data.text;
      view.sourceText.textContent = data.sourceContent || "";
    }
    view.status.textContent = data.error || (!data.committed ? (data.finished ? "整理回复…" : "生成中…") : "");
    view.status.classList.toggle("error", !!data.error);
    view.status.hidden = !view.status.textContent;
    renderActions(view);
  }

  function updateActionControls(view) {
    for (const control of view.actions.querySelectorAll("button, textarea")) {
      control.disabled = !state.ready || state.navigating || state.recoveryBlocked || !!view.actionBusy || !!view.actionResolved;
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
    if (error !== undefined) {
      newMessage("assistant", { error });
      return;
    }
    if (result.status === "success" && result.kind === "status") {
      newMessage("assistant", { text: "会话状态", statusData: result.data, actions: result.actions });
      return;
    }
    if (result.blocks?.length || result.actions?.length) {
      newMessage("assistant", { blocks: result.blocks, actions: result.actions });
    }
  }

  function showToolCall(toolCallID, call) {
    if (!call) return;
    const existing = state.toolCalls.get(toolCallID);
    if (existing) {
      if (call.arguments !== undefined && existing.data.toolArguments === undefined) {
        Object.assign(existing.data, { toolArguments: call.arguments, toolName: call.name });
        scheduleRender(existing);
      }
      return existing;
    }
    const view = newMessage("tool", {
      toolCallID, toolName: call.name, toolArguments: call.arguments, toolResultStatus: "pending",
    });
    state.toolCalls.set(toolCallID, view);
    return view;
  }

  function showToolResult(toolCallID, result) {
    if (!result) return;
    const existing = state.toolCalls.get(toolCallID);
    const preview = existing?.data.blocks?.find(b => b.kind === "operation")?.content.blocks?.filter(b => b.kind === "diff");
    const blocks = result.blocks ?? (!result.success ? preview : undefined);
    const segments = result.segments || [];
    const text = segments.filter(segment => segment.type === "text").map(segment => segment.text || "").join("\n");
    const data = {
      toolCallID, toolName: existing?.data.toolName,
      toolArguments: existing?.data.toolArguments,
      toolSuccess: result.success, toolResultStatus: "completed", segments, blocks, actions: [],
      text,
    };
    const view = existing || newMessage("tool", data);
    if (existing) {
      view.data = { ...view.data, ...data };
      scheduleRender(view);
    }
    state.toolCalls.set(toolCallID, view);
    return view;
  }

  function handleStream(message) {
    const type = message.event.type;
    const previousPhase = state.streamPhase;
    if (type === "reasoning_delta") state.streamPhase = "思考中";
    else if (["text_delta", "reasoning_done"].includes(type)) state.streamPhase = "生成中";
    else if (["finish", "send", "reset"].includes(type)) state.streamPhase = "";
    if (state.streamPhase !== previousPhase) updateRuntime();
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
    if (data.committed && !data.text && !data.reasoning && !data.blocks.length && !data.actions.length) {
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

  return { jumpTo, cancelJump, isJumping: () => !!jumpFrame, scrollBottom, followContent, refreshWelcome, scheduleRender, renderMarkdown, createMessage, newMessage, renderMessage, updateActionControls, renderActions, showCommandResult, showToolCall, showToolResult, handleStream, clearRenderQueue() { dirty.clear(); } };
}
