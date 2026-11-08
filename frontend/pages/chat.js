import { element, icon } from "../core/dom.js";
import { createMessages } from "../chat/messages.js";
import { createStatus } from "../chat/status.js";
import { createSessions } from "../chat/sessions.js";
import { createModels } from "../chat/models.js";
import { createAttachments } from "../chat/attachments.js";
import { createCompletion } from "../chat/completion.js";

export function createChatPage({ ui, api, connection, addNotice, showLogin, closeNotices }) {
  const state = {
    ready: false, generation: 0, mediaToken: "", credentials: null, http: new AbortController(),
    streams: new Map(), inputs: new Map(), actionInputs: new Map(), completions: new Map(), sequence: 0,
    draftFiles: [], fileItems: new Set(), snapshot: null, completion: null, modelQuery: 0, currentModel: "",
    statusQuery: null, refreshedTurn: "", statusPhase: "idle", streamPhase: "",
    contextUsage: null, totalTokens: null, cacheUsage: null, messages: [],
    sessionID: "", home: true, homeReady: true, navigating: false, account: "", initialized: false,
    sessionPage: null, sessionQuery: "", listVersion: 0, listing: false,
    viewVersion: 0, historyPage: 0, historyNext: false, historyLoading: false, messageIDs: new Set(),
    visible: false, followBottom: true, scrollTop: 0,
  };
  const messages = createMessages({
    ui, state, runAction,
    renderStatusCard: (...args) => status.renderStatusCard(...args),
    resultMarkdown: (...args) => status.resultMarkdown(...args),
    refreshStatus: () => status.refreshStatus(), updateRuntime: () => status.updateRuntime(),
  });
  const status = createStatus({
    ui, state, api, addNotice, updateControls, renderMarkdown: messages.renderMarkdown,
    activateSession: (...args) => sessions.activateSession(...args),
    renderSessions: () => sessions.renderSessions(), loadHistory: () => sessions.loadHistory(),
  });
  const sessions = createSessions({
    ui, state, api, clearConversation, updateControls, addNotice, closeNotices,
    updateRuntime: status.updateRuntime, refreshStatus: status.refreshStatus,
    newMessage: messages.newMessage, scrollBottom: messages.scrollBottom,
  });
  const completion = createCompletion({ ui, state, connection, resizeInput, updateControls, addNotice });
  const models = createModels({ ui, state, api, refreshStatus: status.refreshStatus, addNotice });
  const attachments = createAttachments({
    ui, state, updateControls, addNotice, showLogin, hideCompletion: completion.hideCompletion,
    nearBottom: messages.nearBottom, scrollBottom: messages.scrollBottom,
  });

  function updateControls() {
    const disabled = !state.ready || state.navigating || !state.initialized;
    for (const id of ["message-input", "attach-button", "model-button", "new-session"]) ui[id].disabled = disabled;
    for (const button of ui["session-list"].querySelectorAll("button")) button.disabled = disabled;
    const uploading = state.draftFiles.some(file => file.status !== "ready");
    ui["send-button"].disabled = disabled || uploading || (!ui["message-input"].value.trim() && !state.draftFiles.length);
    ui["session-prev"].disabled = disabled || state.listing || !(state.sessionPage?.page > 1);
    ui["session-next"].disabled = disabled || state.listing || !state.sessionPage?.has_next;
    ui["history-more"].disabled = disabled || state.historyLoading;
    ui["stop-button"].hidden = !["preparing", "llm", "tool", "compact", "sending", "stopping", "awaiting_append_confirm", "awaiting_risk_confirm"].includes(state.statusPhase);
    ui["stop-button"].disabled = disabled || state.statusPhase === "stopping";
    for (const view of state.messages) messages.updateActionControls(view);
  }

  function resizeInput() {
    ui["message-input"].style.height = "auto";
    ui["message-input"].style.height = `${Math.min(230, ui["message-input"].scrollHeight)}px`;
  }

  function clearConversation(preserveDraft = false) {
    state.messages = [];
    state.streams.clear();
    messages.clearRenderQueue();
    for (const item of state.fileItems) {
      if (preserveDraft && item.draft) continue;
      item.xhr?.abort();
      if (item.blobURL) URL.revokeObjectURL(item.blobURL);
      state.fileItems.delete(item);
    }
    if (!preserveDraft) state.draftFiles = [];
    state.inputs.clear();
    state.actionInputs.clear();
    state.messageIDs.clear();
    state.historyPage = 0;
    state.historyNext = false;
    state.historyLoading = false;
    ui["history-more"].hidden = true;
    ui.messages.replaceChildren();
    if (!preserveDraft) ui["message-input"].value = "";
    resizeInput();
    attachments.renderDraftFiles();
    messages.refreshWelcome();
  }

  function invalidateConnection() {
    state.ready = false;
    state.statusQuery = null;
    state.listVersion++;
    state.viewVersion++;
    state.listing = false;
    state.historyLoading = false;
    state.navigating = false;
    state.mediaToken = "";
    state.http.abort();
    completion.clearCompletions();
    models.hideModels();
    for (const view of state.streams.values()) {
      view.data = { ...view.data, committed: true, reasoningDone: true, error: "连接中断，内容已保留" };
      messages.scheduleRender(view);
    }
    state.streams.clear();
    for (const view of state.actionInputs.values()) { view.actionBusy = false; messages.updateActionControls(view); }
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

  async function initialize() {
    if (!state.ready || state.initialized || !state.visible) return;
    state.initialized = true;
    state.navigating = true;
    updateControls();
    const generation = state.generation;
    try {
      const data = await api("/status");
      if (generation !== state.generation) return;
      sessions.activateSession(data.session, true);
      status.applyStatus(data);
      await Promise.all([sessions.loadHistory(), sessions.refreshSessions()]);
    } catch (error) {
      if (generation === state.generation) { state.initialized = false; addNotice("WARN", error.message); }
    } finally {
      if (generation === state.generation) { state.navigating = false; updateControls(); }
    }
  }

  function setConnection(snapshot) {
    const wasReady = state.ready;
    if (wasReady && (!snapshot.ready || snapshot.generation !== state.generation)) invalidateConnection();
    const account = snapshot.credentials?.clientID || state.account;
    if (account !== state.account) {
      clearConversation();
      state.account = account;
      state.initialized = false;
      state.sessionID = "";
      state.home = true;
      state.sessionPage = null;
      sessions.renderSessions();
    }
    state.ready = snapshot.ready;
    state.generation = snapshot.generation;
    state.credentials = snapshot.credentials;
    state.mediaToken = snapshot.mediaToken;
    if (state.ready && !wasReady) {
      state.http = new AbortController();
      if (state.initialized) { status.refreshStatus(); sessions.refreshSessions(); }
      else initialize();
      for (const file of state.draftFiles) attachments.uploadFile(file);
    }
    status.updateRuntime();
    updateControls();
  }

  function sendPayload(text, files = [], quiet = false) {
    if (!state.ready) { showLogin(); return false; }
    const id = `m-${++state.sequence}`;
    try { connection.send({ type: "input", id, text, file_ids: files.map(file => file.media.id) }); }
    catch (error) { addNotice("ERROR", error.message); return false; }
    if (!quiet) {
      const view = messages.newMessage("user", { text });
      for (const file of files) {
        file.draft = false;
        file.local = null;
        attachments.renderFileCard(file);
        view.files.append(file.card);
        view.attachments.push(file);
      }
      state.inputs.set(id, view);
      messages.refreshWelcome();
      messages.scrollBottom();
    }
    return id;
  }

  async function submitInput() {
    if (state.navigating) return;
    const text = ui["message-input"].value;
    if ((!text.trim() && !state.draftFiles.length) || state.draftFiles.some(file => file.status !== "ready")) return;
    const wasHome = state.home;
    if (state.home && !text.trimStart().startsWith("/")) state.home = false;
    if (!sendPayload(text, state.draftFiles)) { state.home = wasHome; messages.refreshWelcome(); return; }
    state.draftFiles = [];
    ui["message-input"].value = "";
    resizeInput();
    completion.hideCompletion();
    attachments.renderDraftFiles();
    updateControls();
  }

  async function runAction(view, action, reason = "") {
    if (!state.ready || view.actionBusy || view.actionResolved) return;
    view.actionBusy = true;
    messages.updateActionControls(view);
    let waiting = false;
    try {
      if (action.id === "detail") {
        const data = await api("/confirmation?refresh=true");
        messages.newMessage("assistant", { text: data.detail || data.arguments || "暂无待确认项" });
      } else if (["stop", "append_cancel"].includes(action.id)) {
        await api("/requests/stop-session", { method: "POST" });
        view.actionResolved = true;
      } else if (action.id === "append_confirm" || (["confirm", "confirmtool", "confirmall", "reject"].includes(action.id) && view.data.actions.some(item => ["confirmtool", "confirmall", "reject"].includes(item.id)))) {
        const result = await api("/confirmation/respond", { method: "POST", body: {
          decision: action.id === "reject" ? "reject" : "approve",
          scope: action.id === "confirmtool" ? "tool" : action.id === "confirmall" ? "all" : "current",
          extra: reason.trim(),
        } });
        if (!result.accepted) throw new Error("确认已失效，请刷新状态");
        view.actionResolved = true;
      } else if (action.command) {
        // 服务端提供的其他交互动作仍按 WS 协议提交，不构造管理命令。
        const id = sendPayload(action.command, [], true);
        if (id) { state.actionInputs.set(id, view); waiting = true; }
      }
      status.refreshStatus();
    } catch (error) { addNotice("WARN", error.message); }
    finally {
      if (!waiting) view.actionBusy = false;
      messages.updateActionControls(view);
    }
  }

  function handleMessage(message) {
    if (!state.initialized && message.type !== "complete_result") return;
    switch (message.type) {
      case "chat": if (message.text) messages.newMessage("assistant", { text: message.text }); break;
      case "stream": messages.handleStream(message); break;
      case "command_result": {
        const { result, error, request_id: id } = message;
        const action = state.actionInputs.get(id);
        if (action) {
          action.actionBusy = false;
          action.actionResolved = !error;
          state.actionInputs.delete(id);
          messages.updateActionControls(action);
        }
        messages.showCommandResult(result, error);
        state.inputs.delete(id);
        if (result?.kind === "status") status.applyStatus(result.data);
        if (["session", "compact"].includes(result?.kind) && !result.confirmation) {
          api("/status").then(data => {
            if (data.session?.id !== state.sessionID) {
              sessions.activateSession(data.session);
              sessions.loadHistory();
            }
            status.applyStatus(data);
            sessions.refreshSessions();
          }).catch(error => addNotice("WARN", error.message));
        } else { status.refreshStatus(); sessions.refreshSessions(); }
        break;
      }
      case "status": {
        const snapshot = message.snapshot;
        if (state.sessionID && snapshot.SessionID !== state.sessionID) break;
        if (!state.sessionID && snapshot.SessionID) {
          state.sessionID = snapshot.SessionID;
          state.home = false;
          messages.refreshWelcome();
          sessions.renderSessions();
        }
        if (snapshot.Phase !== "llm" || snapshot.RequestID !== state.snapshot?.RequestID) state.streamPhase = "";
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
        if (snapshot.Kind === "turn" && snapshot.RequestID && ["done", "error"].includes(snapshot.Phase) && snapshot.RequestID !== state.refreshedTurn) {
          state.refreshedTurn = snapshot.RequestID;
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
        const input = state.inputs.get(message.id);
        if (input) { input.data.error = message.text; messages.scheduleRender(input); state.inputs.delete(message.id); }
        const action = state.actionInputs.get(message.id);
        if (action) { action.actionBusy = false; state.actionInputs.delete(message.id); messages.updateActionControls(action); }
        addNotice("ERROR", message.text || "请求失败");
        break;
      }
    }
  }

  ui["session-toggle"].addEventListener("click", () => sessions.toggleSessions(!ui.workspace.classList.contains("sessions-open")));
  ui["session-backdrop"].addEventListener("click", () => sessions.toggleSessions(false));
  ui["new-session"].addEventListener("click", () => sessions.changeSession(null));
  ui["session-search-toggle"].addEventListener("click", () => {
    const form = ui["session-search-form"];
    form.hidden = !form.hidden;
    ui["session-search-toggle"].setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) ui["session-search"].focus();
    else if (state.sessionQuery) { state.sessionQuery = ""; ui["session-search"].value = ""; sessions.refreshSessions(); }
  });
  ui["session-search-form"].addEventListener("submit", event => {
    event.preventDefault(); state.sessionQuery = ui["session-search"].value.trim(); sessions.refreshSessions();
  });
  ui["session-search"].addEventListener("search", () => {
    if (!ui["session-search"].value) { state.sessionQuery = ""; sessions.refreshSessions(); }
  });
  ui["session-prev"].addEventListener("click", () => sessions.refreshSessions(state.sessionPage.page - 1));
  ui["session-next"].addEventListener("click", () => sessions.refreshSessions(state.sessionPage.page + 1));
  ui["history-more"].addEventListener("click", sessions.loadHistory);
  ui["composer-form"].addEventListener("submit", event => { event.preventDefault(); submitInput(); });
  ui["message-input"].addEventListener("input", () => { completion.hideCompletion(); resizeInput(); updateControls(); });
  ui["message-input"].addEventListener("click", completion.hideCompletion);
  ui["message-input"].addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Tab") { event.preventDefault(); completion.completeInput(event.shiftKey ? -1 : 1); }
    else if (state.completion && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); completion.completeInput(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Escape") { completion.hideCompletion(); models.hideModels(); }
    else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
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
    if (!ui["model-popover"].hidden) { models.hideModels(); return; }
    completion.hideCompletion();
    ui["model-popover"].hidden = false;
    ui["model-button"].setAttribute("aria-expanded", "true");
    ui["model-search"].value = "";
    ui["model-search"].focus();
    models.searchModels();
  });
  ui["model-search"].addEventListener("keydown", event => {
    if (event.key === "Escape") { models.hideModels(); ui["model-button"].focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); ui["model-list"].querySelector("button")?.focus(); }
  });
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".model-control")) models.hideModels();
    if (!event.target.closest("#completion-menu") && event.target !== ui["message-input"]) completion.hideCompletion();
  });
  ui["scroll-bottom"].addEventListener("click", messages.scrollBottom);
  ui["chat-scroll"].addEventListener("scroll", () => {
    if (!state.visible) return;
    state.followBottom = messages.nearBottom();
    ui["scroll-bottom"].hidden = state.followBottom;
    if (ui["chat-scroll"].scrollTop < 80 && state.historyNext) sessions.loadHistory();
  });
  ui["stop-button"].addEventListener("click", async () => {
    ui["stop-button"].disabled = true;
    try { await api("/requests/stop-session", { method: "POST" }); state.statusPhase = "stopping"; status.updateRuntime(); }
    catch (error) { addNotice("WARN", error.message); }
    updateControls();
  });
  matchMedia("(max-width: 760px)").addEventListener("change", () => sessions.toggleSessions(false));
  document.addEventListener("keydown", event => { if (event.key === "Escape") sessions.toggleSessions(false); });
  setInterval(status.updateRuntime, 1000);
  window.addEventListener("pagehide", () => {
    state.http.abort();
    completion.clearCompletions();
    for (const item of state.fileItems) { item.xhr?.abort(); if (item.blobURL) URL.revokeObjectURL(item.blobURL); }
  });

  return {
    closeSessions() { sessions.toggleSessions(false); },
    setConnection, handleMessage,
    show() {
      ui["chat-page"].hidden = false;
      state.visible = true;
      resizeInput();
      if (state.followBottom) messages.scrollBottom();
      else ui["chat-scroll"].scrollTop = state.scrollTop;
      initialize();
    },
    hide() {
      state.followBottom = messages.nearBottom();
      state.scrollTop = ui["chat-scroll"].scrollTop;
      state.visible = false;
      sessions.toggleSessions(false);
      models.hideModels();
      completion.hideCompletion();
      ui["chat-page"].hidden = true;
    },
    reset() {
      invalidateConnection();
      clearConversation();
      state.initialized = false;
      state.account = "";
      state.sessionID = "";
      state.home = true;
      state.sessionPage = null;
      sessions.renderSessions();
    },
  };
}
