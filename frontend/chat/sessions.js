import { element } from "../core/dom.js";

export function createSessions({ ui, state, api, clearConversation, updateControls, updateRuntime, refreshStatus, newMessage, renderMessage, scrollBottom, notify, closeNotices, refreshWorkspace, questions, handleMessage }) {
  const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

  const viewKey = "elbot.chat.view";
  let reload = performance.getEntriesByType("navigation")[0]?.type === "reload";

  function rememberView(id) {
    try {
      if (id) sessionStorage.setItem(viewKey, JSON.stringify({ account: state.account, id }));
      else sessionStorage.removeItem(viewKey);
    } catch { /* 禁用存储时，只保留内存中的会话。 */ }
  }
  // 新标签页可能从 opener 复制了 sessionStorage，不继承它的会话。
  if (!reload) rememberView("");

  function takeReloadID() {
    if (!reload) return "";
    reload = false;
    try {
      const view = JSON.parse(sessionStorage.getItem(viewKey));
      return view?.account === state.account ? view.id : "";
    } catch { return ""; }
  }
  function toggleSessions(show) {
    if (show) closeNotices(true);
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
    ui["session-page"].textContent = state.sessionPage ? `${state.sessionPage.total_pages === 0 ? 0 : state.sessionPage.page}/${state.sessionPage.total_pages}` : "—/—";
    updateControls();
  }

  async function refreshSessions(page = 1) {
    if (!state.ready) return;
    const version = ++state.listVersion;
    state.listing = true;
    ui["session-feedback"].textContent = "读取中…";
    ui["session-feedback"].classList.remove("error");
    updateControls();
    try {
      const data = await api(`/sessions?${new URLSearchParams({ query: state.sessionQuery, page, page_size: 20 })}`);
      if (version !== state.listVersion) return;
      state.sessionPage = data;
      renderSessions();
      ui["session-feedback"].textContent = data.items.length ? "" : state.sessionQuery ? "无匹配会话" : "暂无会话";
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
    state.sessionID = session.id;
    rememberView(session.id);
    state.awaitingConfirmation = false;
    riskView = null;
    questions.reset(state.sessionID);
    state.workspace.syncing = false;
    ui["workspace-settings-feedback"].textContent = "";
    state.snapshot = null;
    state.statusPhase = "idle";
    state.streamPhase = "";
    state.contextUsage = null;
    state.totalTokens = null;
    state.cacheUsage = null;
    clearConversation(preserveDraft);
    ui["conversation-heading"].textContent = state.home ? "新对话" : session.title || "未命名会话";
    renderSessions();
    updateRuntime();
    scrollBottom();
    refreshWorkspace();
  }

  // 只串行提交订阅；读取历史和状态不阻塞下一次切换。
  let tail = Promise.resolve(), intent = 0, pending = null, confirmed = null;
  function disconnect() {
    ++intent;
    tail = Promise.resolve();
    pending = confirmed = null;
  }
  function bufferFrame(message) {
    const target = pending?.session.id === message.session_id ? pending : confirmed;
    if (!target || target.session.id !== message.session_id) return false;
    target.frames.push(message);
    return true;
  }
  function changeSession(id, preserveDraft = false) {
    if (!state.ready) return Promise.resolve(false);
    if (id && id === state.sessionID && !state.navigating && !state.recoveryBlocked) {
      toggleSessions(false);
      return Promise.resolve(true);
    }
    const version = ++intent, signal = state.http.signal;
    state.navigating = true;
    updateControls();
    const select = async () => {
      if (version !== intent) return false;
      try {
        // null 仅用于发送首条消息时建会话；空字符串表示退回未订阅的新对话页。
        const session = id === null ? await api("/sessions", { method: "POST", signal })
          : state.sessionPage?.items.find(row => row.id === id) || { id };
        if (version !== intent) return false;
        pending = { session, preserveDraft, frames: [] };
        if (session.id) await api("/view/session", { method: "PUT", body: { session_id: session.id }, signal });
        else await api("/view/session", { method: "DELETE", signal });
        if (signal.aborted) return false;
        confirmed = pending;
        state.recoveryBlocked = false;
        return version === intent;
      } catch (error) {
        if (!signal.aborted) {
          // 没拿到确定的响应时，不能假设服务端还停在旧会话。
          if (pending && (!error.status || error.status >= 500)) state.recoveryBlocked = true;
          if (version === intent && state.home && id && (error.status === 404 || error.status === 403)) rememberView("");
          notify("ERROR", error.message);
        }
        return false;
      } finally {
        if (!signal.aborted) pending = null;
        if (version === intent) {
          if (confirmed) {
            const { session, preserveDraft, frames } = confirmed;
            confirmed = null;
            activateSession(session, preserveDraft);
            for (const frame of frames) handleMessage(frame);
            closeNotices(); toggleSessions(false);
            loadHistory(); loadConfirmation(); refreshStatus();
          }
          state.navigating = false;
          updateControls(); refreshSessions();
          if (state.visible) ui["message-input"].focus();
        }
      }
    };
    tail = tail.then(select);
    return tail;
  }

  let confirmationRead = 0;
  let riskView = null;
  function showRiskConfirmation(blocks, actions) {
    ++confirmationRead; // A live prompt supersedes an older recovery read.
    state.awaitingConfirmation = true;
    const data = { text: "", blocks, actions };
    if (!riskView || riskView.actionResolved || riskView.actionBusy) {
      riskView = newMessage("assistant", data);
    } else {
      Object.assign(riskView.data, data);
      renderMessage(riskView);
    }
    updateRuntime();
  }
  async function loadConfirmation(show = true) {
    const read = ++confirmationRead;
    if (!state.ready || !state.sessionID) return;
    const version = state.viewVersion;
    const sessionID = state.sessionID;
    try {
      const data = await api("/confirmation");
      if (version !== state.viewVersion || state.sessionID !== sessionID || read !== confirmationRead) return;
      state.awaitingConfirmation = data.session_id === sessionID && !!data.kind;
      updateRuntime();
      if (state.awaitingConfirmation && data.kind === "tool") {
        if (show && !riskView) showRiskConfirmation(data.detail, data.actions);
      } else {
        if (riskView) {
          riskView.actionResolved = true;
          renderMessage(riskView);
          riskView = null;
        }
        if (show && state.awaitingConfirmation) newMessage("assistant", { text: "", blocks: data.detail, actions: data.actions });
      }
    } catch (error) {
      if (version === state.viewVersion && state.ready) notify("WARN", error.message);
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
    ui["history-more"].textContent = "读取中…";
    try {
      const data = await api(`/sessions/${encodeURIComponent(sessionID)}/messages?${new URLSearchParams({ page, page_size: 100 })}`);
      if (version !== state.viewVersion || data.session_id !== sessionID) return;
      const scroll = ui["chat-scroll"];
      const oldHeight = scroll.scrollHeight;
      const oldTop = scroll.scrollTop;
      for (const row of data.items) for (const id of row.input_ids || []) state.historyInputIDs.add(id);
      const previous = state.messages.filter(view => {
        if (!state.historyInputIDs.has(view.data.inputID)) return true;
        view.node.remove();
        return false;
      });
      const added = [];
      const nodes = document.createDocumentFragment();
      // 参数属于助手调用记录；先收集，结果卡片即可跨页补齐。
      for (const row of data.items) {
        for (const call of row.tool_calls || []) state.historyToolCalls.set(call.id, call);
      }
      for (const view of previous) {
        if (view.role !== "tool" || view.data.toolArguments !== undefined) continue;
        const call = state.historyToolCalls.get(view.data.toolCallID);
        if (!call) continue;
        view.data.toolName = view.data.toolName || call.name;
        view.data.toolArguments = call.arguments;
        renderMessage(view);
      }
      for (const row of data.items) {
        if (state.messageIDs.has(row.id)) continue;
        state.messageIDs.add(row.id);
        if (row.role === "assistant" && !row.content && !row.reasoning_content && !row.source_content
          && !row.segments?.some(segment => segment.type === "file" || segment.type === "image")) continue;
        const call = row.role === "tool" ? state.historyToolCalls.get(row.tool_call_id) : null;
        const view = newMessage(row.role, { text: row.content, sourceContent: row.source_content, reasoning: row.reasoning_content, reasoningDone: true, toolResultStatus: row.tool_result_status, toolName: row.tool_name || call?.name, toolArguments: call?.arguments, toolCallID: row.tool_call_id, segments: row.role === "tool" ? row.segments : null }, row.created_at);
        for (const file of (row.role === "tool" ? [] : (row.segments || []).filter(segment => segment.type === "file" || segment.type === "image"))) {
          const card = element("div", "file-card");
          card.append(element("div", "file-card-main", `${file.name || (file.type === "image" ? "图片" : "文件")} · 历史附件`));
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
      ui["history-more"].textContent = "更早消息";
      if (page === 1 && state.followBottom) scrollBottom();
      else if (state.visible) scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
    } catch (error) {
      if (version === state.viewVersion) {
        ui["history-more"].textContent = "读取失败，点此重试";
        if (state.ready) notify("WARN", error.message);
      }
    } finally {
      if (version === state.viewVersion) {
        state.historyLoading = false;
        ui["history-more"].disabled = !state.ready;
      }
    }
  }

  return { takeReloadID, toggleSessions, renderSessions, refreshSessions, disconnect, bufferFrame, changeSession, loadHistory, loadConfirmation, showRiskConfirmation };
}
