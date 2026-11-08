import { element } from "../core/dom.js";

export function createStatus({ ui, state, api, activateSession, renderSessions, loadHistory, renderMarkdown, addNotice, updateControls }) {
  const phaseNames = { idle: "空闲", awaiting_append_confirm: "等待追加确认", awaiting_risk_confirm: "等待风险确认", preparing: "准备中", llm: "生成中", tool: "工具执行中", sending: "发送中", stopping: "停止中", compact: "压缩中", done: "已完成", error: "发生错误" };

  function usagePercentages(usage, contextWindow) {
    return {
      context: usage?.TotalTokens != null && contextWindow > 0 ? usage.TotalTokens / contextWindow * 100 : null,
      cache: usage?.CacheHitTokens != null && usage.PromptTokens > 0 ? usage.CacheHitTokens / usage.PromptTokens * 100 : null,
    };
  }

  function renderStatusCard(data, failure) {
    const card = element("section", "status-card");
    card.setAttribute("aria-label", "会话状态");
    const integer = value => value == null ? "—" : value.toLocaleString("zh-CN");
    const percent = value => value == null ? "—" : `${value.toFixed(1)}%`;
    const model = value => [value.provider, value.model].filter(Boolean).join("/") || "—";
    const stamp = value => value ? new Date(value).toLocaleString("zh-CN") : "—";
    const context = data.context;
    const usage = context.usage;
    const ratios = usagePercentages(usage, context.context_window);

    const heading = element("header", "status-card-heading");
    const title = element("div", "status-card-heading-text");
    title.append(element("span", "eyebrow", "会话状态"), element("h3", "status-card-title", data.session ? data.session.title || "未命名会话" : "尚未开始会话"));
    const phase = element("span", "status-card-phase");
    const busy = ["preparing", "llm", "tool", "compact", "sending", "stopping", "awaiting_append_confirm", "awaiting_risk_confirm"].includes(data.phase);
    phase.append(element("span", `status-dot ${data.phase === "error" ? "error" : busy ? "busy" : "online"}`), element("span", "", phaseNames[data.phase] || data.phase));
    heading.append(title, phase);
    card.append(heading, element("p", "status-card-model", `${data.mode} · ${model(data.model)}`));

    const metrics = element("div", "status-card-metrics");
    for (const [label, ratio, count] of [
      ["上下文占用", ratios.context, `${integer(usage?.TotalTokens)} / ${integer(context.context_window > 0 ? context.context_window : null)} token`],
      ["缓存命中", ratios.cache, `${integer(usage?.CacheHitTokens)} / ${integer(usage?.PromptTokens)} 输入 token`],
    ]) {
      const metric = element("div", "status-card-metric");
      const line = element("div", "status-card-metric-heading");
      line.append(element("span", "", label), element("strong", "", percent(ratio)));
      const progress = element("progress", "status-card-progress");
      progress.max = 100;
      progress.hidden = ratio == null;
      if (ratio != null) progress.value = ratio;
      progress.setAttribute("aria-label", label);
      progress.setAttribute("aria-valuetext", percent(ratio));
      metric.append(line, progress, element("span", "status-card-metric-count", count));
      metrics.append(metric);
    }
    card.append(metrics);

    function values(entries, className = "status-card-stats") {
      const list = element("dl", className);
      for (const [label, value] of entries) {
        const item = document.createElement("div");
        item.append(element("dt", "", label), element("dd", "", typeof value === "number" ? integer(value) : value ?? "—"));
        list.append(item);
      }
      return list;
    }

    card.append(values([
      ["输入 token", usage?.PromptTokens], ["输出 token", usage?.CompletionTokens],
      ["总 token", usage?.TotalTokens], ["缓存 token", usage?.CacheHitTokens],
      ["消息数量", data.message_count], ["待处理输入", data.pending_count],
      ["自动压缩", context.compact_enabled ? "开启" : "关闭"], ["压缩阈值", `${context.compact_trigger_ratio * 100}%`],
    ]));

    function details(label, content) {
      const section = element("details", "status-card-details");
      section.append(element("summary", "", label), content);
      card.append(section);
    }

    if (data.session) {
      const session = data.session;
      const entries = [
        ["会话 ID", session.id], ["创建时间", stamp(session.created_at)], ["更新时间", stamp(session.updated_at)],
        ["所属平台", session.platform], ["平台会话", session.chat_id], ["保存状态", session.status],
      ];
      if (session.parent_session_id) entries.push(["父会话", session.parent_session_id]);
      if (session.fork_from_message_id) entries.push(["分支起点", session.fork_from_message_id]);
      if (session.archived_at) entries.push(["归档时间", stamp(session.archived_at)]);
      if (session.pinned_at) entries.push(["置顶时间", stamp(session.pinned_at)]);
      details("会话详情", values(entries, "status-card-detail-values"));
    } else {
      details("默认设置", values([
        ["默认模式", data.default_mode], ["压缩模型", model(data.compact_model)],
        ["所属平台", data.platform], ["平台会话", data.chat_id],
      ], "status-card-detail-values"));
    }

    if (data.requests?.length) {
      const requests = element("div", "status-card-requests");
      for (const request of data.requests) {
        const item = element("section", "status-card-request");
        item.append(element("strong", "", request.label || request.kind), values([
          ["请求 ID", request.id], ["类型", request.kind], ["开始时间", stamp(request.started_at)],
          ["状态", request.stopping ? "正在停止" : "执行中"],
        ], "status-card-detail-values"));
        requests.append(item);
      }
      details(`当前请求 · ${integer(data.requests.length)}`, requests);
    }

    for (const [label, counts] of [["会话工具调用", data.tool_usage], ["本轮工具调用", data.turn_tool_usage]]) {
      const entries = Object.entries(counts || {});
      if (entries.length) details(label, values(entries, "status-card-tool-list"));
    }

    for (const [role, label, content] of [
      ["user", "最近用户消息", data.last_user_content],
      ["assistant", "最近助手消息", data.last_assistant_content],
    ]) {
      if (!content) continue;
      const preview = element("div", `status-card-preview ${role}`);
      preview.append(element("strong", "status-card-preview-label", role === "user" ? `用户 · ${state.account}` : "助手 · ElBot"));
      const body = element("div", "status-card-preview-content");
      if (role === "assistant") renderMarkdown(body, content);
      else body.textContent = content;
      preview.append(body);
      details(label, preview);
    }

    const failures = [...(data.errors || [])];
    if (failure) failures.push({ id: "status", error: failure });
    if (failures.length) {
      const errors = element("div", "status-card-errors");
      for (const item of failures) {
        errors.append(element("p", "", `${item.id}：${item.error.message}`), element("small", "", item.error.code || ""));
      }
      card.append(errors);
    }
    return card;
  }

  function resultMarkdown(result) {
    const data = result.data ?? {};
    const items = data?.items || [];
    const md = value => String(value ?? "—").replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&").replace(/\r?\n/g, "<br>");
    const table = (headers, rows) => rows.length ? [headers, headers.map(() => "---"), ...rows.map(row => row.map(md))].map(row => `| ${row.join(" | ")} |`).join("\n") : "暂无记录。";
    const fields = rows => table(["项目", "值"], rows);
    const modelName = model => [model.provider, model.model].filter(Boolean).join("/") || "—";
    const stamp = value => value ? new Date(value).toLocaleString("zh-CN") : "—";
    const fence = value => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const marker = "`".repeat(Math.max(3, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
      return `${marker}\n${text}\n${marker}`;
    };
    const usageRow = row => [row.key, row.calls, row.prompt_tokens, row.completion_tokens, row.total_tokens, row.cache_hit_tokens, row.elapsed_ms].map(value => value === -1 ? "溢出" : value);
    const itemErrors = errors => (errors || []).map(item => `- ${md(item.id)}：${md(item.error.message)}（${md(item.error.code)}）`).join("\n");
    const messages = rows => rows.map(row => `### ${row.role === "user" ? md(state.account) : "ElBot"} · ${md(stamp(row.created_at))}\n\n${row.content}${row.attachments?.length ? `\n\n附件：${row.attachments.map(file => md(file.name)).join("、")}` : ""}`).join("\n\n");
    switch (result.kind) {
      case "text": return data.content ?? (Object.hasOwn(data, "accepted") ? data.accepted ? "操作已接受。" : "操作未被接受。" : fence(data));
      case "session": {
        if (result.confirmation) return `请确认操作：${md(data.session?.title || data.session_id || "所选目标")}。`;
        return `当前会话：${md(data.session?.title || data.current_session_id || "新对话")}${data.unchanged ? "（未变）" : ""}${data.affected_count ? `\n\n影响数量：${data.affected_count}` : ""}`;
      }
      case "sessions": return `### 会话 · 第 ${data.page} 页\n\n${table(["名称", "更新时间", "消息数", "ID"], items.map(row => [row.title || "未命名会话", stamp(row.updated_at), row.message_count, row.id]))}`;
      case "messages": return `第 ${data.page} 页 / ${data.total_pages} 页\n\n${messages(items) || "暂无历史消息。"}`;
      case "model": return `已选择模型：${md(modelName(data.model))}（${md(data.target)}）`;
      case "models": return table(["编号", "提供方", "模型", "模式"], items.map(row => [row.index, row.provider, row.model, (row.modes || []).join("、")])) + (data.errors?.length ? `\n\n${itemErrors(data.errors)}` : "");
      case "requests": return table(["ID", "类型", "会话", "说明", "开始时间", "停止中"], items.map(row => [row.id, row.kind, row.session_title || row.session_id, row.label, stamp(row.started_at), row.stopping ? "是" : "否"]));
      case "stop": return `${data.state === "stopping" ? "已接受停止请求，正在退出" : "已停止"}。接受取消 ${data.accepted_count} 个请求。`;
      case "tools": return result.confirmation ? "请确认此工具操作。" : !data.items ? fence(data) : table(["名称", "说明", "来源", "风险", "标签"], items.map(row => [row.Name, row.Description, row.Source, row.Risk, (row.Tags || []).join("、")]));
      case "rollback": return fields([["文件", data.Path], ["结果", data.Deleted ? "已删除新建文件" : "已恢复文件"], ["版本", data.Revision]]);
      case "rollbacks": return table(["编号", "文件", "新建文件", "编辑时间"], items.map(row => [row.ID, row.Path, row.Created ? "是" : "否", stamp(row.EditedAt)]));
      case "logs": return `### 日志\n\n${items.map(row => `**${md(stamp(row.time))} · ${md(row.level)} · ${md(row.module)} · ${md(row.event_name)}**\n\n${fence(row.raw || row.content)}`).join("\n\n") || "暂无日志。"}${data.damaged_count ? `\n\n损坏记录：${data.damaged_count}${data.damaged_lines?.length ? `\n\n${fence(data.damaged_lines.join("\n"))}` : ""}${data.damaged_count > (data.damaged_lines?.length || 0) ? `\n\n省略：${data.damaged_count - (data.damaged_lines?.length || 0)}` : ""}` : ""}`;
      case "usage": return (items.length || data.total.calls ? `### 用量统计\n\n${table([data.group_by || "分组", "调用", "输入 token", "输出 token", "总 token", "缓存 token", "耗时 ms"], [...items, data.total].map(usageRow))}` : "-") + (data.range_truncated ? "\n\n查询范围超过可用记录，已使用实际范围。" : "") + (data.damaged_count ? `\n\n损坏记录：${data.damaged_count}` : "");
      case "doctor": return `配置：${md(data.config_path)}\n\n${items.length ? table(["级别", "主题", "配置项", "问题"], items.map(row => [row.level, row.topic, (row.field || []).join("."), row.message])) : "未发现配置问题。"}`;
      case "hooks": return (data.operation ? `操作：${md(data.operation)} ${md(data.target)}\n\n` : "") + table(["ID", "名称", "注册点", "优先级", "模式", "状态", "执行中", "等待", "说明"], items.map(row => [row.id, row.name, row.point, row.priority, row.mode, row.status, row.active, row.waiting, row.detail || row.description])) + (data.notices?.length ? `\n\n${data.notices.map(md).join("\n\n")}` : "");
      case "compact": return `已压缩并切换到会话：${md(data.session?.title || data.current_session_id || "未命名会话")}`;
      case "help": return table(["用法", "说明", "别名"], items.map(row => [[row.name, row.args].filter(Boolean).join(" "), row.description, (row.aliases || []).join("、")])) + (items.length === 1 && items[0].help ? `\n\n${items[0].help}` : "") + (data.help_command ? `\n\n详细帮助：${md(data.help_command)}` : "");
      default: return null;
    }
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
    const contextText = context ? `上下文 ${context.percent.toFixed(1)}%` : "上下文 —";
    const cacheText = state.home || state.cacheUsage?.percent == null ? "缓存 —" : `缓存 ${state.cacheUsage.percent.toFixed(1)}%`;
    ui.usage.textContent = state.ready ? `${contextText} · ${cacheText}` : "";
    ui.usage.title = state.ready && !state.home ? `token 用量：${state.totalTokens == null ? "—" : state.totalTokens.toLocaleString()}${context ? ` / ${context.window.toLocaleString()}` : ""}；缓存 token：${state.cacheUsage?.tokens == null ? "—" : state.cacheUsage.tokens.toLocaleString()}` : "";
    const model = state.currentModel;
    ui["model-label"].textContent = model ? model.slice(model.indexOf("/") + 1) : state.ready ? "读取模型…" : "未连接";
    ui["model-button"].title = model || "选择当前模式的模型";
  }

  function applyStatus(data) {
    if (state.snapshot?.SessionID !== data.session?.id) state.snapshot = null;
    state.currentModel = [data.model.provider, data.model.model].filter(Boolean).join("/");
    state.statusPhase = data.phase;
    if (!state.home && data.session) {
      const changed = state.sessionID && state.sessionID !== data.session.id;
      if (changed) activateSession(data.session);
      state.sessionID = data.session.id;
      ui["conversation-heading"].textContent = data.session.title || "未命名会话";
      renderSessions();
      if (changed) loadHistory();
    }
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
    } catch (error) { if (state.ready && state.statusQuery === query) addNotice("WARN", error.message); }
    finally {
      if (state.statusQuery === query) {
        state.statusQuery = null;
        if (query.again) refreshStatus();
      }
    }
  }

  return { usagePercentages, renderStatusCard, resultMarkdown, updateRuntime, applyStatus, refreshStatus };
}
