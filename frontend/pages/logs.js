import { element } from "../core/dom.js";

export function createLogsPage({ ui, api }) {
  const host = ui["logs-page"];
  host.innerHTML = `
    <div class="management-heading"><div><h1>日志</h1></div></div>
    <form class="surface log-filters">
      <div class="form-grid">
        <label>分类<select name="category"><option value="elbot">运行</option><option value="audit">审计</option><option value="elnis">Elnis</option></select></label>
        <label>最低等级<select name="level"><option value="">不限</option><option value="DEBUG">DEBUG</option><option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option></select></label>
        <label>天数<input name="days" type="number" min="1" step="1" value="1" required></label>
        <label>条数上限<input name="limit" type="number" min="1" step="1" value="100" required></label>
        <label>开始<input name="since" type="datetime-local" step="1"></label>
        <label>结束<input name="until" type="datetime-local" step="1"></label>
        <label class="field-wide">关键字<input name="contains" type="search" placeholder="搜索文本"></label>
      </div>
      <details class="advanced-filters"><summary>高级筛选</summary><div class="form-grid">
        <label>事件（每行一项）<textarea name="event" rows="2"></textarea></label>
        <label>字段（每行 key=value）<textarea name="field" rows="2" placeholder="module=agent"></textarea></label>
        <label>内容字段（每行 key=value）<textarea name="content_field" rows="2" placeholder="user.id=42"></textarea></label>
        <label>数组包含（每行 key=value）<textarea name="content_field_contains" rows="2" placeholder="tags=important"></textarea></label>
        <label class="field-wide">内容关键字<input name="content_contains" type="search"></label>
        <label class="checkbox-field"><input name="raw" type="checkbox">损坏行样本</label>
      </div></details>
      <div class="form-actions"><button type="submit" class="action-button">查询</button><label class="checkbox-field"><input name="auto" type="checkbox">自动刷新 / 5s</label></div>
    </form>
    <p class="page-feedback" role="status"></p><div class="log-results"></div>`;
  const form = host.querySelector("form");
  const feedback = host.querySelector(".page-feedback");
  const results = host.querySelector(".log-results");
  const submit = form.querySelector('button[type="submit"]');
  let visible = false;
  let timer = null;
  let controller = null;

  function parameters() {
    const query = new URLSearchParams();
    const data = new FormData(form);
    for (const name of ["category", "level", "days", "limit", "contains", "content_contains"]) {
      const value = String(data.get(name) || "").trim();
      if (value) query.set(name, value);
    }
    for (const name of ["since", "until"]) {
      if (data.get(name)) query.set(name, new Date(String(data.get(name))).toISOString());
    }
    for (const name of ["event", "field", "content_field", "content_field_contains"]) {
      for (const value of String(data.get(name) || "").split("\n").map(value => value.trim()).filter(Boolean)) query.append(name, value);
    }
    if (data.has("raw")) query.set("raw", "true");
    return query;
  }

  function render(data) {
    const expanded = new Set([...results.querySelectorAll("details[open]")].map(node => node.dataset.key));
    const nodes = data.items.map(entry => {
      const details = element("details", `log-entry surface level-${entry.level.toLowerCase()}`);
      details.dataset.key = JSON.stringify([entry.time, entry.event_name, entry.module, entry.identity]);
      details.open = expanded.has(details.dataset.key);
      const summary = element("summary", "log-summary");
      summary.append(
        element("time", "log-time", new Date(entry.time).toLocaleString("zh-CN")),
        element("span", "log-level", entry.level),
        element("strong", "log-event", entry.event_name || entry.module),
        element("span", "log-preview", typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)),
      );
      details.append(summary, element("pre", "log-detail", JSON.stringify(entry, null, 2)));
      return details;
    });
    if (!nodes.length) nodes.push(element("div", "empty-state", "无匹配日志"));
    if (data.damaged_count) {
      const damaged = element("details", "surface log-damaged");
      damaged.append(element("summary", "", `损坏 ${data.damaged_count} 条`));
      if (data.damaged_lines.length) damaged.append(element("pre", "log-detail", data.damaged_lines.join("\n")));
      nodes.unshift(damaged);
    }
    results.replaceChildren(...nodes);
  }

  async function refresh() {
    clearTimeout(timer);
    if (!visible || document.hidden || !form.reportValidity()) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    submit.disabled = true;
    feedback.classList.remove("error");
    feedback.textContent = "查询中…";
    try {
      const data = await api(`/logs?${parameters()}`, { signal: current.signal });
      if (controller !== current) return;
      render(data);
      feedback.textContent = `${data.items.length} 条 · ${new Date().toLocaleTimeString("zh-CN")}`;
    } catch (error) {
      if (controller !== current || error.name === "AbortError") return;
      feedback.classList.add("error");
      feedback.textContent = error.message;
      if (error.status === 401 || error.status === 403) form.elements.auto.checked = false;
    } finally {
      if (controller === current) {
        controller = null;
        submit.disabled = false;
        if (visible && !document.hidden && form.elements.auto.checked) timer = setTimeout(refresh, 5000);
      }
    }
  }

  form.addEventListener("submit", event => { event.preventDefault(); refresh(); });
  form.elements.auto.addEventListener("change", () => {
    clearTimeout(timer);
    if (form.elements.auto.checked) refresh();
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (visible && !document.hidden && form.elements.auto.checked) refresh();
  });
  return {
    show() { visible = true; host.hidden = false; refresh(); },
    hide() { visible = false; clearTimeout(timer); controller?.abort(); controller = null; submit.disabled = false; host.hidden = true; },
    reload() { if (visible) refresh(); },
    reset() { clearTimeout(timer); controller?.abort(); controller = null; form.elements.auto.checked = false; results.replaceChildren(); feedback.textContent = ""; submit.disabled = false; },
  };
}
