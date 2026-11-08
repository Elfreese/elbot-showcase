import { element } from "../core/dom.js";
import { createConfigurationEditor, readTOML, patchTOML, runtimeFields, setField, createProviderDraft, readProviderDraft } from "./settings-editor.js";
import { createProviderForm } from "./settings-providers.js";

export function createSettingsPage({ ui, api }) {
  const host = ui["settings-page"];
  host.innerHTML = `
    <div class="management-heading"><div><h1>设置</h1><p>保存 → 诊断 → 重启</p></div>
      <div class="form-actions"><button type="button" class="action-button" data-check title="检查已保存的配置">诊断</button><button type="button" class="action-button" data-restart>重启</button></div>
    </div>
    <p class="page-feedback" role="status"></p>
    <div class="settings-layout">
      <aside class="surface configuration-files" aria-label="配置文件"></aside>
      <section class="surface configuration-editor">
        <div class="editor-heading"><div><h2 data-filename>选择配置文件</h2><span class="muted" data-dirty></span></div>
          <div class="form-actions"><button type="button" class="action-button" data-reload disabled>重载</button><button type="button" class="action-button" data-apply hidden>重新应用</button><button type="button" class="action-button" data-save-only hidden>仅保存</button><button type="button" class="action-button" data-save disabled>保存</button></div>
        </div>
        <div class="editor-tabs" role="group" aria-label="编辑方式"><button type="button" class="action-button" data-mode="form">表单</button><button type="button" class="action-button" data-mode="raw">原文</button></div>
        <div class="provider-application" role="status" hidden></div>
        <div class="configuration-form"></div>
        <label class="raw-editor" hidden><span class="visually-hidden">配置文件原文</span><textarea rows="20" spellcheck="false" autocomplete="off"></textarea></label>
      </section>
    </div>
    <section class="surface configuration-diagnostics" hidden><h2>配置诊断</h2><div data-issues></div></section>`;
  const feedback = host.querySelector(".page-feedback");
  const fileList = host.querySelector(".configuration-files");
  const filename = host.querySelector("[data-filename]");
  const dirty = host.querySelector("[data-dirty]");
  const formContainer = host.querySelector(".configuration-form");
  const rawContainer = host.querySelector(".raw-editor");
  const raw = rawContainer.querySelector("textarea");
  const save = host.querySelector("[data-save]");
  const saveOnly = host.querySelector("[data-save-only]");
  const apply = host.querySelector("[data-apply]");
  const application = host.querySelector(".provider-application");
  const reload = host.querySelector("[data-reload]");
  const check = host.querySelector("[data-check]");
  const restart = host.querySelector("[data-restart]");
  const diagnostics = host.querySelector(".configuration-diagnostics");
  const issues = host.querySelector("[data-issues]");
  const editor = createConfigurationEditor({ api });
  let entries = [];
  let current = null;
  let mode = "form";
  let selected = "";
  let loaded = false;
  let loading = false;
  let generation = 0;
  let providerForm = null;
  let applying = false;

  function report(message, error = false) {
    feedback.textContent = message;
    feedback.classList.toggle("error", error);
  }

  function update() {
    const changed = current && (current.source !== current.draft || current.providerState?.changed);
    const providers = current?.entry.path === "providers.toml";
    const busy = !!current?.saving || applying;
    dirty.textContent = current ? current.entry.writable ? changed ? "未保存" : current.create ? "未创建" : "已保存" : "只读" : "";
    save.disabled = !current || !current.entry.writable || busy || (!changed && !current.create);
    save.textContent = current?.saving ? "保存中…" : applying ? "应用中…" : providers ? "保存并应用" : "保存";
    saveOnly.hidden = !providers; saveOnly.disabled = save.disabled;
    apply.hidden = !providers; apply.disabled = !current || !current.entry.writable || busy || !!changed || current.create;
    apply.title = changed ? "先保存草稿" : "重载已保存的 Provider 配置";
    reload.disabled = !current || busy;
    raw.readOnly = !current?.entry.writable || busy;
    providerForm?.setBusy(busy);
    host.querySelector(".management-heading p").textContent = providers ? "保存并应用，无需重启" : "保存 → 诊断 → 重启";
    for (const tab of host.querySelectorAll("[data-mode]")) if (busy) tab.disabled = true;
    for (const button of fileList.querySelectorAll("button")) {
      const entry = entries.find(entry => entry.path === button.dataset.path);
      button.querySelector("small").textContent = entry.writable ? entry.exists ? "" : "可创建" : "只读";
      button.classList.toggle("current", button.dataset.path === selected);
      button.classList.toggle("has-draft", button.dataset.path === current?.entry.path && !!changed);
      button.disabled = busy;
    }
  }

  function applyEdit(edit, options = {}) {
    try {
      current.draft = patchTOML(current.draft, edit);
      raw.value = current.draft;
      report("草稿已更新，待保存");
      update();
      if (options.render !== false) renderForm();
    } catch (error) { report(error.message, true); }
  }

  function renderRuntime(values) {
    const form = element("form", "runtime-form form-grid");
    for (const field of runtimeFields) {
      const value = field.path.reduce((table, key) => table?.[key], values);
      const label = element("label", field.type === "boolean" ? "checkbox-field" : "");
      let input;
      if (field.type === "select") {
        input = element("select");
        const fallback = element("option", "", `默认（${field.fallback}）`);
        fallback.value = "";
        input.append(fallback);
        for (const choice of field.options) { const option = element("option", "", choice); option.value = choice; input.append(option); }
        input.value = value ?? "";
      } else {
        input = element("input");
        if (field.type === "boolean") {
          input.type = "checkbox";
          input.checked = value ?? field.fallback;
        } else {
          input.type = "number";
          input.min = "0";
          input.step = field.type === "ratio" ? "any" : "1";
          if (field.type === "ratio") input.max = "1";
          input.placeholder = `默认 ${field.fallback}`;
          input.value = value ?? "";
        }
      }
      input.disabled = !current.entry.writable;
      if (field.type === "boolean") label.append(input, document.createTextNode(field.label));
      else label.append(document.createTextNode(field.label), input);
      input.addEventListener("change", () => {
        if (!input.reportValidity()) return;
        const next = field.type === "boolean" ? input.checked : field.type === "select" ? input.value || undefined : input.value === "" ? undefined : input.valueAsNumber;
        applyEdit(data => setField(data, field.path, next), { render: false });
      });
      form.append(label);
    }
    form.addEventListener("submit", event => event.preventDefault());
    formContainer.append(form);
  }

  function renderForm() {
    providerForm?.destroy(); providerForm = null;
    formContainer.replaceChildren();
    if (!current || mode !== "form") return;
    try {
      const values = readTOML(current.draft);
      if (current.entry.path === "app.toml") renderRuntime(values);
      else if (current.entry.path === "providers.toml") {
        current.providerState ??= createProviderDraft(values);
        providerForm = createProviderForm({ container: formContainer, state: current.providerState, api, writable: current.entry.writable, onChange: () => { report("草稿已更新，待保存"); update(); }, onSave: () => persist(true) });
      }
    } catch (error) {
      mode = "raw";
      report(`TOML 解析失败：${error.message}`, true);
      updateMode(false);
    }
  }

  function updateMode(render = true) {
    const hasForm = current && ["app.toml", "providers.toml"].includes(current.entry.path);
    if (!hasForm) mode = "raw";
    for (const button of host.querySelectorAll("[data-mode]")) {
      button.classList.toggle("current", button.dataset.mode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
      button.disabled = !current || current.saving || applying || (button.dataset.mode === "form" && !hasForm);
    }
    formContainer.hidden = mode !== "form";
    rawContainer.hidden = mode !== "raw";
    if (render) renderForm();
  }

  async function select(entry, force = false) {
    providerForm?.destroy(); providerForm = null;
    selected = entry.path;
    current = null;
    raw.value = "";
    raw.readOnly = true;
    formContainer.replaceChildren();
    application.hidden = true;
    update();
    const version = generation;
    filename.textContent = entry.name;
    report("读取中…");
    try {
      const document = await editor.load(entry, force);
      if (version !== generation || selected !== entry.path) return;
      current = document;
      raw.value = current.draft;
      raw.readOnly = !entry.writable;
      report(entry.writable ? entry.path === "providers.toml" ? "" : "保存后需重启生效" : "文件只读");
      renderApplication();
      updateMode();
      update();
    } catch (error) {
      if (version === generation && selected === entry.path) report(error.message, true);
    }
  }

  async function load() {
    if (loaded || loading) return;
    loading = true;
    const version = generation;
    report("读取中…");
    try {
      const result = await api("/files?root=config");
      if (version !== generation) return;
      entries = result.items;
      fileList.replaceChildren();
      for (const entry of entries) {
        const button = element("button", "configuration-file", entry.name);
        button.type = "button";
        button.dataset.path = entry.path;
        button.title = entry.exists ? entry.path : `${entry.path}（尚未创建）`;
        button.append(element("small", "", entry.writable ? entry.exists ? "" : "可创建" : "只读"));
        button.addEventListener("click", () => select(entry));
        fileList.append(button);
      }
      loaded = true;
      const first = entries.find(entry => entry.path === "app.toml") || entries[0];
      if (first) await select(first);
      else report("无配置文件");
    } catch (error) { if (version === generation) report(error.message, true); }
    finally { if (version === generation) loading = false; }
  }

  async function inspect() {
    const version = generation;
    const result = await api("/configuration/check");
    if (version !== generation) return null;
    issues.replaceChildren();
    for (const issue of result.items) {
      const item = element("article", `configuration-issue level-${issue.level.toLowerCase()}`);
      item.append(element("strong", "", `${issue.level} · ${issue.topic}`), element("p", "", issue.message));
      const location = [issue.path, issue.field?.join(".")].filter(Boolean).join(" · ");
      if (location) item.append(element("code", "", location));
      issues.append(item);
    }
    if (!result.items.length) issues.append(element("p", "", "配置正常"));
    diagnostics.hidden = false;
    return result;
  }

  for (const button of host.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => {
      try {
        if (mode === "form" && button.dataset.mode === "raw") flushProviders();
        mode = button.dataset.mode; updateMode(); update();
      } catch (error) { report(error.message, true); }
    });
  }
  raw.addEventListener("input", () => { if (current) { current.draft = raw.value; delete current.providerState; update(); } });
  raw.addEventListener("keydown", event => {
    if (event.key === "Tab") { event.preventDefault(); raw.setRangeText("  ", raw.selectionStart, raw.selectionEnd, "end"); raw.dispatchEvent(new Event("input")); }
  });
  function flushProviders() {
    if (!current?.providerState) return;
    const values = providerForm ? providerForm.flush() : readProviderDraft(current.providerState);
    if (!current.providerState.changed) return;
    current.draft = patchTOML(current.draft, data => {
      data.providers = values.providers;
      if (values.model_metadata) data.model_metadata = values.model_metadata;
    });
    current.providerState.changed = false;
    raw.value = current.draft;
    update();
  }

  function renderApplication() {
    const result = current?.providerApplication;
    application.replaceChildren(); application.hidden = !result;
    if (!result) return;
    application.classList.toggle("error", result.error);
    application.append(element("p", "", result.message));
    for (const item of result.errors || []) application.append(element("p", "error", `${item.id}：${item.error.message}`));
  }

  function rebaseProviders(document) {
    const previous = document.providerState;
    const state = createProviderDraft(readTOML(document.draft));
    state.catalog = previous?.catalog || null;
    state.catalogError = previous?.catalogError || "";
    const selected = state.providers.find(item => item.name === (previous?.selected?.originalName ?? previous?.selected?.name.trim()));
    if (selected) { state.selected = selected; selected.selectedModel = previous.selected.selectedModel; selected.modelQuery = previous.selected.modelQuery; }
    document.providerState = state;
  }

  async function applyProviders(document) {
    const version = generation;
    applying = true; update(); report("应用中…");
    try {
      const result = await api("/models/refresh", { method: "POST" });
      if (version !== generation) return;
      const errors = result.errors.filter(item => item.error);
      document.providerApplication = { message: errors.length ? "已应用，部分模型获取失败" : "已应用", error: !!errors.length, errors };
      document.providerState ??= createProviderDraft(readTOML(document.draft));
      document.providerState.catalog = result; document.providerState.catalogError = "";
      if (current === document) providerForm?.setCatalog(result);
      report(document.providerApplication.message, !!errors.length);
    } catch (error) {
      if (version !== generation) return;
      document.providerApplication = { message: `文件已保存，应用失败：${error.message}`, error: true };
      report(document.providerApplication.message, true);
    } finally {
      if (version === generation) { applying = false; renderApplication(); updateMode(false); update(); }
    }
  }

  async function persist(andApply = false) {
    if (!current || current.saving || applying || !current.entry.writable) return;
    if (current.source === current.draft && !current.providerState?.changed && !current.create) return;
    const activeForm = mode === "form" ? formContainer.querySelector("form") : null;
    if (activeForm && !activeForm.reportValidity()) return;
    const document = current;
    const version = generation;
    try {
      flushProviders();
      const pending = editor.save(document);
      update();
      await pending;
      if (version !== generation) return;
      if (document.entry.path === "providers.toml") {
        rebaseProviders(document);
        document.providerApplication = { message: "已保存，待应用", error: false };
        renderForm(); renderApplication();
        if (andApply) await applyProviders(document);
        else report("已保存，待应用");
      } else report(`${document.entry.name} 已保存，重启生效${document.draft !== document.source ? "；新修改尚未保存" : ""}`);
    } catch (error) {
      if (version !== generation) return;
      report(error.status === 409 ? "文件有外部修改；草稿已保留，请复制后重载合并" : `保存失败：${error.message}`, true);
    } finally { if (version === generation) { updateMode(false); update(); } }
  }
  save.addEventListener("click", () => persist(current?.entry.path === "providers.toml"));
  saveOnly.addEventListener("click", () => persist(false));
  apply.addEventListener("click", () => { if (!apply.disabled) return applyProviders(current); });
  reload.addEventListener("click", () => {
    if ((current.draft !== current.source || current.providerState?.changed) && !confirm("重载会丢弃此文件的未保存修改，继续？")) return;
    select(current.entry, true);
  });
  check.addEventListener("click", async () => {
    check.disabled = true;
    try { if (await inspect()) report("已诊断保存的配置"); }
    catch (error) { report(error.message, true); }
    finally { check.disabled = false; }
  });
  restart.addEventListener("click", async () => {
    if (editor.isDirty()) { report("有未保存修改，请先保存或重载", true); return; }
    restart.disabled = true;
    try {
      const result = await inspect();
      if (!result) return;
      if (result.items.some(issue => issue.level.toLowerCase() === "error")) { report("配置有误，修复后再重启", true); return; }
      const response = await api("/runtime/restart", { method: "POST" });
      report(response.accepted ? "已请求重启，等待重连…" : "重启请求被拒绝", !response.accepted);
    } catch (error) { report(error.message, true); }
    finally { restart.disabled = false; }
  });
  window.addEventListener("beforeunload", event => { if (editor.isDirty()) { event.preventDefault(); event.returnValue = ""; } });

  return {
    show() { host.hidden = false; load(); },
    hide() { host.hidden = true; },
    reload() { if (!host.hidden) load(); },
    reset() {
      generation++;
      providerForm?.destroy(); providerForm = null; applying = false;
      editor.reset();
      current = null; selected = ""; loaded = false; loading = false;
      application.hidden = true; application.replaceChildren();
      entries = []; fileList.replaceChildren(); formContainer.replaceChildren(); raw.value = "";
      filename.textContent = "选择配置文件"; diagnostics.hidden = true; issues.replaceChildren();
      report(""); update(); updateMode();
    },
  };
}
