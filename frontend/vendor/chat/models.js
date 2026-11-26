export function openModelPicker({ picker, ui, state, api, refreshStatus }) {
  picker.open({
    title: "选择模型", placeholder: "模型 / 提供方", hint: "使用当前模式的模型",
    loading: "正在获取模型…", empty: "没有可选模型", delay: 300,
    trigger: ui["model-button"], focusAfterSelect: ui["message-input"],
    async search(query, signal) {
      const data = await api(`/models?${new URLSearchParams({ query })}`, { signal });
      return {
        items: data.items.map(item => ({ value: item, label: item.model, detail: item.provider, current: state.currentModel === `${item.provider}/${item.model}` })),
        errors: data.errors.map(item => `${item.id}：${item.error}`),
      };
    },
    async select({ value: { provider, model } }, signal) {
      const result = await api("/models/selection", { method: "PUT", body: { target: "current", provider, model } });
      if (signal.aborted) return;
      state.currentModel = `${result.model.provider}/${result.model.model}`;
      await refreshStatus();
    },
  });
}
