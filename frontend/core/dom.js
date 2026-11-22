export function escapeHTML(text) {
  const element = document.createElement("span");
  element.textContent = text;
  return element.innerHTML;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function iconButton(name, label, action) {
  const button = element("button", "icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", action);
  return button;
}

// execCommand 虽已废弃，但不受 secure context 限制，局域网 http 访问时作为保底。
function legacyCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  const selection = document.getSelection();
  const previous = selection?.rangeCount ? selection.getRangeAt(0) : null;
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  area.remove();
  if (previous) { selection.removeAllRanges(); selection.addRange(previous); }
  return copied;
}

// 只负责写入剪贴板并返回结果；反馈由调用方通过 clipboard 决定。
export async function copyText(text, button) {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); copied = true; } catch { copied = false; }
  }
  if (!copied) copied = legacyCopy(text);
  button.title = copied ? "已复制" : "复制失败";
  setTimeout(() => { button.title = button.getAttribute("aria-label") || "复制"; }, 1500);
  return copied;
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
