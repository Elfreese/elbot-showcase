import { element } from "../core/dom.js";

// 用户消息快捷导航：常驻聊天区右侧，z-index 低于右侧栏，侧栏展开时自然被覆盖。
export function createMessageNav({ ui, state }) {
  const nav = ui["message-nav"];
  const scroll = ui["chat-scroll"];
  const entries = [];
  let refreshFrame = 0;
  let currentFrame = 0;

  function labelOf(view) {
    const line = String(view.data.text || "").split("\n").find(item => item.trim());
    return line ? line.trim() : view.files?.childElementCount ? "附件" : "空消息";
  }

  function updateCurrent() {
    // 只要消息已进入视口（顶部高于视口底部）就归为当前，不要求滚到视口顶部。
    const box = scroll.getBoundingClientRect();
    let active = entries[0];
    for (const entry of entries) {
      if (entry.view.node.getBoundingClientRect().top > box.bottom - 8) break;
      active = entry;
    }
    for (const entry of entries) {
      const current = entry === active;
      entry.button.classList.toggle("current", current);
      if (current) entry.button.setAttribute("aria-current", "true");
      else entry.button.removeAttribute("aria-current");
    }
  }

  function refresh() {
    const views = state.messages.filter(view => view.role === "user" && view.node.isConnected);
    const labels = views.map(labelOf);
    if (views.length === entries.length && views.every((view, index) => entries[index].view === view && entries[index].label === labels[index])) {
      if (entries.length) updateCurrent();
      return;
    }
    entries.length = 0;
    nav.replaceChildren();
    for (const [index, view] of views.entries()) {
      const label = labels[index];
      const button = element("button", "message-nav-item");
      button.type = "button";
      button.title = label;
      button.append(element("span", "message-nav-dot"), element("span", "message-nav-label", label));
      button.addEventListener("click", () => view.node.scrollIntoView({ block: "start", behavior: "smooth" }));
      nav.append(button);
      entries.push({ view, button, label });
    }
    nav.hidden = entries.length === 0;
    if (entries.length) updateCurrent();
  }

  new MutationObserver(() => {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
  }).observe(ui.messages, { childList: true });

  scroll.addEventListener("scroll", () => {
    if (currentFrame || !entries.length) return;
    currentFrame = requestAnimationFrame(() => { currentFrame = 0; updateCurrent(); });
  });
}
