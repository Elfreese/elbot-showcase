import { element, icon, iconButton } from "../core/dom.js";

export function createSessions({ ui, state, api, clearConversation, switchDraft, updateControls, updateRuntime, refreshStatus, createMessage, newMessage, showToolCall, renderMessage, scrollBottom, notify, closeNotices, onSessionChanged, questions, handleMessage }) {
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
  const list = ui["session-list"];
  let archived = false;
  ui["session-archived"].addEventListener("click", () => {
    archived = !archived;
    ui["session-archived"].setAttribute("aria-pressed", String(archived));
    ui["session-archived"].title = archived ? "返回普通会话" : "查看已归档会话";
    restartSessionList();
  });

  function closeMenu() { list.querySelector(":popover-open")?.hidePopover(); }
  let menuScrollTop = 0;
  list.addEventListener("scroll", () => { if (list.scrollTop !== menuScrollTop) closeMenu(); });

  function toggleSessions(show) {
    if (show) closeNotices(true);
    else closeMenu();
    ui.workspace.classList.toggle("sessions-open", show);
    ui["session-toggle"].setAttribute("aria-expanded", String(show));
    ui["session-backdrop"].hidden = !show || !matchMedia("(max-width: 760px)").matches;
  }

  function editTitle(item, row) {
    const input = element("input", "session-rename");
    input.setAttribute("aria-label", "会话标题");
    input.value = row.title;
    input.addEventListener("blur", () => input.remove(), { once: true });
    input.addEventListener("keydown", event => {
      if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
      event.preventDefault(); event.stopPropagation();
      const title = input.value.trim();
      item.querySelector(".session-more").focus(); // 失焦收起编辑器。
      if (event.key === "Enter" && title && title !== row.title.trim()) manageSession(row, "rename", title);
    });
    item.append(input);
    input.focus();
    input.select();
  }

  async function manageSession(row, action, title) {
    let path = `/sessions/${encodeURIComponent(row.id)}`;
    let method = "POST", body;
    if (action === "rename") {
      method = "PATCH";
      body = { title };
    } else if (action === "delete") {
      if (!window.confirm(`删除会话「${row.title || "未命名会话"}」？此操作不可撤销。`)) return;
      method = "DELETE";
      body = { confirmed: true };
    } else {
      path += `/${action}`;
      if (action === "archive") body = { confirmed: true };
    }
    const { signal } = state.http;
    list.inert = true;
    try {
      const result = await api(path, { method, body, signal });
      if (signal.aborted) return;
      if (action === "rename" && row.id === state.sessionID) ui["conversation-heading"].textContent = result.session?.title ?? body.title;
      if ((action === "delete" || action === "archive") && row.id === state.sessionID && !state.navigating) {
        let next;
        try {
          ({ current_session_id: next } = await api("/sessions?page=1&page_size=1", { signal }));
        } catch (error) {
          if (!signal.aborted) notify("WARN", `操作已完成，当前会话读取失败：${error.message}`);
        }
        if (!signal.aborted && row.id === state.sessionID && !state.navigating)
          await changeSession(next && next !== row.id ? next : "", true);
      } else await refreshSessions();
    } catch (error) { if (!signal.aborted) notify("ERROR", error.message); }
    finally { if (!signal.aborted) list.inert = false; }
  }

  let sessionRows = new Map();

  function positionMenu(menu) {
    const rect = menu.parentElement.querySelector(".session-more").getBoundingClientRect();
    const above = rect.bottom > window.innerHeight / 2;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.top = above ? "auto" : `${rect.bottom + 4}px`;
    menu.style.bottom = above ? `${window.innerHeight - rect.top + 4}px` : "auto";
    menuScrollTop = list.scrollTop; // 刷新布局也可能触发 scroll，不把它当成用户滚动。
  }

  function createSessionRow(id) {
    let row;
    const node = element("div", "session-row");
    const button = element("button", "session-item");
    button.type = "button";
    const title = element("span", "session-title"), date = element("time", "session-date");
    button.append(title, date);
    button.addEventListener("click", () => changeSession(id));
    const pin = iconButton("pin", "取消置顶", () => manageSession(row, "unpin"));
    pin.classList.add("session-pin");
    const more = element("button", "icon-button session-more");
    more.type = "button";
    more.title = "会话操作";
    more.append(icon("chevron"));
    const menu = element("div", "session-action-menu");
    menu.popover = "auto";
    more.popoverTargetElement = menu;
    menu.addEventListener("beforetoggle", event => { if (event.newState === "open") positionMenu(menu); });
    node.append(button, more, menu);

    function action(label, run, className = "") {
      const option = element("button", className, label);
      option.type = "button";
      option.addEventListener("click", () => { menu.hidePopover(); run(); });
      menu.append(option);
      return option;
    }
    const pinAction = action("置顶", () => manageSession(row, row.pinned_at ? "unpin" : "pin"));
    const archiveAction = action("归档", () => manageSession(row, row.archived_at ? "unarchive" : "archive"));
    action("重命名", () => editTitle(node, row));
    action("删除", () => manageSession(row, "delete"), "delete-session");

    function update(next) {
      if (!row || next.title !== row.title) {
        button.title = title.textContent = next.title || "未命名会话";
        more.setAttribute("aria-label", `会话操作：${button.title}`);
        pin.title = `取消置顶：${button.title}`;
        pin.setAttribute("aria-label", pin.title);
      }
      if (next.updated_at !== row?.updated_at) {
        date.dateTime = next.updated_at;
        date.textContent = dateFormat.format(new Date(next.updated_at));
      }
      if (!!next.pinned_at !== !!row?.pinned_at) {
        if (next.pinned_at) node.insertBefore(pin, more); else pin.remove();
        pinAction.textContent = next.pinned_at ? "取消置顶" : "置顶";
      }
      if (!!next.archived_at !== !!row?.archived_at) archiveAction.textContent = next.archived_at ? "取消归档" : "归档";
      const current = id === state.sessionID;
      if (current !== button.classList.contains("current")) {
        button.classList.toggle("current", current);
        if (current) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
      }
      row = next;
    }
    return { node, update };
  }

  function renderSessions() {
    const page = state.sessionPage;
    const nextRows = new Map();
    for (const row of page?.items || []) {
      const view = sessionRows.get(row.id) || createSessionRow(row.id);
      view.update(row);
      nextRows.set(row.id, view);
    }
    for (const [id, view] of sessionRows) if (!nextRows.has(id)) view.node.remove();
    const menu = list.querySelector(":popover-open");
    const fixed = (menu || document.activeElement)?.closest(".session-row");
    let before = null;
    // 保留正在操作的行在 DOM 中的位置关系：只挪它的兄弟，避免重新插入导致失焦或关闭菜单。
    for (const { node } of [...nextRows.values()].reverse()) {
      if (node !== fixed && (node.parentNode !== list || node.nextElementSibling !== before)) list.insertBefore(node, before);
      before = node;
    }
    sessionRows = nextRows;
    if (menu) positionMenu(menu);
    ui["session-page"].textContent = page ? `${page.total_pages ? page.page : 0}/${page.total_pages}` : "—/—";
    updateControls();
  }

  function searchSessions(query) {
    if (state.sessionQuery === query) return refreshSessions();
    state.sessionQuery = query;
    return restartSessionList();
  }

  function restartSessionList() {
    state.sessionPage = null;
    renderSessions();
    return refreshSessions(1);
  }

  async function refreshSessions(page = state.listingPage || state.sessionPage?.page || 1) {
    if (!state.ready) return;
    const version = ++state.listVersion;
    state.listingPage = page;
    if (page !== state.sessionPage?.page) ui["session-feedback"].textContent = "读取中…";
    ui["session-feedback"].classList.remove("error");
    updateControls();
    try {
      const data = await api(`/sessions?${new URLSearchParams({ query: state.sessionQuery, page, page_size: 20, archived })}`);
      if (version !== state.listVersion) return;
      const last = Math.max(1, data.total_pages);
      if (!data.items.length && page > last) return refreshSessions(last);
      state.sessionPage = data;
      ui["session-feedback"].textContent = data.items.length ? "" : state.sessionQuery ? "无匹配会话" : archived ? "暂无已归档会话" : "暂无会话";
      renderSessions();
    } catch (error) {
      if (version === state.listVersion) {
        ui["session-feedback"].textContent = error.message;
        ui["session-feedback"].classList.add("error");
      }
    } finally {
      if (version === state.listVersion) { state.listingPage = 0; updateControls(); }
    }
  }

  function activateSession(session, preserveDraft, created) {
    switchDraft(state.sessionID, session.id, created);
    state.viewVersion++;
    state.statusQuery = null;
    state.sessionID = session.id;
    rememberView(session.id);
    state.awaitingConfirmation = false;
    riskView = null;
    questions.reset(state.sessionID);
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
    onSessionChanged();
  }

  // 只串行提交订阅；读取历史和状态不阻塞下一次切换。
  let tail = Promise.resolve(), intent = 0, pending = null, confirmed = null;
  function disconnect() {
    closeMenu();
    list.inert = false;
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
        pending = { session, preserveDraft, created: id === null, frames: [] };
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
            const { session, preserveDraft, created, frames } = confirmed;
            confirmed = null;
            activateSession(session, preserveDraft, created);
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
  function showRiskConfirmation(blocks, actions = []) {
    const operation = blocks?.find(block => block.kind === "operation")?.content;
    if (!operation) return false;
    ++confirmationRead; // A live prompt supersedes an older recovery read.
    const view = showToolCall(operation.tool_call_id, { name: operation.name });
    if (view.data.toolResultStatus === "completed") return true; // 结果已到，忽略在途的旧确认查询。
    state.awaitingConfirmation = true;
    riskView = view;
    Object.assign(riskView.data, { text: "", blocks, actions, toolResultStatus: "awaiting_confirmation" });
    riskView.toolResult.open = true;
    renderMessage(riskView);
    updateRuntime();
    return true;
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
        if (row.role === "tool" && state.toolCalls.has(row.tool_call_id)) continue;
        const view = createMessage(row.role, { text: row.content, sourceContent: row.source_content, reasoning: row.reasoning_content, reasoningDone: true, toolResultStatus: row.tool_result_status, toolName: row.tool_name || call?.name, toolArguments: call?.arguments, toolCallID: row.tool_call_id, segments: row.role === "tool" ? row.segments : null }, row.created_at);
        for (const file of (row.role === "tool" ? [] : (row.segments || []).filter(segment => segment.type === "file" || segment.type === "image"))) {
          const card = element("div", "file-card");
          card.append(element("div", "file-card-main", `${file.name || (file.type === "image" ? "图片" : "文件")} · 历史附件`));
          view.files.append(card);
        }
        if (row.role === "tool" && row.tool_call_id) state.toolCalls.set(row.tool_call_id, view);
        added.push(view);
        nodes.append(view.node);
      }
      ui.messages.prepend(nodes);
      state.messages = added.concat(previous);
      for (const view of added) renderMessage(view);
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

  return { takeReloadID, toggleSessions, renderSessions, refreshSessions, searchSessions, disconnect, bufferFrame, changeSession, loadHistory, loadConfirmation, showRiskConfirmation };
}
