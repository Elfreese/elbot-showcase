# calls-demo

演示 Elvena v3 的 `calls`：在 direct 模式下通过平台原生 API 执行动作，无需 LLM。

## 使用

先把 `send_event.sh` 中 `params` 的示例会话、消息、用户和群 ID 改成实际值，并确保对应平台已接入 ElBot。

```bash
export ELNIS_ENDPOINT=http://127.0.0.1:32170/elvena/v3/events
export ELNIS_TOKEN=your-token-here
./send_event.sh
```

脚本需要 Bash、curl 和 Python 3，与其他示例一致。

## 调用内容

| 平台 | 原生 API | 参数与作用 |
| --- | --- | --- |
| Telegram | `deleteMessage` | `chat_id`、`message_id`：删除消息。 |
| QQ OneBot | `set_group_ban` | `group_id`、`user_id`、`duration`：禁言指定成员，duration 单位为秒。 |
| QQ OneBot | `set_group_leave` | `group_id`：退出群聊。 |

每项只使用 `platform`、`api` 和 `params`。会话与对象标识放进原生 API 的 `params`；省略 `platform` 时由首个解析目标决定平台。

Elnis 按顺序执行调用，遇到失败便结束，不继续后续调用或通知。全部调用完成后，将正文发送到 `targets`。如只需执行 API，可省略 `content` 和 `segments`，此时不发送额外消息。

`targets` 仍是必填的非空数组。CLI 通知需要前台 `elbot run` 或已启用 CLI 远程服务的 service；`elbot client` 需连接对应服务端。

完整字段说明见 [Elvena v3 协议](../../docs/elvena-v3.md#calls平台动作调用)。

---

# calls-demo

Demonstrates Elvena v3 `calls`: invoke native platform APIs in direct mode without an LLM.

## Usage

Replace the example chat, message, user, and group IDs in `send_event.sh` with actual values, and connect the corresponding platforms to ElBot.

```bash
export ELNIS_ENDPOINT=http://127.0.0.1:32170/elvena/v3/events
export ELNIS_TOKEN=your-token-here
./send_event.sh
```

The script uses Bash, curl, and Python 3, like the other examples.

## Calls

| Platform | Native API | Parameters and effect |
| --- | --- | --- |
| Telegram | `deleteMessage` | `chat_id`, `message_id`: delete a message. |
| QQ OneBot | `set_group_ban` | `group_id`, `user_id`, `duration`: mute a member; duration is in seconds. |
| QQ OneBot | `set_group_leave` | `group_id`: leave a group. |

Each call uses only `platform`, `api`, and `params`. Put conversation and object IDs directly in the native API parameters. If `platform` is omitted, Elnis uses the first resolved target's platform.

Elnis executes calls in order. A failed call stops subsequent calls and notification delivery. After all calls succeed, the body is sent to `targets`. For API-only execution, omit both `content` and `segments`; no extra message is sent.

`targets` remains a required, nonempty array. CLI notifications require foreground `elbot run` or a service with the remote CLI server enabled; `elbot client` must connect to that server.

Full reference: [Elvena v3 Protocol](../../docs/elvena-v3.md#calls平台动作调用).
