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

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.title = "已复制";
  } catch {
    button.title = "无法访问剪贴板，请手动复制";
  }
  setTimeout(() => { button.title = button.getAttribute("aria-label") || "复制"; }, 1500);
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
