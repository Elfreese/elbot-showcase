export function registerChatShortcuts(ui, jumpTo, openHistory) {
  const input = ui["message-input"];
  let lastG = -Infinity;
  let focusKey = null;

  document.addEventListener("keydown", event => {
    const { key, target, timeStamp } = event;
    const doubleG = timeStamp - lastG <= 700;
    lastG = -Infinity;

    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key.toLowerCase() === "r" &&
        !event.defaultPrevented && !event.isComposing && !ui["chat-page"].hidden && !input.disabled &&
        (target === input || (event.repeat && target === ui["picker-search"]))) {
      event.preventDefault();
      if (!event.repeat) openHistory();
      return;
    }

    // 聚焦后，按住的 Enter 不能变成输入框收到的发送键。
    if (event.repeat) {
      if (target === input && key === focusKey) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    focusKey = null;
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
        (event.shiftKey && key !== "G") || ui["chat-page"].hidden || !ui["search-picker"].hidden || !ui["preload-menu"].hidden ||
        !(target instanceof Element) || target.isContentEditable || target.closest("input, textarea, select") ||
        document.querySelector("dialog[open]")) return;

    if (key === "i" || key === "Enter") {
      if (input.disabled || (key === "Enter" && target.closest("button, a[href], summary, [role=button], [role=link]"))) return;
      event.preventDefault();
      focusKey = key;
      input.focus();
    } else if (key === "G") {
      event.preventDefault();
      jumpTo("bottom");
    } else if (key === "g") {
      if (doubleG) {
        event.preventDefault();
        jumpTo("top");
      } else lastG = timeStamp;
    }
  }, true);
}
