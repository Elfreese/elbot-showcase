# Elwisp

让 ElBot 听到外部世界的声音——一条 curl 命令就能打通。

**Elwisp** 是 [ElBot](https://github.com/Elflare/elbot) 生态的外部事件监听参考，帮你用最短时间把任何外部信号（RSS、Webhook、日志、服务器状态……）接入 ElBot，让它替你记录、通知或智能分析，无需从零研究协议。基于 Elvena v3 协议。

## 你能用它做什么

| 场景 | 一句话 |
|------|--------|
| 服务器挂了自动通知 | 定时探活，宕机立刻推送到手机/桌面 |
| RSS 更新摘要推送到聊天 | 动画更新、博客发布、安全公告，让 LLM 帮你总结后再通知 |
| GitHub webhook 转通知 | star、issue、PR、CI 失败，实时推送到管理会话 |
| 日志异常告警 | tail 日志文件，发现错误立即上报分析 |
| 脚本/定时任务结果回传 | cron 跑完直接通知结果，不用开屏幕看 |
| 游戏/设备状态监控 | Minecraft 服务器、传感器、智能家居事件 |

**把任何「外面发生了什么」变成 ElBot 能处理的事件。**

## 为什么值得用

- **零学习曲线**：复制 `send_event.sh`，改几行 payload，一条 curl 就能通
- **安全优先**：所有示例遵循 token 环境变量、127.0.0.1 绑定、不硬编码等安全规范
- **三种模式覆盖所有需求**：只记录 / 直接通知 / 交给 LLM 分析，按需选择
- **协议文档齐全**：Elvena v3 字段说明、JSON Schema 校验、segments/calls 用法一应俱全
- **拿来即用，也可扩展**：最小示例验证链路后，可直接改造成生产监听器

## 链路

```
外部世界
  ↓
Elwisp 监听器
  ↓  Elvena v3 (JSON over HTTP)
Elnis 事件枢纽
  ↓
ElBot: record / direct / llm
```

## 三种模式

| 模式 | 说明 |
|------|------|
| record | 只记录 |
| direct | 调用平台原生 API 或直接通知 |
| llm | 后台 LLM 分析并决定是否通知 |

## 快速开始

先按 [Elnis 配置与使用](https://github.com/Elflare/elbot/blob/main/docs/elnis-usage.md) 启用 Elnis，并让 token 配置引用 `ELNIS_TOKEN`。示例需要 Bash、curl 和 Python 3。

```bash
git clone https://github.com/Elfreese/elbot-showcase.git
cd elbot-showcase/elwisp

cp .env.example .env
# 编辑 .env，填入 ELNIS_TOKEN

cd examples/minimal-direct
set -a
. ../../.env
set +a
./send_event.sh
```

如果聊天客户端收到了「测试事件」，链路就通了。

## 目录

```
elwisp/
├── README.md
├── .env.example
├── docs/
│   ├── elwisp-overview.md
│   ├── elvena-v3.md
│   └── security.md
├── schemas/
│   └── elvena-v3.schema.json
├── scripts/
│   └── curl-healthz.sh
└── examples/
    ├── minimal-direct/
    │   ├── README.md
    │   └── send_event.sh
    ├── minimal-llm/
    │   ├── README.md
    │   └── send_event.sh
    └── calls-demo/
        ├── README.md
        └── send_event.sh
```

## 相关项目

- [ElBot](https://github.com/Elflare/elbot) — 驱动一切的聊天机器人引擎

## 核心原则

- Elwisp 只观察和上报，不直接向聊天平台发消息
- Token 只从环境变量读取
- 事件身份由 `elwisp.name + source + id` 组成，同一外部事件使用稳定 ID
- targets 由事件明确声明
- 外部工具 endpoint 默认绑定 127.0.0.1

---

# Elwisp

Give ElBot ears to the outside world — just a single curl command away.

**Elwisp** is the external event listener reference for the [ElBot](https://github.com/Elflare/elbot) ecosystem — connect any external signal (RSS, webhook, logs, server status…) to ElBot in minutes. It records, notifies, or analyzes for you, no need to study the protocol from scratch. Based on the Elvena v3 protocol.

## What you can do

| Scenario | In a nutshell |
|----------|---------------|
| Uptime alerts | Ping your server; if it's down, get notified instantly on your chat app |
| RSS-to-chat summaries | New anime episode, blog post, or CVE — let the LLM summarize before notifying you |
| GitHub events in chat | Star, issue, PR, CI failure — stream them to your admin session in real time |
| Log anomaly detection | Tail your log files; if something breaks, ElBot analyzes and alerts you |
| Script/cron result delivery | Get cron job results pushed to chat, no need to SSH and check manually |
| Game / device monitoring | Minecraft server status, sensors, smart home events |

**Turn anything that happens outside into an event ElBot can handle.**

## Why this matters

- **Zero learning curve** — copy `send_event.sh`, tweak a few payload fields, one curl, done
- **Secure by default** — all examples respect token-in-env, 127.0.0.1 binding, no hardcoded secrets
- **Three modes, one protocol** — record, direct notify, or LLM-powered analysis; pick what fits
- **Complete protocol reference** — Elvena v3 field guide, JSON Schema, segments/calls documentation
- **Copy, paste, adapt** — minimal examples validate the pipeline, then evolve into production watchers

## Pipeline

```
Outside World
  ↓
Elwisp Watcher
  ↓  Elvena v3 (JSON over HTTP)
Elnis Event Hub
  ↓
ElBot: record / direct / llm
```

## Three Modes

| Mode   | Description |
|--------|-------------|
| record | Log only |
| direct | Invoke native platform APIs or send notifications |
| llm    | Background LLM analysis with tool access |

## Quick Start

Enable Elnis using the [configuration guide](https://github.com/Elflare/elbot/blob/main/docs/elnis-usage.md), with its token configuration referencing `ELNIS_TOKEN`. The examples use Bash, curl, and Python 3.

```bash
git clone https://github.com/Elfreese/elbot-showcase.git
cd elbot-showcase/elwisp

cp .env.example .env
# Edit .env with your ELNIS_TOKEN

cd examples/minimal-direct
set -a
. ../../.env
set +a
./send_event.sh
```

If you received "测试事件" in your chat client, the pipeline is live.

## Directory

```
elwisp/
├── README.md
├── .env.example
├── docs/
│   ├── elwisp-overview.md
│   ├── elvena-v3.md
│   └── security.md
├── schemas/
│   └── elvena-v3.schema.json
├── scripts/
│   └── curl-healthz.sh
└── examples/
    ├── minimal-direct/
    │   ├── README.md
    │   └── send_event.sh
    ├── minimal-llm/
    │   ├── README.md
    │   └── send_event.sh
    └── calls-demo/
        ├── README.md
        └── send_event.sh
```

## Related

- [ElBot](https://github.com/Elflare/elbot) — the chat bot engine that powers everything

## Core Principles

- Elwisp only observes and reports; never sends chat messages directly
- Token only from environment variables
- Event identity is `elwisp.name + source + id`; use a stable ID for the same external event
- targets are explicitly declared per event
- External tool endpoints default to 127.0.0.1

## License

MIT
