import { element } from "../core/dom.js";

export function createQuestions({ ui, state, api, notify, updateTitle }) {
  const panel = ui["question-panel"], body = ui["question-body"], feedback = ui["question-feedback"];
  const prev = ui["question-prev"], next = ui["question-next"], send = ui["question-send"];
  let session, items, page, edits, queued, busy, dismissedThrough, query = 0;
  const path = () => `/sessions/${encodeURIComponent(session)}/questions`;

  function reset(id = "") {
    query++;
    session = id; items = []; page = 0; edits = new Map(); queued = new Set(); busy = false;
    dismissedThrough = 0;
    feedback.textContent = "";
    render();
    if (id) refresh();
  }

  async function refresh(releaseQueued = false) {
    if (!session || !state.ready) return;
    const version = ++query, local = edits;
    // Preserve drafts edited or written while the GET is in flight.
    const drafts = new Map(items.map(q => [q.id, q.draft]));
    const protectedIDs = new Set(local.keys());
    try {
      const { items: rows } = await api(path(), { signal: state.http.signal });
      if (version !== query) return;
      const current = items[page]?.id, preview = items.length && page === items.length;
      const updated = rows.map(q => {
        const old = items.find(item => item.id === q.id);
        return old && (protectedIDs.has(q.id) || local.has(q.id) || old.draft !== drafts.get(q.id)) ? old : q;
      });
      const changed = JSON.stringify(updated) !== JSON.stringify(items);
      const unqueued = releaseQueued && queued.size > 0;
      if (unqueued) queued.clear();
      if (!changed) { if (unqueued && preview) render(); return; }
      items = updated;
      page = preview ? items.length : Math.max(0, items.findIndex(q => q.id === current));
      render();
    } catch (error) { if (version === query) notify("WARN", error.message); }
  }

  function controls() {
    panel.disabled = busy || !state.ready || state.navigating || state.recoveryBlocked;
  }

  function edit(q, choice, text) {
    const draft = { ...(choice ? { choice } : {}), text };
    if (draft.choice === q.draft?.choice && text === (q.draft?.text ?? "")) edits.delete(q.id);
    else edits.set(q.id, draft);
    feedback.textContent = "";
  }

  async function flush() {
    const local = edits;
    for (const [id, draft] of local) {
      const q = items.find(q => q.id === id);
      if (!q || (!draft.choice && !draft.text.trim() && !q.draft)) { local.delete(id); continue; }
      if (!draft.choice && !draft.text.trim()) throw new Error("自由回答不能为空");
      const saved = await api(`${path()}/${id}/draft`, { method: "PUT", body: draft, signal: state.http.signal });
      if (local !== edits) return;
      const current = items.find(q => q.id === id);
      if (current) current.draft = saved.draft;
      local.delete(id);
    }
  }

  function render() {
    if (dismissedThrough) {
      const firstNew = items.findIndex(q => q.id > dismissedThrough);
      if (firstNew !== -1) { page = firstNew; dismissedThrough = 0; }
    }
    panel.hidden = !items.length || dismissedThrough > 0;
    state.needsAnswer = items.some(q => !queued.has(q.id));
    updateTitle();
    body.replaceChildren();
    if (panel.hidden) return;
    const preview = page === items.length;
    ui["question-page"].textContent = preview ? "回答预览" : `待答题 ${page + 1} / ${items.length}`;
    prev.disabled = page === 0; next.hidden = preview; send.hidden = !preview;
    next.textContent = page === items.length - 1 ? "预览" : "下一题";
    send.disabled = !items.some(q => q.draft && !queued.has(q.id));
    if (preview) {
      for (const q of items) {
        const d = q.draft;
        const answer = d?.choice ? [q.options[d.choice - 1], d.text].filter(Boolean).join(" · ") : d?.text;
        body.append(element("strong", "", q.question), element("div", "question-answer", (queued.has(q.id) ? "已发送 · " : "") + (answer || "未答")));
      }
    } else {
      const q = items[page], draft = edits.get(q.id) ?? q.draft;
      let choice = draft?.choice;
      const options = element("div", "question-options"), text = element("textarea");
      text.rows = 1; text.value = draft?.text ?? "";
      const select = () => {
        [...options.children].forEach((button, i) => button.setAttribute("aria-pressed", String(i + 1 === choice || (!choice && i === q.options.length))));
        text.placeholder = choice ? "补充（可选）" : "自由回答";
        text.setAttribute("aria-label", text.placeholder);
      };
      [...q.options, "自由回答"].forEach((label, i) => {
        const button = element("button", "", label); button.type = "button";
        button.onclick = () => {
          choice = i < q.options.length ? i + 1 : undefined;
          select(); edit(q, choice, text.value);
          if (!choice) text.focus();
        };
        options.append(button);
      });
      select(); text.oninput = () => edit(q, choice, text.value);
      body.append(element("strong", "", q.question), options, text);
    }
    body.scrollTop = 0;
    controls();
  }

  async function advance(step, submit = false) {
    const local = edits;
    const submittedThrough = submit ? Math.max(...items.map(q => q.id)) : 0;
    busy = true; controls();
    try {
      await flush();
      if (local !== edits) return;
      if (submit) {
        const { question_ids } = await api(`${path()}/confirm`, { method: "POST", signal: state.http.signal });
        if (local !== edits) return;
        for (const id of question_ids) queued.add(id);
        dismissedThrough = submittedThrough;
        feedback.textContent = "";
        render();
        await refresh();
        return;
      } else { page = Math.max(0, Math.min(items.length, page + step)); feedback.textContent = ""; }
      if (local === edits) render();
    } catch (error) { if (local === edits) feedback.textContent = error.message; }
    finally { if (local === edits) { busy = false; controls(); } }
  }
  ui["question-cancel"].onclick = () => {
    dismissedThrough = Math.max(...items.map(q => q.id));
    edits.clear();
    feedback.textContent = "";
    render();
  };
  function open() { dismissedThrough = 0; render(); return refresh(); }
  prev.onclick = () => advance(-1); next.onclick = () => advance(1); send.onclick = () => advance(0, true);
  reset();
  return { reset, refresh, controls, open };
}
