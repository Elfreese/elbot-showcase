import { createMessages } from "../chat/messages.js";
import { createWorkspace } from "../chat/workspace.js";
import { createStatus } from "../chat/status.js";
import { createSessions } from "../chat/sessions.js";
import { createQuestions } from "../chat/questions.js";
import { createSearchPicker } from "../core/search-picker.js";
import { openModelPicker } from "../chat/models.js";
import { createToolPreload } from "../chat/tool-preload.js";
import { createAttachments } from "../chat/attachments.js";
import { createComposerHistory } from "../chat/composer-history.js";
import { createCompletion } from "../chat/completion.js";
import { createMessageNav } from "../chat/nav.js";
import { registerChatShortcuts } from "../chat/shortcuts.js";
import { createFeedback } from "../core/feedback.js";
import { createClipboard } from "../core/clipboard.js";
import { createMermaid } from "../chat/mermaid.js";

export function createChatPage({ ui, api, connection, notify, showLogin, closeNotices }) {
  const state = {
    ready: false, generation: 0, mediaToken: "", http: new AbortController(),
    streams: new Map(), toolCalls: new Map(), inputs: new Map(), actionInputs: new Map(), completions: new Map(), sequence: 0,
    draftFiles: [], fileItems: new Set(), snapshot: null, completion: null, currentModel: "",
    statusQuery: null, statusPhase: "idle", streamPhase: "",
    contextUsage: null, totalTokens: null, cacheUsage: null, messages: [],
    sessionID: "", get home() { return !this.sessionID; }, navigating: false, recoveryBlocked: false, account: "",
    sessionPage: null, sessionQuery: "", listVersion: 0, listingPage: 0,
    historyToolCalls: new Map(), // 当前会话历史调用 ID → 名称与原始参数，供跨页结果卡片补齐。
    viewVersion: 0, historyPage: 0, historyNext: false, historyLoading: false, messageIDs: new Set(), historyInputIDs: new Set(),
    visible: false, followBottom: true, scrollTop: 0,
  };
  const feedback = createFeedback({ notify });
  const clipboard = createClipboard({ feedback });
  const mermaid = createMermaid({ clipboard });
  const messages = createMessages({
    renderStatusCard: data => status.renderStatusCard(data),
    ui, state, runAction, notify, clipboard, mermaid,
    refreshStatus: () => status.refreshStatus(), updateRuntime: () => status.updateRuntime(),
  });
  const status = createStatus({
    ui, state, api, notify, updateControls, renderMarkdown: messages.renderMarkdown,
  });
  const questions = createQuestions({ ui, state, api, notify, updateTitle: status.updateTitle });
  const history = createComposerHistory(ui["message-input"], () => api("/input-history", { signal: state.http.signal }),
    () => { resizeInput(); updateSendButton(); }, notify);
  const workspace = createWorkspace({ ui, state, api });
  const sessions = createSessions({
    switchDraft: history.switchSession,
    ui, state, api, clearConversation, updateControls, notify, closeNotices, questions, handleMessage,
    onSessionChanged: workspace.sessionChanged,
    updateRuntime: status.updateRuntime, refreshStatus: status.refreshStatus,
    createMessage: messages.createMessage, newMessage: messages.newMessage, showToolCall: messages.showToolCall, renderMessage: messages.renderMessage, scrollBottom: messages.scrollBottom,
  });
  const completion = createCompletion({ ui, state, connection, resizeInput, updateSendButton, notify });
  createMessageNav({ ui, state });
  const picker = createSearchPicker(ui);
  const toolPreload = createToolPreload({ ui, api, requestCompletion: completion.requestCompletion });
  const attachments = createAttachments({
    ui, state, updateControls, notify, showLogin, hideCompletion: completion.hideCompletion,
    followContent: messages.followContent,
  });

  function updateSendButton() {
    const input = ui["message-input"];
    const uploading = state.draftFiles.some(file => file.status !== "ready");
    ui["send-button"].disabled = input.disabled || uploading || (!input.value.trim() && !state.draftFiles.length);
  }

  let stopPending = false;
  function updateControls() {
    const disabled = !state.ready || state.navigating;
    const inputDisabled = disabled || state.recoveryBlocked;
    if (inputDisabled) { picker.close(); toolPreload.close(); }
    questions.controls();
    for (const id of ["message-input", "attach-button", "model-button", "preload-button", "preload-recent"]) ui[id].disabled = inputDisabled;
    ui["new-session"].disabled = disabled;
    ui["session-archived"].disabled = !state.ready;
    for (const button of ui["session-list"].querySelectorAll("button")) button.disabled = !state.ready;
    updateSendButton();
    ui["session-prev"].disabled = disabled || state.listingPage > 0 || !(state.sessionPage?.page > 1);
    ui["session-next"].disabled = disabled || state.listingPage > 0 || !state.sessionPage?.has_next;
    ui["history-more"].disabled = disabled || state.historyLoading;
    ui["stop-button"].disabled = inputDisabled || state.home || stopPending || ["idle", "done", "error", "stopping"].includes(state.statusPhase);
    for (const view of state.messages) messages.updateActionControls(view);
    workspace.updateControls();
  }

  function resizeInput() {
    ui["message-input"].style.height = "auto";
    ui["message-input"].style.height = `${Math.min(230, ui["message-input"].scrollHeight)}px`;
  }

  function clearConversation(preserveDraft = false) {
    completion.clearCompletions();
    picker.close();
    state.messages = [];
    state.streams.clear();
    state.toolCalls.clear();
    state.historyToolCalls.clear();
    messages.clearRenderQueue();
    for (const item of state.fileItems) {
      if (preserveDraft && item.draft) continue;
      item.xhr?.abort();
      if (item.blobURL) URL.revokeObjectURL(item.blobURL);
      state.fileItems.delete(item);
    }
    if (!preserveDraft) {
      state.draftFiles = [];
      toolPreload.clear();
    }
    state.inputs.clear();
    state.actionInputs.clear();
    state.messageIDs.clear();
    state.historyInputIDs.clear();
    state.historyPage = 0;
    state.historyNext = false;
    state.historyLoading = false;
    ui["history-more"].hidden = true;
    ui.messages.replaceChildren();
    resizeInput();
    attachments.renderDraftFiles();
    messages.refreshWelcome();
  }

  function invalidateConnection() {
    state.awaitingConfirmation = false;
    questions.reset();
    state.ready = false;
    sessions.disconnect();
    workspace.refresh();
    state.statusQuery = null;
    state.listVersion++;
    state.viewVersion++;
    state.listingPage = 0;
    state.historyLoading = false;
    state.navigating = false;
    state.mediaToken = "";
    state.http.abort();
    completion.clearCompletions();
    for (const view of state.streams.values()) {
      view.data = { ...view.data, committed: true, reasoningDone: true, error: "连接中断，内容已保留" };
      messages.scheduleRender(view);
    }
    state.streams.clear();
    for (const view of state.toolCalls.values()) {
      if (!["pending", "awaiting_confirmation"].includes(view.data.toolResultStatus)) continue;
      view.data = { ...view.data, error: "连接中断，结果未知" };
      messages.scheduleRender(view);
    }
    state.toolCalls.clear();
    for (const { view } of state.actionInputs.values()) { view.actionBusy = false; messages.updateActionControls(view); }
    state.actionInputs.clear();
    for (const item of state.draftFiles) {
      item.xhr?.abort();
      item.media = null;
      item.status = "waiting";
      item.progress = 0;
    }
    for (const item of state.fileItems) attachments.renderFileCard(item);
    updateControls();
  }

  function setConnection(snapshot) {
    const wasReady = state.ready;
    if (wasReady && (!snapshot.ready || snapshot.generation !== state.generation)) invalidateConnection();
    const account = snapshot.credentials?.clientID || state.account;
    if (account !== state.account) {
      history.reset();
      clearConversation();
      state.account = account;
      toolPreload.setAccount(account);
      state.sessionID = "";
      state.recoveryBlocked = false;
      state.sessionPage = null;
      sessions.renderSessions();
    }
    state.ready = snapshot.ready;
    state.generation = snapshot.generation;
    state.mediaToken = snapshot.mediaToken;
    if (state.ready && !wasReady) {
      state.http = new AbortController();
      const id = state.sessionID || sessions.takeReloadID();
      if (id) {
        state.recoveryBlocked = !!state.sessionID;
        sessions.changeSession(id, true);
      } else { sessions.refreshSessions(); status.refreshStatus(); }
      for (const file of state.draftFiles) attachments.uploadFile(file);
    }
    status.updateRuntime();
    updateControls();
  }

  // command_result 只回给发送连接，带原请求 ID 但不带会话 ID；切换视图后旧回包不能串进来。
  function inputIDPrefix() { return `v${state.viewVersion}:`; }
  function sendPayload(text, files = [], quiet = false) {
    if (!state.ready) { showLogin(); return false; }
    if (!state.sessionID || state.navigating || state.recoveryBlocked) return false;
    const id = inputIDPrefix() + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("");
    try { connection.send({ type: "input", id, session_id: state.sessionID, text, file_ids: files.map(file => file.media.id) }); }
    catch (error) { notify("ERROR", error.message); return false; }
    if (!quiet) {
      const view = messages.newMessage("user", { text, inputID: id });
      for (const file of files) {
        file.draft = false;
        file.local = null;
        attachments.renderFileCard(file);
        view.files.append(file.card);
        view.attachments.push(file);
      }
      state.inputs.set(id, view);
    }
    return id;
  }

  async function submitInput() {
    if (state.navigating || state.recoveryBlocked) return;
    const text = ui["message-input"].value;
    if ((!text.trim() && !state.draftFiles.length) || state.draftFiles.some(file => file.status !== "ready")) return;
    if (state.home) {
      const created = await sessions.changeSession(null, true);
      if (!created) return;
    }
    if (!sendPayload(toolPreload.withText(text), state.draftFiles)) return;
    history.endWalk();
    toolPreload.sent();
    state.draftFiles = [];
    ui["message-input"].value = "";
    resizeInput();
    completion.hideCompletion();
    attachments.renderDraftFiles();
    updateControls();
  }


  function runAction(view, action, reason = "") {
    if (view.actionBusy || view.actionResolved) return;
    const extra = reason.trim();
    const id = sendPayload(extra ? `${action.command} ${extra}` : action.command, [], true);
    if (!id) return;
    state.actionInputs.set(id, { view, detail: action.id === "detail" });
    view.actionBusy = true;
    messages.updateActionControls(view);
  }

  function handleMessage(message) {
    // 换绑通知按收到时的 view 判断，不随普通消息缓存重放。
    if (message.type === "session_binding_changed") {
      if (!state.navigating && message.session_id === state.sessionID) sessions.changeSession(message.next_session_id, true);
      return;
    }
    if (sessions.bufferFrame(message)) return;
    if (message.session_id ? message.session_id !== state.sessionID : !["command_result", "complete_result", "error"].includes(message.type)) return;
    switch (message.type) {
      case "user_input": {
        if (!state.historyInputIDs.has(message.id) && !state.inputs.has(message.id) && !state.actionInputs.has(message.id)) {
          const text = [message.text, ...(message.file_names || []).map(name => `附件：${name}`)].filter(Boolean).join("\n");
          messages.newMessage("user", { text, inputID: message.id });
        }
        state.inputs.delete(message.id);
        break;
      }
      case "chat":
        if (sessions.showRiskConfirmation(message.blocks, message.actions)) break;
        if (message.actions?.some(a => a.id === "append_confirm")) sessions.loadConfirmation(false);
        if (message.blocks?.some(b => b.kind === "question")) { questions.refresh(); break; }
        if (message.text || message.blocks?.length || message.actions?.length) {
          messages.newMessage("assistant", { text: message.text ?? "", blocks: message.blocks ?? [], actions: message.actions ?? [] });
        }
        break;
      case "stream":
        if (message.event?.actions?.some(a => a.id === "append_confirm")) sessions.loadConfirmation(false);
        if (message.event?.type === "tool_call") {
          messages.showToolCall(message.event.tool_call_id, message.event.tool_call);
        } else if (message.event?.type === "tool_result") {
          messages.showToolResult(message.event.tool_call_id, message.event.tool_result);
          workspace.refresh();
        } else messages.handleStream(message);
        break;
      case "command_result": {
        const { result, error, request_id: id } = message;
        if (!id?.startsWith(inputIDPrefix())) break;
        const pending = state.actionInputs.get(id);
        const success = error === undefined && result.status === "success";
        if (pending) {
          const { view, detail } = pending;
          state.actionInputs.delete(id);
          view.actionBusy = false;
          if (detail && success && view.data.toolResultStatus !== "completed") {
            view.data = { ...view.data, text: "", blocks: result.blocks, actions: result.actions ?? [] };
            messages.scheduleRender(view);
          } else view.actionResolved = success;
          messages.updateActionControls(view);
        }
        if (success && result.kind === "questions") questions.open();
        else {
          if (success && ["question_draft", "answers"].includes(result.kind)) questions.refresh();
          if (!(pending?.detail && success)) messages.showCommandResult(result, error);
        }
        state.inputs.delete(id);
        if (!success) break;
        if (state.awaitingConfirmation) sessions.loadConfirmation(false);
        if (result.kind === "status") status.applyStatus(result.data);
        status.refreshStatus(); sessions.refreshSessions();
        break;
      }
      case "status": {
        const snapshot = message.snapshot;
        if (!state.sessionID || snapshot.SessionID !== state.sessionID) break;
        if (snapshot.Phase !== "llm" || snapshot.RequestID !== state.snapshot?.RequestID) state.streamPhase = "";
        // 完成快照已清空 Kind 与 RequestID，只能靠 Phase 从工作态转为终态来判定。
        const wasWorking = ["preparing", "llm", "tool", "sending", "stopping", "compact", "awaiting_append_confirm", "awaiting_risk_confirm"].includes(state.statusPhase);
        if (state.awaitingConfirmation && (state.statusPhase !== snapshot.Phase || state.snapshot?.RequestID !== snapshot.RequestID)) sessions.loadConfirmation(false);
        state.statusPhase = snapshot.Phase;
        state.snapshot = snapshot;
        if (snapshot.Model) state.currentModel = [snapshot.Provider, snapshot.Model].filter(Boolean).join("/");
        if (snapshot.Usage) {
          const usage = snapshot.Usage;
          const ratios = status.usagePercentages(usage, state.contextUsage?.window || 0);
          state.totalTokens = usage.TotalTokens;
          if (ratios.context != null) state.contextUsage = { ...state.contextUsage, tokens: usage.TotalTokens, percent: ratios.context };
          state.cacheUsage = { tokens: usage.CacheHitTokens, percent: ratios.cache };
        }
        status.updateRuntime();
        updateControls();
        if (wasWorking && ["done", "error"].includes(snapshot.Phase)) {
          if (!ui["question-panel"].hidden) questions.refresh(true);
          status.refreshStatus();
          sessions.refreshSessions();
        }
        break;
      }
      case "attachment": {
        const item = attachments.makeFileItem(null, message.attachment);
        const view = messages.newMessage("assistant");
        view.files.append(item.card);
        view.attachments.push(item);
        if (attachments.previewable(item.media.mime_type)) attachments.loadFile(item, true);
        break;
      }
      case "complete_result": completion.settleCompletion(message.id, message.items || []); break;
      case "error": {
        if (state.completions.has(message.id)) { completion.settleCompletion(message.id, null, message.text); break; }
        const input = state.inputs.get(message.id) || (message.id?.startsWith(inputIDPrefix()) && state.messages.find(view => view.data.inputID === message.id));
        if (!message.session_id && message.id && !input && !state.actionInputs.has(message.id)) break;
        if (input) { input.data.error = message.text; messages.scheduleRender(input); state.inputs.delete(message.id); }
        const action = state.actionInputs.get(message.id);
        if (action) { action.view.actionBusy = false; state.actionInputs.delete(message.id); messages.updateActionControls(action.view); }
        notify("ERROR", message.text || "请求失败");
        break;
      }
    }
  }

  ui["session-toggle"].addEventListener("click", () => sessions.toggleSessions(!ui.workspace.classList.contains("sessions-open")));
  ui["session-backdrop"].addEventListener("click", () => sessions.toggleSessions(false));
  ui["new-session"].addEventListener("click", () => {
    if (state.home || (!state.recoveryBlocked && state.historyPage > 0 && !state.messageIDs.size && !state.messages.length)) {
      notify("INFO", "已在新对话");
      return;
    }
    sessions.changeSession("");
  });
  ui["session-search-toggle"].addEventListener("click", () => {
    const form = ui["session-search-form"];
    form.hidden = !form.hidden;
    ui["session-search-toggle"].setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) ui["session-search"].focus();
    else if (state.sessionQuery) { ui["session-search"].value = ""; sessions.searchSessions(""); }
  });
  ui["session-search-form"].addEventListener("submit", event => {
    event.preventDefault(); sessions.searchSessions(ui["session-search"].value.trim());
  });
  ui["session-search"].addEventListener("search", () => {
    if (!ui["session-search"].value) sessions.searchSessions("");
  });
  ui["session-prev"].addEventListener("click", () => sessions.refreshSessions(state.sessionPage.page - 1));
  ui["session-next"].addEventListener("click", () => sessions.refreshSessions(state.sessionPage.page + 1));
  ui["history-more"].addEventListener("click", sessions.loadHistory);
  ui["composer-form"].addEventListener("submit", event => { event.preventDefault(); submitInput(); });
  ui["message-input"].addEventListener("input", () => { history.endWalk(); completion.hideCompletion(); resizeInput(); updateSendButton(); });
  ui["message-input"].addEventListener("click", completion.hideCompletion);
  ui["message-input"].addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); history.endWalk(); completion.completeInput(event.shiftKey ? -1 : 1); }
    else if (state.completion && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); completion.completeInput(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") history.arrow(event);
    else if (event.key === "Escape") completion.hideCompletion();
    else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (event.repeat) return; // 回填后按住 Enter 不应变成发送。
      if (state.completion) completion.hideCompletion();
      else submitInput();
    }
  });
  ui["message-input"].addEventListener("paste", event => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); attachments.addFiles(files); }
  });
  ui["attach-button"].addEventListener("click", () => ui["file-input"].click());
  ui["file-input"].addEventListener("change", () => { attachments.addFiles(Array.from(ui["file-input"].files)); ui["file-input"].value = ""; });
  ui["chat-page"].addEventListener("dragover", event => {
    if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); ui["drop-overlay"].hidden = false; }
  });
  ui["chat-page"].addEventListener("dragleave", event => {
    if (!ui["chat-page"].contains(event.relatedTarget)) ui["drop-overlay"].hidden = true;
  });
  ui["chat-page"].addEventListener("drop", event => {
    event.preventDefault(); ui["drop-overlay"].hidden = true;
    attachments.addFiles(Array.from(event.dataTransfer.files));
  });
  ui["model-button"].addEventListener("click", () => {
    if (ui["model-button"].getAttribute("aria-expanded") === "true") { picker.close(); return; }
    completion.hideCompletion();
    openModelPicker({ picker, ui, state, api, refreshStatus: status.refreshStatus });
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest("#completion-menu") && event.target !== ui["message-input"]) completion.hideCompletion();
  });
  ui["scroll-bottom"].addEventListener("click", () => messages.jumpTo("bottom"));
  registerChatShortcuts(ui, messages.jumpTo, () => {
    const input = ui["message-input"];
    let history;
    completion.hideCompletion();
    picker.open({
      title: "已发送的内容", placeholder: "搜索历史消息", hint: "↑ ↓ 选择 · Enter 回填 · Esc 取消",
      loading: "正在读取历史…", empty: "没有匹配的历史消息", focusAfterSelect: input,
      async search(query, signal) {
        history ??= api("/input-history", { signal }); // 每次打开只取一次。
        const { items } = await history;
        const term = query.trim().toLowerCase();
        return { items: items.filter(text => text.toLowerCase().includes(term)).map(label => ({ label })) };
      },
      select({ label }) {
        input.value = label;
        input.setSelectionRange(label.length, label.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
    });
  });
  ui["chat-scroll"].addEventListener("scroll", () => {
    if (!state.visible || messages.isJumping()) return;
    if (ui["chat-scroll"].scrollTop < 80 && state.historyNext) sessions.loadHistory();
  });
  ui["stop-button"].addEventListener("click", async () => {
    stopPending = true;
    updateControls();
    try { await api("/requests/stop-session", { method: "POST" }); await status.refreshStatus(); }
    catch (error) { notify("WARN", error.message); }
    finally { stopPending = false; updateControls(); }
  });
  matchMedia("(max-width: 760px)").addEventListener("change", () => sessions.toggleSessions(false));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !ui["session-list"].querySelector(":popover-open")) sessions.toggleSessions(false); });
  setInterval(status.updateElapsed, 1000);
  window.addEventListener("pagehide", () => {
    state.http.abort();
    completion.clearCompletions();
    for (const item of state.fileItems) { item.xhr?.abort(); if (item.blobURL) URL.revokeObjectURL(item.blobURL); }
  });

  return {
    closeSessions() { sessions.toggleSessions(false); },
    setConnection, handleMessage, refreshWorkspace: workspace.refresh,
    setPageTitle: status.updateTitle,
    show() {
      ui["raw-toggle"].hidden = false;
      ui["chat-page"].hidden = false;
      state.visible = true;
      resizeInput();
      if (state.followBottom) messages.scrollBottom();
      else ui["chat-scroll"].scrollTop = state.scrollTop;
    },
    hide() {
      messages.cancelJump();
      state.scrollTop = ui["chat-scroll"].scrollTop;
      state.visible = false;
      sessions.toggleSessions(false);
      picker.close();
      toolPreload.close();
      completion.hideCompletion();
      ui["raw-toggle"].hidden = true;
      ui["chat-page"].hidden = true;
    },
    reset() {
      invalidateConnection();
      history.reset();
      clearConversation();
      state.account = "";
      toolPreload.setAccount("");
      state.sessionID = "";
      state.recoveryBlocked = false;
      state.sessionPage = null;
      sessions.renderSessions();
    },
  };
}
