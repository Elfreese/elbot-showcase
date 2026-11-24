import { element } from "./dom.js";

// Both searches share one panel. Closing it invalidates its requests and drops its results.
export function createSearchPicker(ui) {
  const panel = ui["search-picker"], input = ui["picker-search"], list = ui["picker-list"];
  let mode, controller, timer, version = 0, index = -1, options = [];

  function clearList() {
    options = [];
    index = -1;
    input.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    list.scrollTop = 0;
  }

  function close() {
    if (!mode) return;
    clearTimeout(timer);
    controller.abort();
    version++;
    mode.trigger?.setAttribute("aria-expanded", "false");
    mode = null;
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.value = "";
    clearList();
  }

  function highlight(next) {
    if (index >= 0) list.children[index].setAttribute("aria-selected", "false");
    index = next;
    const option = list.children[next];
    option.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }

  async function choose(i) {
    if (input.readOnly || i < 0) return;
    const { signal } = controller;
    const { select, focusAfterSelect } = mode;
    input.readOnly = true;
    try {
      await select(options[i], signal);
      if (signal.aborted) return;
      close();
      focusAfterSelect.focus();
    } catch (error) {
      if (!signal.aborted) ui["picker-hint"].textContent = error.message;
    } finally {
      if (!signal.aborted) input.readOnly = false;
    }
  }

  function search(delay = 0) {
    const request = ++version;
    clearTimeout(timer);
    clearList();
    list.append(element("div", "picker-empty", mode.loading));
    async function load() {
      try {
        const { items, errors = [] } = await mode.search(input.value, controller.signal);
        if (request !== version) return;
        options = items;
        list.replaceChildren();
        items.forEach((item, i) => {
          const button = element("button", `picker-option${item.current ? " current" : ""}`);
          button.type = "button";
          button.tabIndex = -1;
          button.id = `picker-option-${i}`;
          button.setAttribute("role", "option");
          button.setAttribute("aria-selected", "false");
          const label = element("span", "picker-label", item.label);
          if (item.detail) label.append(element("small", "", item.detail));
          button.append(label);
          if (item.current) button.append(element("span", "", "✓"));
          button.addEventListener("click", () => choose(i));
          list.append(button);
        });
        if (items.length) highlight(0);
        else list.append(element("div", "picker-empty", mode.empty));
        for (const message of errors) list.append(element("p", "picker-empty error", message));
      } catch (error) {
        if (request === version) list.replaceChildren(element("div", "picker-empty error", error.message));
      }
    }
    if (delay) timer = setTimeout(load, delay);
    else load();
  }

  function open(config) {
    close();
    mode = config;
    controller = new AbortController();
    panel.hidden = false;
    ui["picker-title"].textContent = mode.title;
    ui["picker-hint"].textContent = mode.hint;
    input.placeholder = mode.placeholder;
    input.readOnly = false;
    input.setAttribute("aria-expanded", "true");
    mode.trigger?.setAttribute("aria-expanded", "true");
    input.focus();
    search();
  }

  input.addEventListener("input", () => search(mode.delay));
  panel.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const target = mode.trigger || mode.focusAfterSelect;
      close();
      target.focus();
    } else if (event.key === "Enter") {
      event.preventDefault(); // The picker lives inside the composer form.
      if (!event.repeat) choose(index);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length) highlight((index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    }
  });
  function dismissOutside(event) {
    if (mode && !panel.contains(event.target) && !mode.trigger?.contains(event.target)) close();
  }
  document.addEventListener("pointerdown", dismissOutside);
  document.addEventListener("focusin", dismissOutside);
  return { open, close };
}
