import { element } from "../core/dom.js";

export function createStatus({ ui, state, api, renderMarkdown, notify, updateControls }) {
  const phaseNames = { idle: "空闲", awaiting_append_confirm: "等待追加确认", awaiting_risk_confirm: "等待风险确认", preparing: "准备中", llm: "生成中", tool: "工具执行中", sending: "发送中", stopping: "停止中", compact: "压缩中", done: "已完成", error: "发生错误" };

  function usagePercentages(usage, contextWindow) {
    return {
      context: usage?.TotalTokens != null && contextWindow > 0 ? usage.TotalTokens / contextWindow * 100 : null,
      cache: usage?.CacheHitTokens != null && usage.PromptTokens > 0 ? usage.CacheHitTokens / usage.PromptTokens * 100 : null,
    };
  }

  function renderStatusCard(data) {
    const card = element("section", "status-card");
    card.setAttribute("aria-label", "会话状态");
    const heading = element("div", "status-card-heading");
    heading.append(element("h3", "status-card-title", data.session?.title || "会话状态"),
      element("span", "status-card-phase", phaseNames[data.phase] || data.phase));
    card.append(heading, element("p", "status-card-model", [data.mode, data.model.provider, data.model.model].filter(Boolean).join(" · ")));

    const { usage, context_window: windowSize } = data.context;
    const ratios = usagePercentages(usage, windowSize);
    const metrics = element("div", "status-card-metrics");
    for (const [label, ratio, count, total] of [
      ["上下文占用", ratios.context, usage?.TotalTokens, windowSize],
      ["缓存命中", ratios.cache, usage?.CacheHitTokens, usage?.PromptTokens],
    ]) {
      const metric = element("div", "status-card-metric"), title = element("div", "status-card-metric-heading");
      title.append(element("span", "", label), element("strong", "", ratio == null ? "—" : `${ratio.toFixed(1)}%`));
      metric.append(title);
      if (ratio != null) {
        const bar = element("progress", "status-card-progress");
        bar.max = 100; bar.value = ratio; bar.setAttribute("aria-label", label);
        metric.append(bar);
      }
      metric.append(element("small", "status-card-metric-count", `${count ?? "—"} / ${total ?? "—"} tokens`));
      metrics.append(metric);
    }
    const stats = element("dl", "status-card-stats");
    for (const [label, value] of [["消息数", data.message_count], ["待处理", data.pending_count], ["平台", data.session ? data.session.platform : data.platform], ["会话 ID", data.session?.id]]) {
      const pair = element("div");
      pair.append(element("dt", "", label), element("dd", "", value ?? "—"));
      stats.append(pair);
    }
    card.append(metrics, stats);
    for (const [label, text, role] of [["最近用户消息", data.last_user_content, "user"], ["最近助手回复", data.last_assistant_content, "assistant"]]) {
      if (!text) continue;
      const details = element("details", "status-card-details"), preview = element("div", `status-card-preview ${role}`);
      const body = element("div", "status-card-preview-content");
      if (role === "assistant") renderMarkdown(body, text, true);
      else body.textContent = text;
      preview.append(body); details.append(element("summary", "", label), preview); card.append(details);
    }
    for (const [label, counts] of [["本轮工具调用", data.turn_tool_usage], ["会话工具调用", data.tool_usage]]) {
      if (!counts || !Object.keys(counts).length) continue;
      const details = element("details", "status-card-details"), list = element("dl", "status-card-tool-list");
      for (const [name, count] of Object.entries(counts)) {
        const entry = element("div"); entry.append(element("dt", "", name), element("dd", "", count)); list.append(entry);
      }
      details.append(element("summary", "", label), list); card.append(details);
    }
    for (const request of data.requests || []) card.append(element("div", "status-card-request", `${request.label || request.kind} · ${request.id}`));
    for (const error of data.errors || []) card.append(element("p", "status-card-errors", `${error.id}：${error.error}`));
    return card;
  }
  // 标题随阶段、随当前页面变化。
  let pageName = "chat";
  function updateTitle(name = pageName) {
    pageName = name;
    let title = { chat: "聊天", logs: "日志", settings: "设置" }[name] || name;
    if (name === "chat") {
      const phase = state.home ? "idle" : state.statusPhase;
      if (state.ready && !state.home && (state.needsAnswer || state.awaitingConfirmation || ["awaiting_append_confirm", "awaiting_risk_confirm"].includes(phase))) title = "confirm";
      else if (["preparing", "llm", "tool", "sending", "stopping", "compact"].includes(phase)) title = "running...";
    }
    document.title = `${title} · ElBot`;
  }

  function updateRuntime() {
    const snapshot = state.home ? null : state.snapshot;
    const phase = state.home ? "idle" : state.statusPhase;
    const displayPhase = phase === "done" ? "idle" : phase;
    const busy = ["preparing", "llm", "tool", "compact", "sending", "stopping"].includes(displayPhase);
    const label = displayPhase === "llm" && state.streamPhase ? state.streamPhase : phaseNames[displayPhase] || displayPhase;
    ui["phase-label"].textContent = state.ready ? label : "等待连接";
    ui["phase-label"].title = snapshot?.Error || "";
    ui["phase-dot"].className = `status-dot ${state.ready ? (busy ? "busy" : displayPhase === "error" ? "error" : "online") : ""}`;
    ui["tool-label"].textContent = displayPhase === "tool" ? snapshot?.ToolName || "" : "";
    const startTime = Date.parse(snapshot?.TurnStartedAt || "");
    const finishTime = Date.parse(snapshot?.FinishedAt || "");
    if (startTime > 0) {
      const seconds = Math.max(0, Math.floor(((finishTime > 0 ? finishTime : Date.now()) - startTime) / 1000));
      ui.elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    } else ui.elapsed.textContent = "";
    const context = state.home ? null : state.contextUsage;
    updateTitle();
    const contextText = context ? `上下文 ${context.percent.toFixed(1)}%` : "上下文 —";
    const cacheText = state.home || state.cacheUsage?.percent == null ? "缓存 —" : `缓存 ${state.cacheUsage.percent.toFixed(1)}%`;
    ui.usage.textContent = state.ready ? `${contextText} · ${cacheText}` : "";
    ui.usage.title = state.ready && !state.home ? `token 用量：${state.totalTokens == null ? "—" : state.totalTokens.toLocaleString()}${context ? ` / ${context.window.toLocaleString()}` : ""}；缓存 token：${state.cacheUsage?.tokens == null ? "—" : state.cacheUsage.tokens.toLocaleString()}` : "";
    const model = state.currentModel;
    ui["model-label"].textContent = model ? model.slice(model.indexOf("/") + 1) : state.ready ? "读取模型…" : "未连接";
    ui["model-button"].title = model || "选择当前模式的模型";
  }

  function applyStatus(data) {
    if (!state.home && data.session?.id !== state.sessionID) return;
    state.currentModel = [data.model.provider, data.model.model].filter(Boolean).join("/");
    if (state.home) { updateRuntime(); return; }
    state.statusPhase = data.phase;
    ui["conversation-heading"].textContent = data.session.title || "未命名会话";
    const context = data.context;
    const usage = context.usage;
    const ratios = usagePercentages(usage, context.context_window);
    state.totalTokens = usage?.TotalTokens ?? null;
    state.contextUsage = ratios.context == null ? null : {
      tokens: state.totalTokens, window: context.context_window, percent: ratios.context,
    };
    state.cacheUsage = usage ? { tokens: usage.CacheHitTokens, percent: ratios.cache } : null;
    updateRuntime();
    updateControls();
  }

  async function refreshStatus() {
    if (!state.ready) return;
    if (state.statusQuery) { state.statusQuery.again = true; return; }
    const query = { again: false };
    state.statusQuery = query;
    try {
      const data = await api("/status");
      if (state.statusQuery !== query) return;
      applyStatus(data);
    } catch (error) { if (state.ready && state.statusQuery === query) notify("WARN", error.message); }
    finally {
      if (state.statusQuery === query) {
        state.statusQuery = null;
        if (query.again) refreshStatus();
      }
    }
  }

  return { usagePercentages, renderStatusCard, updateRuntime, applyStatus, refreshStatus, updateTitle };
}
