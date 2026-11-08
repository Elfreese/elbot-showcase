import { element } from "../core/dom.js";
import { createProviderEntry, createModelDraft, createPayloadDraft, readPayload, readProviderDraft } from "./settings-editor.js";

function button(text, action, edit = false) {
  const node = element("button", "action-button", text);
  node.type = "button";
  if (edit) node.dataset.edit = "";
  node.addEventListener("click", action);
  return node;
}

function field(text, input) {
  const label = element("label", "", text);
  input.dataset.edit = "";
  label.append(input);
  return label;
}

function createPayloadEditor(draft, onChange, writable) {
  const host = element("section", "payload-editor");
  host.dataset.field = "extra_payload";
  const heading = element("div", "provider-section-heading");
  heading.append(element("h3", "", "额外参数"));
  const actions = element("div", "form-actions");
  const tableTab = button("表格", () => switchMode("table"));
  const jsonTab = button("JSON", () => switchMode("json"));
  tableTab.dataset.view = ""; jsonTab.dataset.view = "";
  actions.append(tableTab, jsonTab);
  heading.append(actions);
  const body = element("div");
  const feedback = element("p", "payload-feedback error");
  feedback.setAttribute("role", "status");
  host.append(heading, body, feedback);

  function changed() {
    draft.changed = true;
    feedback.textContent = "";
    onChange();
  }

  function failure(error) {
    feedback.textContent = error.message;
    const control = draft.mode === "json" ? body.querySelector("textarea") : body.querySelector(`[data-row="${error.row ?? 0}"] input`);
    control?.focus();
  }

  function switchMode(mode) {
    if (mode === draft.mode) return;
    try {
      const next = createPayloadDraft(readPayload(draft));
      draft.rows = next.rows; draft.json = next.json; draft.mode = mode;
      render();
    } catch (error) { failure(error); }
  }

  function render() {
    body.replaceChildren(); feedback.textContent = "";
    tableTab.classList.toggle("current", draft.mode === "table");
    jsonTab.classList.toggle("current", draft.mode === "json");
    tableTab.setAttribute("aria-pressed", String(draft.mode === "table"));
    jsonTab.setAttribute("aria-pressed", String(draft.mode === "json"));
    if (draft.mode === "json") {
      const input = element("textarea", "payload-json");
      input.value = draft.json; input.rows = 7; input.spellcheck = false;
      input.disabled = !writable; input.dataset.edit = "";
      input.setAttribute("aria-label", "额外参数 JSON");
      input.addEventListener("input", () => { draft.json = input.value; changed(); });
      const format = button("格式化", () => {
        try { draft.json = JSON.stringify(readPayload(draft), null, 2); input.value = draft.json; feedback.textContent = ""; }
        catch (error) { failure(error); }
      });
      format.dataset.view = "";
      body.append(input, format);
      return;
    }
    draft.rows.forEach((row, index) => {
      const line = element("div", "payload-row"); line.dataset.row = String(index);
      const key = element("input"); key.value = row.key; key.placeholder = "参数名";
      key.setAttribute("aria-label", "参数名");
      key.addEventListener("input", () => { row.key = key.value; changed(); });
      const type = element("select"); type.setAttribute("aria-label", "参数类型");
      for (const [value, label] of [["string", "文本"], ["number", "数字"], ["boolean", "布尔"], ["object", "对象"], ["array", "数组"]]) {
        const option = element("option", "", label); option.value = value; type.append(option);
      }
      type.value = row.type;
      type.addEventListener("change", () => {
        row.type = type.value;
        row.text = ({ string: "", number: "0", boolean: "true", object: "{}", array: "[]" })[row.type];
        changed(); render();
      });
      const value = element(row.type === "boolean" ? "select" : "textarea");
      value.setAttribute("aria-label", "参数值");
      if (row.type === "boolean") for (const item of ["true", "false"]) {
        const option = element("option", "", item); option.value = item; value.append(option);
      }
      else { value.rows = ["object", "array"].includes(row.type) ? 3 : 1; value.spellcheck = false; }
      value.value = row.text;
      value.addEventListener("input", () => { row.text = value.value; changed(); });
      const remove = button("移除", () => { draft.rows.splice(index, 1); changed(); render(); }, true);
      for (const control of [key, type, value, remove]) { control.disabled = !writable; control.dataset.edit = ""; }
      line.append(key, type, value, remove); body.append(line);
    });
    const add = button("添加参数", () => {
      draft.rows.push({ key: "", type: "string", text: "" });
      changed(); render();
      body.querySelector(`[data-row="${draft.rows.length - 1}"] input`)?.focus();
    }, true);
    add.disabled = !writable; body.append(add);
  }
  render();
  return host;
}

export function createProviderForm({ container, state, api, onChange, onSave, writable }) {
  const host = element("div", "provider-manager");
  const list = element("div", "provider-list"); list.setAttribute("aria-label", "Providers");
  const defaults = element("div", "provider-defaults");
  const fallback = element("input");
  fallback.type = "number"; fallback.min = "1"; fallback.step = "1";
  fallback.value = state.defaultWindow; fallback.placeholder = "256000";
  fallback.addEventListener("input", () => { state.defaultWindow = fallback.value; changed(); });
  defaults.append(field("默认窗口 / tokens", fallback));
  const detail = element("div", "provider-detail"); host.append(list, defaults, detail); container.append(host);
  let alive = true;
  let controller = null;
  let modelList = null;
  let modelDetail = null;
  let catalogFeedback = null;
  let busy = false;

  function changed() { state.changed = true; onChange(); }

  function renderList() {
    const add = button("新增", () => {
      const draft = createProviderEntry(); state.providers.push(draft);
      changed(); show(draft); detail.querySelector('[name="name"]')?.focus();
    }, true);
    list.replaceChildren(add);
    for (const draft of state.providers) {
      const item = button(draft.name.trim() || "新 Provider", () => show(draft));
      item.className = `provider-choice${state.selected === draft ? " current" : ""}`;
      item.setAttribute("aria-pressed", String(state.selected === draft)); list.append(item);
    }
    setBusy(busy);
  }

  function origin(draft) { return draft.originalName === null ? {} : state.values.providers[draft.originalName]; }
  function model(draft, name) {
    if (!draft.models.has(name)) draft.models.set(name, createModelDraft(name, origin(draft)));
    return draft.models.get(name);
  }

  function renderModelList(draft) {
    const automatic = new Set((state.catalog?.items || []).filter(item => item.provider === (draft.originalName ?? draft.name.trim())).map(item => item.model));
    const names = [...new Set([...automatic, ...draft.models.keys()])];
    const query = draft.modelQuery.toLowerCase();
    const items = [];
    for (const name of names) {
      if (!name.toLowerCase().includes(query)) continue;
      const item = draft.models.get(name);
      const configured = item && (item.context !== "" || item.payload.rows.length || item.payload.mode === "json" && item.payload.json.trim() !== "{}" || !item.clear && !!origin(draft).model_configs?.[name]);
      const choice = button("", () => { draft.selectedModel = name; model(draft, name); renderModelList(draft); renderModel(draft); });
      choice.className = `model-choice${draft.selectedModel === name ? " current" : ""}`;
      choice.setAttribute("aria-pressed", String(draft.selectedModel === name));
      choice.append(element("span", "model-name", name));
      const badges = element("span", "model-badges");
      if (automatic.has(name)) badges.append(element("small", "", "运行列表"));
      if (item?.supplement) badges.append(element("small", "", "手动补充"));
      if (configured) badges.append(element("small", "", "独立配置"));
      choice.append(badges); items.push(choice);
    }
    modelList.replaceChildren(...items);
    if (!items.length) modelList.append(element("p", "muted", query ? "无匹配模型" : "暂无模型，可手动补充"));
  }

  function renderModel(draft) {
    modelDetail.replaceChildren();
    if (!draft.selectedModel) { modelDetail.append(element("p", "muted", "选择模型编辑参数")); return; }
    const item = model(draft, draft.selectedModel);
    modelDetail.append(element("h3", "model-name", item.name));
    const supplement = element("input"); supplement.type = "checkbox"; supplement.checked = item.supplement; supplement.dataset.edit = "";
    supplement.addEventListener("change", () => { item.supplement = supplement.checked; changed(); renderModelList(draft); });
    const label = element("label", "checkbox-field"); label.append(supplement, document.createTextNode("手动补充"));
    const context = element("input"); context.type = "number"; context.min = "1"; context.step = "1";
    context.value = item.context; context.placeholder = "自动"; context.name = "context_window";
    context.addEventListener("input", () => { item.context = context.value; changed(); renderModelList(draft); });
    modelDetail.append(label, field("回退窗口 / tokens", context), element("p", "muted provider-hint", "接口值优先，留空自动"));
    modelDetail.append(createPayloadEditor(item.payload, () => { changed(); renderModelList(draft); }, writable));
    const clear = button("清除配置", () => {
      if (!confirm(`清除「${item.name}」的独立配置？手动补充保留。`)) return;
      item.clear = true; item.context = ""; item.payload = createPayloadDraft();
      changed(); renderModelList(draft); renderModel(draft);
    }, true);
    modelDetail.append(clear); setBusy(busy);
  }

  function renderCatalog() {
    const draft = state.selected;
    if (!draft || !catalogFeedback) return;
    const errors = (state.catalog?.errors || []).filter(item => item.id === (draft.originalName ?? draft.name.trim()) && item.error);
    catalogFeedback.textContent = state.catalogError || errors.map(item => item.error.message).join(" · ") || (state.catalog ? "当前运行配置的模型列表" : "读取模型…");
    catalogFeedback.classList.toggle("error", !!state.catalogError || !!errors.length);
    renderModelList(draft);
  }

  async function loadCatalog() {
    controller?.abort(); const request = new AbortController(); controller = request;
    try {
      const data = await api("/models", { signal: request.signal });
      if (!alive || controller !== request) return;
      state.catalog = data; state.catalogError = ""; renderCatalog();
    } catch (error) {
      if (!alive || controller !== request || error.name === "AbortError") return;
      state.catalogError = error.message; renderCatalog();
    }
  }

  function show(draft) {
    state.selected = draft; renderList(); detail.replaceChildren();
    if (!draft) { detail.append(element("p", "muted", "暂无 Provider")); return; }
    const form = element("form", "provider-form");
    form.addEventListener("submit", event => { event.preventDefault(); onSave(); });
    const basic = element("div", "form-grid");
    for (const [key, text, placeholder] of [["name", "名称", "Provider ID"], ["base_url", "Base URL", "https://example.com/v1"], ["api_key_env", "密钥变量名", "PROVIDER_API_KEY"], ["proxy", "代理", "http://… 或 socks5://…"]]) {
      const input = element("input"); input.name = key; input.value = draft[key]; input.placeholder = placeholder; input.autocomplete = "off";
      if (key === "name") input.readOnly = draft.originalName !== null;
      input.addEventListener("input", () => { draft[key] = input.value; changed(); if (key === "name") renderList(); });
      basic.append(field(text, input));
    }
    const protocol = element("select"); protocol.name = "api_mode";
    for (const [value, text] of [["chat", "Chat Completions"], ["response", "Responses"]]) {
      const option = element("option", "", text); option.value = value; protocol.append(option);
    }
    protocol.value = draft.api_mode;
    protocol.addEventListener("change", () => { draft.api_mode = protocol.value; changed(); });
    basic.append(field("协议", protocol));
    const remove = button("删除 Provider", () => {
      if (!confirm(`从草稿删除 Provider「${draft.name || "新 Provider"}」？`)) return;
      state.providers.splice(state.providers.indexOf(draft), 1); changed(); show(state.providers[0] || null);
    }, true);
    remove.classList.add("danger"); form.append(basic, remove, createPayloadEditor(draft.payload, changed, writable));
    const models = element("section", "provider-models");
    const heading = element("div", "provider-section-heading");
    heading.append(element("h3", "", "模型"), button("刷新列表", loadCatalog));
    catalogFeedback = element("p", "provider-hint muted"); catalogFeedback.setAttribute("role", "status");
    const search = element("input"); search.type = "search"; search.value = draft.modelQuery;
    search.placeholder = "搜索模型"; search.setAttribute("aria-label", "搜索模型");
    search.addEventListener("input", () => { draft.modelQuery = search.value; renderModelList(draft); });
    const addRow = element("div", "model-add");
    const name = element("input"); name.placeholder = "模型 ID"; name.setAttribute("aria-label", "补充模型 ID"); name.dataset.edit = "";
    const add = button("补充", () => {
      const id = name.value.trim(); name.setCustomValidity(id ? "" : "请输入模型 ID");
      if (!name.reportValidity()) return;
      const item = model(draft, id); item.supplement = true;
      draft.selectedModel = id; draft.modelQuery = ""; search.value = ""; name.value = "";
      changed(); renderModelList(draft); renderModel(draft);
    }, true);
    name.addEventListener("input", () => name.setCustomValidity(""));
    name.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); add.click(); } });
    addRow.append(name, add);
    const layout = element("div", "provider-model-layout");
    modelList = element("div", "provider-model-list"); modelList.setAttribute("aria-label", "模型列表");
    modelDetail = element("div", "provider-model-editor"); layout.append(modelList, modelDetail);
    models.append(heading, catalogFeedback, search, addRow, layout); form.append(models); detail.append(form);
    renderCatalog(); renderModel(draft); setBusy(busy);
  }

  function setBusy(value) {
    busy = value;
    for (const control of host.querySelectorAll("[data-edit]")) control.disabled = !writable || busy;
    for (const control of host.querySelectorAll("[data-view]")) control.disabled = busy;
  }

  show(state.selected);
  if (!state.catalog) loadCatalog();
  return {
    flush() {
      try {
        if (!fallback.reportValidity()) throw new Error("默认窗口须为正整数");
        return readProviderDraft(state);
      }
      catch (error) {
        if (error.provider) {
          if (error.model) error.provider.selectedModel = error.model;
          show(error.provider);
          const scope = error.model ? modelDetail : detail;
          const payload = scope.querySelector('[data-field="extra_payload"]');
          const input = error.field === "extra_payload" ? payload.querySelector(error.row === undefined ? "textarea, input, button" : `[data-row="${error.row}"] input`) : scope.querySelector(`[name="${error.field}"]`);
          input?.focus();
          const local = scope.querySelector(".payload-feedback");
          if (error.field === "extra_payload" && local) local.textContent = error.message;
        } else fallback.focus();
        throw error;
      }
    },
    setBusy,
    setCatalog(data) { controller?.abort(); controller = null; state.catalog = data; state.catalogError = ""; renderCatalog(); },
    destroy() { alive = false; controller?.abort(); },
  };
}
