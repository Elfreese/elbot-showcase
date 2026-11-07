# Elvena v3 协议

Elvena 是 Elwisp 向 Elnis 投递事件的 JSON over HTTP 协议。本文只说明当前 `elvena.v3` 的字段与行为；配置入口见 [Elnis 配置与使用](https://github.com/Elflare/elbot/blob/main/docs/elnis-usage.md)，结构声明见 [JSON Schema](../schemas/elvena-v3.schema.json)。

## Endpoint 与鉴权

```text
POST /elvena/v3/events
Authorization: Bearer <token>
Content-Type: application/json
```

也可使用 `X-Elnis-Token`。Token 由 Elnis 配置引用的环境变量提供，不写进事件、源码或 URL。

每个请求体只能包含一个 JSON 值，尾随空白允许；第二个 JSON 值或非法 JSON 返回 `400`。未知字段被忽略，不参与协议语义、事件内容哈希或审计。

## 事件字段

| 字段 | 类型 | 要求与说明 |
| --- | --- | --- |
| `version` | string | 必填，`elvena.v3`。 |
| `elwisp.name` | string | 必填，仅英文字母、数字、`_`、`-`；参与事件身份。 |
| `elwisp.tags` | string[] | 可选标签。 |
| `source` | string | 必填，具体事件来源，去除首尾空白后不能为空。 |
| `id` | string | 必填，同一 Elwisp 和 source 内稳定、唯一的事件 ID。 |
| `created_at` | string | 可选 RFC 3339 时间，省略使用接收时间。 |
| `mode` | string | 必填，`record`、`direct` 或 `llm`。 |
| `title` | string | 可选事件标题。 |
| `format` | string | `text` 或 `elyph`，默认 `text`。 |
| `content` | string | 事件正文；llm 模式必须提供非空正文。direct/record 中，非空 `content`、非空 `segments`、非空 `calls` 至少提供一个。 |
| `targets` | object[] | 必填且非空；期望投递目标，最终由 Elnis 裁决。 |
| `model_slot` | string | 可选 `elwisp1`、`elwisp2`、`elwisp3`；未填或槽位未配置时回退 `work`。 |
| `tool_list_names` | string[] | 请求预加载的 ElBot 内部工具或 Skill 名，受 Elnis `allowed_tools` 限制；`discover_tool` 被忽略。 |
| `tools` | object[] | Elwisp 声明的外部工具，见下文。 |
| `segments` | object[] | text/image/file 消息片段，见下文。 |
| `calls` | object[] | direct 模式中的平台原生 API 调用，见下文。 |
| `meta` | object | 可选补充数据，用于记录和 prompt 附加。 |

`record` 只记录事件；`direct` 执行原生调用并投递消息；`llm` 排队启动后台 LLM Session，由模型决定是否报告。

去重键为 `elwisp.name + source + id`。实际监听器应为同一外部事件保留稳定 ID；示例脚本每次生成不同 ID，便于手动演示。

## targets 格式

```json
[
  {"platform":"cli"},
  {"platform":"telegram","type":"private","id":"123456"},
  {"platform":"qqonebot","type":"group","id":"987654321"}
]
```

- 只写 `platform`：投递到该平台超级管理员。
- 指定 `type=private` 或 `type=group` 时必须同时填写 `id`；只填 `id` 不合法。
- `{"platform":"all"}` 表示所有已启用平台的超级管理员，不能附带非空 `type` 或 `id`。
- 默认允许投递，命中全局 `[delivery_disabled].targets` 或单 Elwisp `disabled_targets` 时禁止。

CLI 目标需要 Elnis 与 CLI 同处 `elbot run` 进程，或 service 模式启用了 CLI 远程服务端。独立的 `elbot client` 需要连接服务端才能收到通知。

## segments（多模态消息段）

| 字段 | 说明 |
| --- | --- |
| `kind` | 必填，`text`、`image` 或 `file`。 |
| `text` | text 片段的正文，默认空字符串；text 片段不能包含非空 `url`。 |
| `url` | image/file 必填，填写 HTTP(S) 地址、base64 data URI 或完整的 `media:<sha256>`。 |
| `name` | 可选文件名提示。 |
| `mime_type` | 可选 MIME 类型提示；data URI 同时声明 MIME 时须一致。 |

```json
{
  "segments": [
    {"kind":"text","text":"CPU 飙到 90%，详见附图。"},
    {"kind":"image","url":"https://monitor.example.com/chart.png","name":"cpu_chart.png"},
    {"kind":"file","url":"https://logs.example.com/dump.txt","name":"cpu_dump.txt"}
  ]
}
```

direct 模式有 `segments` 时按片段顺序输出；需要显示的正文应放进 text 片段。没有片段时才使用 `title` 与 `content` 组成文本。

### 媒体归档与引用

- 媒体在进入 LLM 或 direct 平台输出时导入共享 Media Center，以内容哈希标识。direct 不额外保留一份 sandbox 下载副本。
- `media:<sha256>` 引用已有中心资源，仍填在 `url` 字段，不增加独立的 `media` 字段。
- `data:` 只支持 base64；入站媒体不接受本地路径或 `file://`。
- 大小和下载期限受 Elnis segment 配置限制；前端展示和平台输出使用导入后的媒体元信息。
- Elwisp 管理自身文件，不取得宿主媒体导出路径、媒体管理 RPC 或存储凭据。

持久化报告和待重试 outbox 保有独立媒体引用；清理规则见 [下载与存储](https://github.com/Elflare/elbot/blob/main/docs/elnis-usage.md#下载与存储)。

## calls（平台动作调用）

每项直接描述一个平台原生 API：

| 字段 | 说明 |
| --- | --- |
| `platform` | 可选平台名；省略时使用首个解析目标的平台。 |
| `api` | 平台原生 API 名称。 |
| `params` | 原生参数对象，由对应平台解释。 |

```json
{
  "calls": [
    {"platform":"telegram","api":"deleteMessage","params":{"chat_id":123456,"message_id":42}},
    {"platform":"qqonebot","api":"set_group_ban","params":{"group_id":987654321,"user_id":11111,"duration":60}}
  ]
}
```

原生 API 的会话、用户和消息标识直接放在 `params` 中。调用按数组顺序执行；某次失败后返回错误，不继续后续调用或消息投递。direct 请求只有 `calls`、没有正文和片段时，只执行 API，不发送额外消息。

## 外部工具 tools

每项包含 `name` 及可选的 `description`、`schema`、`timeout_seconds`、`endpoint`、`foreground_only`。`schema` 是模型调用该工具时使用的参数 Schema，`endpoint` 是 Elwisp 自己实现的 HTTP JSON POST 接口。

外部工具默认允许，单 Elwisp 的 `disabled_external_tools` 可禁用指定工具；模型侧以 `elwisp_<elwisp>_<tool>` 命名。宿主按 low 风险接入，外部工具自行负责实际风险边界，不通过事件指定风险等级。内部工具和 Skill 则受 `allowed_tools` 与 Tool Runtime 的裁决。

## direct 示例

```json
{
  "version":"elvena.v3",
  "elwisp":{"name":"example-elwisp","tags":["example"]},
  "source":"example-source",
  "id":"stable-event-id",
  "mode":"direct",
  "title":"事件标题",
  "content":"可直接通知给管理员的文本。",
  "targets":[{"platform":"cli"}]
}
```

完整发送脚本见 [minimal-direct](../examples/minimal-direct/)。

## llm 示例

```json
{
  "version":"elvena.v3",
  "elwisp":{"name":"example-elwisp"},
  "source":"example-source",
  "id":"stable-event-id",
  "mode":"llm",
  "title":"需要分析的事件",
  "format":"elyph",
  "content":"#task review_event - 判断事件是否需要通知\n** 基于事件内容和 meta 分析\n~ 编造日志、指标或结论\n> 如果需要通知，给出原因和建议；否则说明无需打扰。",
  "tool_list_names":[],
  "targets":[{"platform":"cli"}],
  "meta":{}
}
```

后台任务使用结构化结果决定是否报告；`need_report=false` 时不会向 targets 发送报告。所属用户恢复后台 Session 后，该会话转为普通前台会话，不再自动汇报或补投递。

### LLM 结果中的 report_segments

```json
{
  "completed":true,
  "need_report":true,
  "report":"分析完成，见截图。",
  "report_segments":[{"type":"image","url":"chart.png"}]
}
```

`report_segments` 使用 `type`，与入站 `segments` 的 `kind` 不同。`url` 可使用任务工作目录内的相对路径或 `media:<sha256>`；已有 HTTP(S) 来源也可使用。本地路径不能是绝对路径、`~`、`..`，也不能通过 symlink/junction 越出任务目录。宿主在准备报告时导入文件，outbox 保存稳定媒体引用，原 workspace 文件删除后仍可重试。

## HTTP 响应

```json
{
  "accepted":true,
  "duplicate":false,
  "event_key":"server-watchdog/minecraft-main/cpu-alert-001",
  "mode":"llm",
  "status":"queued"
}
```

响应包含 `accepted`、`duplicate`、`event_key`、`mode`、`status`，失败时可附带 `error`。llm 的 HTTP 响应只说明事件接收或排队情况，不等待后台模型完成。direct 在响应前执行调用和投递，不能把任意 HTTP 响应都当成动作执行成功。

鉴权失败返回 `401`，无效 JSON 或未接纳的请求返回 `400`，事件接口不支持的方法返回 `405`，停止接入时返回 `503`。同时检查响应 JSON 的接收状态和错误信息。

## 健康检查

```text
GET /healthz
```

返回 `200` 及 `{"ok":true}` 表示 HTTP runtime 正在接收请求。
