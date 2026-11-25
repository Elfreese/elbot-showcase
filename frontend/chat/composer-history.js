// textarea 不暴露光标的视觉行。用同宽的文本按浏览器规则换行，只在方向键需要时测量。
function atEdge(input, older) {
  const { value, selectionStart: pos } = input;
  const edge = older ? 0 : value.length;
  if (pos === edge) return true;
  if ((older ? value.slice(0, pos) : value.slice(pos)).includes("\n")) return false;
  const style = getComputedStyle(input);
  const mirror = document.createElement("div");
  mirror.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box";
  for (const key of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "whiteSpace", "overflowWrap", "wordBreak", "tabSize", "direction"]) mirror.style[key] = style[key];
  mirror.style.width = `${input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`;
  const text = document.createTextNode(value + "\u200b"); // 末尾空行也有可测量的字符。
  mirror.append(text);
  document.body.append(mirror);
  const range = document.createRange();
  function line(offset) {
    range.setStart(text, offset); range.setEnd(text, offset + 1);
    return range.getBoundingClientRect().top;
  }
  const sameLine = Math.abs(line(pos) - line(edge)) < 1;
  mirror.remove();
  return sameLine;
}

export function createComposerHistory(input, loadHistory, changed, notify) {
  const drafts = new Map(); // 只存未显示会话的草稿，当前草稿留在输入框。
  let walk = null;
  function snapshot() { return { text: input.value, cursor: input.selectionStart, end: input.selectionEnd }; }
  function show(text = "", cursor = text.length, end = cursor) {
    input.value = text;
    input.setSelectionRange(cursor, end);
    changed();
  }
  function restore(draft) { show(draft?.text, draft?.cursor, draft?.end); }

  async function arrow(event) {
    const older = event.key === "ArrowUp";
    if ((!older && !walk) || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || input.selectionStart !== input.selectionEnd || !atEdge(input, older)) return;
    event.preventDefault();
    if (!walk) {
      const trip = { draft: snapshot(), index: -1, items: null };
      walk = trip;
      try {
        const { items } = await loadHistory();
        if (walk !== trip) return;
        if (!items.length || document.activeElement !== input || input.value !== trip.draft.text || input.selectionStart !== trip.draft.cursor || input.selectionEnd !== trip.draft.end) { walk = null; return; }
        trip.items = items;
      } catch (error) {
        if (walk === trip) { walk = null; if (error.name !== "AbortError") notify("WARN", error.message); }
        return;
      }
    } else if (!walk.items) {
      if (!older) walk = null;
      return;
    }
    const index = walk.index + (older ? 1 : -1);
    if (index < 0) { const { draft } = walk; walk = null; restore(draft); }
    else if (index < walk.items.length) { walk.index = index; show(walk.items[index]); }
  }

  function switchSession(from, to, created) {
    const draft = walk?.draft ?? snapshot();
    walk = null;
    if (created) { drafts.delete(from); return; } // 首条发送把输入框带到刚创建的会话。
    if (from === to) { restore(draft); return; }
    if (draft.text) drafts.set(from, draft);
    else drafts.delete(from);
    restore(drafts.get(to));
    drafts.delete(to);
  }
  return { arrow, switchSession, endWalk() { walk = null; }, reset() { walk = null; drafts.clear(); show(); } };
}
