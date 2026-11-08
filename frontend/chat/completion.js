import { element } from "../core/dom.js";

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


export function createCompletion({ ui, state, connection, resizeInput, updateControls, addNotice }) {
  function requestCompletion(text, cursor) {
    if (!state.ready) return Promise.reject(new Error("请先连接 ElBot"));
    const id = `c-${++state.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.completions.delete(id); reject(new Error("补全请求超时")); }, 5000);
      state.completions.set(id, { resolve, reject, timer });
      connection.send({ type: "complete", id, text, cursor });
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

  function clearCompletions() {
    for (const entry of state.completions.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("连接已断开"));
    }
    state.completions.clear();
    hideCompletion();
  }

  return { requestCompletion, settleCompletion, hideCompletion, applySelectedCompletion, renderCompletion, completeInput, clearCompletions };
}
