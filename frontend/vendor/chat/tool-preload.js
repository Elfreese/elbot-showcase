import { element } from "../core/dom.js";

export function createToolPreload({ ui, api, requestCompletion }) {
  const button = ui["preload-button"], menu = ui["preload-menu"], list = ui["preload-list"];
  const search = ui["preload-search"], empty = ui["preload-empty"];
  const recentBar = ui["preload-recent"];
  const selected = new Map(); // 指令去重；只有从标签入口选中时，值才是标签名。
  let request, storageKey = "", recent = [];

  function syncSelection() {
    ui["preload-label"].textContent = selected.size ? `预载 (${selected.size})` : "预载";
    for (const box of list.querySelectorAll("input")) box.checked = selected.has(box.value);
    for (const chip of recentBar.children) chip.setAttribute("aria-pressed", String(selected.has(chip.value)));
  }

  function select(directive, tag, checked) {
    if (checked) selected.set(directive, tag);
    else selected.delete(directive);
    syncSelection();
  }

  function renderRecent() {
    recentBar.replaceChildren(...recent.map(name => {
      const chip = element("button", "preload-tag", name);
      chip.type = "button";
      chip.title = name;
      chip.value = `@tool:${name}`;
      chip.addEventListener("click", () => select(chip.value, name, !selected.has(chip.value)));
      return chip;
    }));
    recentBar.hidden = !recent.length;
  }

  function setAccount(account) {
    storageKey = account && `elbot.preload.recentTags.${account}`;
    recent = [];
    if (storageKey) {
      try {
        const names = JSON.parse(localStorage.getItem(storageKey) || "[]");
        if (Array.isArray(names)) recent = names.filter(name => typeof name === "string" && name).slice(0, 3);
      } catch { /* 存储不可用时只在本次页面中记忆。 */ }
    }
    renderRecent();
    syncSelection();
  }

  function clear() { selected.clear(); close(); syncSelection(); }

  function sent() {
    const used = [...selected.values()].filter(Boolean).reverse();
    if (storageKey && used.length) {
      recent = [...new Set([...used, ...recent])].slice(0, 3);
      try { localStorage.setItem(storageKey, JSON.stringify(recent)); } catch { /* 保留内存中的记录。 */ }
      renderRecent();
    }
    clear();
  }

  function close() {
    if (menu.hidden) return;
    request.abort();
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    list.replaceChildren();
  }

  function filterList() {
    const term = search.value.trim().toLowerCase();
    let visible = false;
    for (const group of list.children) {
      let matched = false;
      for (const row of group.querySelectorAll(".preload-choice")) {
        row.hidden = !row.textContent.toLowerCase().includes(term) && !row.title.toLowerCase().includes(term);
        if (!row.hidden) matched = true;
      }
      // 加载中或读取失败的分组继续显示状态，不当作无匹配。
      group.hidden = !!term && group.hasAttribute("data-loaded") && !matched;
      if (!group.hidden) visible = true;
    }
    empty.hidden = !term || visible;
  }
  search.addEventListener("input", filterList);
  button.addEventListener("click", async () => {
    if (!menu.hidden) { close(); return; }
    request = new AbortController();
    const { signal } = request;
    button.setAttribute("aria-expanded", "true");
    list.replaceChildren();
    menu.hidden = false;
    search.value = "";
    empty.hidden = true;
    search.focus();
    await Promise.all([["tag", "标签"], ["tool", "工具"], ["skill", "技能"]].map(async ([kind, title]) => {
      const group = element("div", "preload-group");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", title);
      const status = element("p", "picker-empty", `正在读取${title}…`);
      group.append(element("div", "preload-heading", title), status);
      list.append(group);
      try {
        // 标签与工具共用 @tool: 语法；使用补全返回的可用标签，包括配置中的标签。
        const prefix = "@tool:";
        const items = kind === "tag"
          ? (await requestCompletion(prefix, prefix.length)).filter(item => item.Kind === "tool_tag_directive")
              .map(item => ({ name: item.Text.slice(prefix.length), description: item.Description, directive: item.Text }))
          : (await api(`/tools?scope=available&kind=${kind}`, { signal })).items
              .map(({ Definition: { Name, Description } }) => ({ name: Name, description: Description, directive: `@${kind}:${Name}` }));
        if (signal.aborted) return;
        group.setAttribute("data-loaded", "");
        if (items.length) status.remove();
        else status.textContent = `没有可预载的${title}`;
        for (const { name, description, directive } of items) {
          const row = element("label", "preload-choice");
          row.title = description;
          const box = element("input");
          box.type = "checkbox";
          box.value = directive;
          if (kind === "tag") box.dataset.tag = name;
          box.checked = selected.has(box.value);
          row.append(box, element("span", "", name));
          group.append(row);
        }
        filterList();
      } catch (error) {
        if (!signal.aborted) { status.textContent = error.message; status.classList.add("error"); }
      }
    }));
  });

  list.addEventListener("change", ({ target }) => select(target.value, target.dataset.tag, target.checked));
  menu.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      button.focus();
    } else if (event.key === "Enter") {
      event.preventDefault(); // 选择工具不能提交外层消息表单。
      if (!event.repeat && event.target.type === "checkbox") event.target.click();
    }
  });
  function dismissOutside({ target }) {
    if (!menu.hidden && !menu.contains(target) && !button.contains(target) && !recentBar.contains(target)) close();
  }
  document.addEventListener("pointerdown", dismissOutside);
  document.addEventListener("focusin", dismissOutside);

  return {
    close, clear, sent, setAccount,
    withText(text) {
      if (!selected.size) return text;
      const tags = [...selected.keys()].join(" ");
      return text ? `${tags}\n${text}` : tags;
    },
  };
}
