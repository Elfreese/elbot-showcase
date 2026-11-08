import { TomlDocument } from "../vendor/toml-patch.js";

export const runtimeFields = [
  { path: ["runtime", "log_level"], label: "日志等级", type: "select", options: ["debug", "info", "warn", "error"], fallback: "info" },
  { path: ["runtime", "log_retention_days"], label: "日志保留 / 天", type: "number", fallback: 30 },
  { path: ["llm_request", "first_chunk_timeout_seconds"], label: "首包超时 / s", type: "number", fallback: 180 },
  { path: ["llm_request", "stream_idle_timeout_seconds"], label: "流空闲超时 / s", type: "number", fallback: 60 },
  { path: ["llm_request", "response_timeout_seconds"], label: "整轮超时 / s（0=不限）", type: "number", fallback: 0 },
  { path: ["llm_request", "max_retries"], label: "重试上限", type: "number", fallback: 3 },
  { path: ["llm_request", "retry_initial_delay_seconds"], label: "重试初始延迟 / s", type: "number", fallback: 2 },
  { path: ["context", "compact_enabled"], label: "自动压缩", type: "boolean", fallback: true },
  { path: ["context", "compact_trigger_ratio"], label: "压缩阈值（0~1）", type: "ratio", fallback: 0.8 },
];

export function readTOML(text) { return new TomlDocument(text).toJsObject; }

export function patchTOML(text, edit) {
  const document = new TomlDocument(text);
  const values = document.toJsObject;
  edit(values);
  document.patch(values);
  return document.toTomlString;
}

export function setField(values, path, value) {
  let table = values;
  for (const key of path.slice(0, -1)) {
    if (table[key] === undefined) {
      if (value === undefined) return;
      table[key] = {};
    }
    table = table[key];
  }
  if (value === undefined) delete table[path.at(-1)];
  else table[path.at(-1)] = value;
}

export function createConfigurationEditor({ api }) {
  const documents = new Map();
  let generation = 0;

  async function load(entry, force = false) {
    const version = generation;
    if (!force && documents.has(entry.path)) {
      const existing = documents.get(entry.path);
      existing.entry = entry;
      return existing;
    }
    let result = { content: "", revision: "" };
    if (entry.exists) {
      result = await api(`/files/content?${new URLSearchParams({ root: "config", path: entry.path, offset: 0, limit: 0 })}`);
      if (result.truncated || result.offset !== 0) throw new Error("文件读取不完整，无法保存");
    }
    if (version !== generation) throw new DOMException("文件读取已取消", "AbortError");
    const document = { entry, source: result.content, draft: result.content, revision: result.revision, create: !entry.exists, saving: false };
    documents.set(entry.path, document);
    return document;
  }

  async function save(document) {
    if (!document.entry.writable) throw new Error("文件只读");
    if (document.saving) return;
    if (document.entry.path.endsWith(".toml")) readTOML(document.draft);
    const content = document.draft;
    document.saving = true;
    try {
      const result = await api("/files/content", { method: "PUT", body: {
        root: "config", path: document.entry.path, content,
        expected_revision: document.create ? "" : document.revision, create: document.create,
      } });
      document.source = content;
      document.revision = result.revision;
      document.create = false;
      document.entry.exists = true;
    } finally { document.saving = false; }
  }

  return { load, save, reset() { generation++; documents.clear(); }, isDirty: () => [...documents.values()].some(document => document.draft !== document.source || document.providerState?.changed) };
}

export function createPayloadDraft(value = {}) {
  return {
    mode: "table", changed: false, json: JSON.stringify(value, null, 2),
    rows: Object.entries(value).map(([key, value]) => ({
      key, type: Array.isArray(value) ? "array" : typeof value,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    })),
  };
}

function parsePayloadJSON(text) {
  const value = JSON.parse(text);
  // JSON.parse 会吞掉重复键；只扫描键名，语法错误由 JSON.parse 统一报告。
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let index = 0;
  function visit() {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[index] !== "}") {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) throw new Error(`参数重复：${key}`);
        keys.add(key);
        index++; // 冒号。
        visit();
        if (tokens[index] === ",") index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") {
        visit();
        if (tokens[index] === ",") index++;
      }
      index++;
    }
  }
  visit();
  return value;
}

export function readPayload(draft) {
  let value;
  if (draft.mode === "json") value = parsePayloadJSON(draft.json.trim() || "{}");
  else {
    const entries = [];
    const keys = new Set();
    for (const [index, row] of draft.rows.entries()) {
      try {
        const key = row.key.trim();
        if (!key) throw new Error("缺少参数名");
        if (keys.has(key)) throw new Error(`参数重复：${key}`);
        keys.add(key);
        const item = row.type === "string" ? row.text : parsePayloadJSON(row.text);
        const type = Array.isArray(item) ? "array" : typeof item;
        if (item === null || type !== row.type) throw new Error(`值应为 ${row.type}`);
        entries.push([key, item]);
      } catch (error) {
        error.message = `第 ${index + 1} 项：${error.message}`;
        error.row = index;
        throw error;
      }
    }
    value = Object.fromEntries(entries);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("extra_payload 必须为 JSON 对象");
  function validate(item, path) {
    if (item === null) throw new Error(`${path}：TOML 不支持 null`);
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${path}：数值超出范围`);
    if (typeof item === "object") for (const [key, child] of Object.entries(item)) validate(child, `${path}.${key}`);
  }
  validate(value, "extra_payload");
  return value;
}

export function createModelDraft(name, provider = {}) {
  const config = provider.model_configs?.[name] || {};
  return {
    name, supplement: (provider.models || []).includes(name),
    context: config.context_window > 0 ? String(config.context_window) : "",
    initialContext: config.context_window > 0 ? String(config.context_window) : "",
    payload: createPayloadDraft(config.extra_payload), clear: false,
  };
}

export function createProviderEntry(name = null, provider = {}) {
  return {
    originalName: name, name: name || "", api_mode: provider.api_mode || "chat", base_url: provider.base_url || "",
    api_key_env: provider.api_key_env || "", proxy: provider.proxy || "",
    payload: createPayloadDraft(provider.extra_payload),
    models: new Map([...new Set([...(provider.models || []), ...Object.keys(provider.model_configs || {})])].map(model => [model, createModelDraft(model, provider)])),
    selectedModel: "", modelQuery: "",
  };
}

export function createProviderDraft(values) {
  const providers = Object.entries(values.providers || {}).map(([name, provider]) => createProviderEntry(name, provider));
  return {
    values, providers, selected: providers[0] || null, changed: false,
    defaultWindow: values.model_metadata?.default_context_window == null ? "" : String(values.model_metadata.default_context_window),
    catalog: null, catalogError: "",
  };
}

export function readProviderDraft(state) {
  const values = structuredClone(state.values);
  const providers = [];
  const names = new Set();
  const windowValue = (text, label) => {
    if (text === "") return undefined;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}须为正整数`);
    return value;
  };
  for (const draft of state.providers) {
    let field = "name";
    let model = null;
    try {
      const name = draft.originalName === null ? draft.name.trim() : draft.originalName;
      if (!name || name.includes("/")) throw new Error("名称不能为空或包含 /");
      if (names.has(name)) throw new Error(`Provider 名称重复：${name}`);
      names.add(name);
      field = "base_url";
      const url = new URL(draft.base_url.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Base URL 须为 HTTP(S) 地址");
      field = "api_mode";
      if (!["chat", "response"].includes(draft.api_mode)) throw new Error("协议须为 chat 或 response");
      const origin = draft.originalName === null ? {} : state.values.providers[draft.originalName];
      const provider = structuredClone(origin);
      for (const key of ["api_mode", "base_url", "api_key_env", "proxy"]) {
        const value = draft[key].trim();
        const previous = origin[key] ?? (key === "api_mode" ? "chat" : "");
        if (draft.originalName === null || draft[key] !== previous) {
          if (value) provider[key] = value;
          else delete provider[key];
        }
      }
      field = "extra_payload";
      const payload = readPayload(draft.payload);
      if (draft.payload.changed) {
        if (Object.keys(payload).length) provider.extra_payload = payload;
        else delete provider.extra_payload;
      }
      const supplements = [];
      for (const item of draft.models.values()) {
        model = item.name;
        if (item.supplement) supplements.push(item.name);
        const config = item.clear ? {} : structuredClone(origin.model_configs?.[item.name] || {});
        field = "context_window";
        const context = windowValue(item.context, "上下文窗口");
        if (item.clear || item.context !== item.initialContext) {
          if (context === undefined) delete config.context_window;
          else config.context_window = context;
        }
        field = "extra_payload";
        const extra = readPayload(item.payload);
        if (item.payload.changed) {
          if (Object.keys(extra).length) config.extra_payload = extra;
          else delete config.extra_payload;
        }
        if (!item.clear && item.context === item.initialContext && !item.payload.changed) continue;
        if (Object.keys(config).length) {
          provider.model_configs ??= {};
          Object.defineProperty(provider.model_configs, item.name, { value: config, configurable: true, writable: true, enumerable: true });
        } else if (provider.model_configs) delete provider.model_configs[item.name];
      }
      if (JSON.stringify(supplements) !== JSON.stringify(origin.models || [])) {
        if (supplements.length) provider.models = supplements;
        else delete provider.models;
      }
      if (provider.model_configs && !Object.keys(provider.model_configs).length) delete provider.model_configs;
      providers.push([name, provider]);
    } catch (error) {
      if (field === "base_url") error.message = "Base URL 须为 HTTP(S) 地址";
      error.provider = draft;
      error.model = model;
      error.field = field;
      throw error;
    }
  }
  values.providers = Object.fromEntries(providers);
  const fallback = windowValue(state.defaultWindow, "默认窗口");
  const previous = state.values.model_metadata?.default_context_window;
  if (String(previous ?? "") !== state.defaultWindow) {
    values.model_metadata ??= {};
    if (fallback === undefined) delete values.model_metadata.default_context_window;
    else values.model_metadata.default_context_window = fallback;
  }
  return values;
}
