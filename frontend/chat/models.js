import { element } from "../core/dom.js";

export function createModels({ ui, state, api, refreshStatus, addNotice }) {
  let timer;
  function hideModels() {
    ui["model-popover"].hidden = true;
    ui["model-button"].setAttribute("aria-expanded", "false");
    state.modelQuery++;
    clearTimeout(timer);
  }

  async function searchModels() {
    const query = ++state.modelQuery;
    ui["model-list"].replaceChildren(element("div", "model-empty", "正在获取模型…"));
    try {
      const data = await api(`/models?${new URLSearchParams({ query: ui["model-search"].value })}`);
      if (query !== state.modelQuery || ui["model-popover"].hidden) return;
      ui["model-list"].replaceChildren();
      for (const item of data.items) {
        const current = state.currentModel === `${item.provider}/${item.model}`;
        const button = element("button", `model-option${current ? " current" : ""}`);
        button.type = "button";
        const label = element("span", "", item.model);
        label.append(element("small", "", item.provider));
        button.append(label, element("span", "", current ? "✓" : ""));
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const result = await api("/models/selection", { method: "PUT", body: { target: "current", provider: item.provider, model: item.model } });
            if (query !== state.modelQuery) return;
            state.currentModel = `${result.model.provider}/${result.model.model}`;
            hideModels();
            await refreshStatus();
            if (state.visible) ui["message-input"].focus();
          } catch (error) { addNotice("WARN", error.message); }
          finally { button.disabled = false; }
        });
        ui["model-list"].append(button);
      }
      if (!data.items.length) ui["model-list"].append(element("div", "model-empty", "没有可选模型"));
      for (const item of data.errors) ui["model-list"].append(element("p", "model-empty error", `${item.id}：${item.error?.message || "获取失败"}`));
    } catch (error) {
      if (query === state.modelQuery) ui["model-list"].replaceChildren(element("div", "model-empty error", error.message));
    }
  }

  ui["model-search"].addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(searchModels, 180);
  });
  return { hideModels, searchModels };
}
