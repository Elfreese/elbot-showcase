import { element } from "../core/dom.js";

export function createSessions({ ui, state, api, clearConversation, updateControls, updateRuntime, refreshStatus, newMessage, scrollBottom, addNotice, closeNotices }) {
  const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

  function toggleSessions(show) {
    if (show) closeNotices();
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
      const result = await api(id ? `/sessions/${encodeURIComponent(id)}/resume` : "/sessions", {
        method: "POST", ...(id ? { body: { message_limit: 0 } } : {}),
      });
      if (generation !== state.generation) return false;
      activateSession(result.session, preserveDraft);
      toggleSessions(false);
      if (!state.home) await loadHistory();
      return true;
    } catch (error) {
      if (generation === state.generation && state.ready) addNotice("ERROR", error.message);
      return false;
    } finally {
      if (generation === state.generation) {
        state.navigating = false;
        updateControls();
        refreshStatus();
        refreshSessions();
        if (state.ready && state.visible) ui["message-input"].focus();
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
    ui["history-more"].textContent = "读取中…";
    try {
      const data = await api(`/sessions/${encodeURIComponent(sessionID)}/messages?${new URLSearchParams({ page, page_size: 20 })}`);
      if (version !== state.viewVersion || data.session_id !== sessionID) return;
      const scroll = ui["chat-scroll"];
      const oldHeight = scroll.scrollHeight;
      const oldTop = scroll.scrollTop;
      const previous = state.messages.slice();
      const added = [];
      const nodes = document.createDocumentFragment();
      for (const row of data.items) {
        if (state.messageIDs.has(row.id)) continue;
        state.messageIDs.add(row.id);
        const view = newMessage(row.role, { text: row.content }, row.created_at);
        for (const file of (row.segments || []).filter(segment => segment.type === "file" || segment.type === "image")) {
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
      if (page === 1) scrollBottom();
      else if (state.visible) scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
    } catch (error) {
      if (version === state.viewVersion) {
        ui["history-more"].textContent = "读取失败，点此重试";
        if (state.ready) addNotice("WARN", error.message);
      }
    } finally {
      if (version === state.viewVersion) {
        state.historyLoading = false;
        ui["history-more"].disabled = !state.ready;
      }
    }
  }

  return { toggleSessions, renderSessions, refreshSessions, activateSession, changeSession, loadHistory };
}
