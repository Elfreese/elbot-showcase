# Elwisp 概述

## 什么是 Elwisp

Elwisp 是 ElBot 生态中的**外部事件监听器**。

它的职责很纯粹：观察某个外部信息源，发现值得注意的事件后，按 Elvena v3 协议向 Elnis 上报。

Elwisp 不参与：
- 聊天平台消息收发
- 复杂决策
- 工具调度

它只做一件事：**观察 → 上报**。

## 角色分工

```
Elwisp  ─观察者─▶  外部世界 (RSS, Webhook, 日志, ...)
   │
   ▼
Elnis   ─枢纽──▶  鉴权、校验、去重、记录、分发
   │
   ▼
ElBot   ─执行者─▶  record / direct 通知 / llm 分析
```

### Elwisp 负责

- 监听外部信息来源
- 构造符合 Elvena v3 的事件
- 上报到 Elnis
- 通过 `tools` 声明自己提供的外部工具，通过 `tool_list_names` 请求 ElBot 内部工具或 Skill
- 管理自己的状态和重试

### Elnis 负责

- 鉴权（Bearer token）
- 协议版本校验
- 事件去重（`elwisp.name + source + id`）
- 根据 mode 分发：
  - record → 只记录
  - direct → 执行原生平台 `calls`，按片段或正文通知 targets
  - llm → 启动后台 LLM Session
- 工具可用性裁决

### ElBot 负责

- 执行 tool_list_names 声明的工具/Skill
- 按 ELyph task 分析事件
- 将结果通知到指定平台

## 典型 Elwisp 场景

| 场景             | 监听对象        | mode   |
|------------------|----------------|--------|
| RSS 动画更新      | RSS 源         | llm    |
| GitHub webhook   | HTTP endpoint  | direct |
| 服务器健康检查    | 定时探活        | llm    |
| 日志异常          | 日志文件 tail   | llm    |
| 脚本运行结果      | cron/脚本 stdout | direct |
| 游戏服务器状态    | 定时查询 API    | direct |
| 传感器告警        | HTTP/串口      | direct |

当前字段和媒体边界见 [Elvena v3 协议](elvena-v3.md)。媒体由宿主 Media Center 归档，Elwisp 不取得宿主媒体导出路径或管理 RPC。

## 开发 Elwisp 的步骤

1. 确定监听源和触发条件
2. 选择 mode（record / direct / llm）
3. 确定 source 和 id 生成策略（id 在同一 source 内稳定唯一）
4. 构造 payload
5. 决定 targets（cli / telegram / all）
6. 如果 mode=llm，编写 ELyph task 作为 content
7. 声明需要的工具（tool_list_names 或 tools）
8. 设置 token 环境变量
9. 测试
