# ElBot Web Frontend

可运行的 ElBot 网页客户端，包含聊天、日志和设置页面。完整 HTML、CSS 和 JavaScript 源码，无需构建，放入 ElBot 配置目录的 `frontend/` 后即可通过 ElBot 自己的端口访问。

## 截图

### 浅色与深色主题

<p>
  <img src="../assets/frontend/web-light.png" width="49%" alt="ElBot Web 前端浅色主题" />
  <img src="../assets/frontend/web-dark.png" width="49%" alt="ElBot Web 前端深色主题" />
</p>

### 结构化状态卡

![ElBot Web 前端 /status 状态卡](../assets/frontend/web-status.png)

以上为实际运行截图。界面概念稿见 [frontend-concepts](../frontend-concepts/)，TUI 截图见[仓库首页](../README.md)。

## 功能

- **聊天**：会话搜索与恢复、当前页/总页数、向上加载历史、模型选择、运行状态与用量、可点击确认及拒绝原因。
- **消息**：Markdown、代码与消息复制、可折叠思考过程；文件选择、拖放、粘贴上传，附件下载及图片预览。
- **补全**：Tab 补全 `/` 命令、`@` 工具和 `#` 待发送附件名。
- **日志**：运行、审计和 Elnis 日志，支持等级、时间、事件、字段筛选及自动刷新。
- **设置**：配置文件表单与原文编辑、配置诊断、重启，以及保存时的版本冲突检查。
- **Providers**：新增、编辑、删除；运行模型列表、手动补充、上下文窗口和模型独立配置；额外参数支持类型表格与 JSON 编辑。
- **界面**：明暗主题、独立通知栏、响应式布局，以及持久登录。

## 使用

需要支持当前管理功能的 ElBot 版本。接口说明统一见 [ElBot API 文档](https://elfreese.github.io/elbot-landing/docs/api/)。

1. 将本目录整体复制到 ElBot 主配置文件所在目录。在本仓库根目录执行：

   ```sh
   cp -R frontend ~/.config/elbot/
   ```

   入口应为 `~/.config/elbot/frontend/index.html`；使用自定义主配置文件路径时，放在相应主配置文件旁。

2. 在现有 `app.toml` 中启用 CLI 远程服务；已有对应配置节时直接修改：

   ```toml
   [platform.cli]
   enabled = true

   [platform.cli.server]
   enabled = true
   listen = "127.0.0.1:32172"

   [platform.cli.server.tokens]
   my-client = ["ELBOT_CLI_TOKEN"]
   ```

3. 在服务进程环境或配置目录的 `.env` 中设置 `ELBOT_CLI_TOKEN` 的实际值，然后启动或重启服务：`elbot service run`。
4. 打开 `http://127.0.0.1:32172/`，Client ID 填 `my-client`，Token 填环境变量的实际值。

页面与远程 CLI 共用监听端口，无需另启 Web 服务器。首次添加 `frontend/index.html` 后需重启服务；之后修改前端文件，刷新页面即可。

## 会话、登录与主题

聊天页读取当前绑定的会话和状态；未绑定会话时显示欢迎页。点击“新对话”或选择侧栏会话可切换，历史消息按页加载。普通断线重连不会自动重发输入。

认证成功后，Client ID 和 Token 保存在当前站点的 `localStorage`，刷新或重新打开浏览器后自动连接；退出登录会清除保存的凭据。浏览器不持久保存聊天记录，记录从服务端会话读取；历史附件只展示名称，不复用失效的下载凭据。

主题首次跟随系统，手动选择后保存在 `localStorage`。

## 日志与设置

顶部导航切换聊天、日志和设置，对应 `#/chat`、`#/logs`、`#/settings`。

日志页可查询三类日志，展开查看完整记录；自动刷新仅在页面可见时进行。

设置页选择配置文件后，可使用表单或原文编辑。修改先保留为草稿，保存才写入磁盘；外部修改导致版本冲突时保留草稿，按页面提示重载合并。

选择 `providers.toml` 可管理 Provider 与模型。切换 Provider 会保留未完成的输入，额外参数可在表格与 JSON 间切换。模型的“手动补充”和独立参数分开管理，清除配置不移除手动补充。

- **保存并应用**：保存 Provider 配置，再重新加载配置并刷新模型列表，无需重启 ElBot。
- **仅保存**：只写入文件，稍后点击“重新应用”。应用失败或部分 Provider 获取模型失败时，页面会显示原因，可修正后重试。
- 其他运行配置按页面提示在重启后生效；重启前可使用“诊断”检查已保存的配置。

## 修改界面

```text
frontend/
├── index.html
├── app.js              # 页面装配
├── app.css             # 样式入口
├── core/               # 登录、连接、请求与路由
├── pages/              # 聊天、日志、设置
├── chat/               # 消息、会话、模型与附件
├── styles/             # 各页面样式
├── assets/             # Logo
└── vendor/             # 本地依赖与许可证
```

HTML、CSS 和原生 JavaScript 模块均可直接修改。Markdown 由 Marked 解析，再由 DOMPurify 清理；TOML 表单编辑使用 toml-patch，保留未编辑字段和注释。依赖与许可见 [vendor/README.md](vendor/README.md)。

---

# ElBot Web Frontend

A runnable ElBot web client with chat, logs, and settings pages. Complete HTML, CSS, and JavaScript source is included, with no build step. Place this directory alongside ElBot's main configuration file as `frontend/` to serve it on ElBot's own port.

## Screenshots

### Light and dark themes

<p>
  <img src="../assets/frontend/web-light.png" width="49%" alt="ElBot web frontend in light mode" />
  <img src="../assets/frontend/web-dark.png" width="49%" alt="ElBot web frontend in dark mode" />
</p>

### Structured status card

![ElBot web frontend /status card](../assets/frontend/web-status.png)

These are screenshots of the running client. Interface concepts are in [frontend-concepts](../frontend-concepts/); the TUI screenshot is on the [repository homepage](../README.md).

## Features

- **Chat**: session search and resume, current/total page numbers, paginated history, model selection, runtime status and usage, and confirmation actions with optional rejection reasons.
- **Messages**: Markdown, code and message copying, collapsible reasoning, file picker, drag-and-drop and paste uploads, attachment downloads, and image previews.
- **Completion**: Tab completion for `/` commands, `@` tools, and `#` filenames attached to the current draft.
- **Logs**: runtime, audit, and Elnis logs with level, time, event, and field filters, plus automatic refresh.
- **Settings**: configuration forms and source editing, diagnostics, restart, and revision checks when saving.
- **Providers**: add, edit, and delete providers; browse runtime models, supplement models manually, and edit context windows and per-model configuration. Extra parameters support typed tables and JSON.
- **Interface**: light and dark themes, a separate notification panel, responsive layouts, and persistent login.

## Setup

Use an ElBot version supporting the current management features. Refer to the [ElBot API documentation](https://elfreese.github.io/elbot-landing/docs/api/) for all API details.

1. Copy this entire directory alongside ElBot's main configuration file. From this repository's root:

   ```sh
   cp -R frontend ~/.config/elbot/
   ```

   The entry point should be `~/.config/elbot/frontend/index.html`. For a custom configuration path, place it alongside that main configuration file.

2. Enable the remote CLI server in the existing `app.toml`, editing existing sections if present:

   ```toml
   [platform.cli]
   enabled = true

   [platform.cli.server]
   enabled = true
   listen = "127.0.0.1:32172"

   [platform.cli.server.tokens]
   my-client = ["ELBOT_CLI_TOKEN"]
   ```

3. Set the actual `ELBOT_CLI_TOKEN` value in the service process environment or the configuration directory's `.env`, then start or restart ElBot with `elbot service run`.
4. Open `http://127.0.0.1:32172/`, enter `my-client` as Client ID, and use the environment variable's actual value as Token.

The page shares the remote CLI server's listening port; no additional web server is required. Restart ElBot after first adding `frontend/index.html`. Later frontend edits can be loaded by refreshing the page.

## Sessions, login, and theme

The chat page reads the currently bound session and status, showing the welcome page when no session is bound. Use New Chat or the sidebar to switch sessions. History is loaded by page. An ordinary reconnect does not automatically resend input.

After successful authentication, Client ID and Token are stored in the site's `localStorage` and restored on refresh or reopening the browser. Logging out clears the saved credentials. Chat history is read from server-side sessions rather than persisted in the browser. Historical attachments show names only and do not reuse expired download credentials.

The initial theme follows the system. A manual choice is saved in `localStorage`.

## Logs and settings

The top navigation switches between chat, logs, and settings at `#/chat`, `#/logs`, and `#/settings`.

The logs page queries the three log categories and expands records for details. Automatic refresh runs only while the page is visible.

Select a configuration file in Settings to use its form or source editor. Changes remain drafts until saved. Revision conflicts caused by external edits preserve the draft; follow the page's instructions to reload and merge.

Select `providers.toml` to manage providers and models. Switching providers preserves incomplete input. Extra parameters can be edited as a table or JSON. Manual model supplements and per-model configuration are independent: clearing configuration keeps the supplement.

- **Save and apply**: save the provider configuration, reload it, and refresh the model catalog without restarting ElBot.
- **Save only**: write the file and apply it later with Reapply. Application failures and individual provider model-fetch errors are displayed so they can be corrected and retried.
- Other runtime settings take effect after restart as indicated by the page. Use diagnostics to check saved configuration before restarting.

## Customization

`index.html` is the entry point; `app.js` assembles the pages and `app.css` imports their styles. `core/` handles authentication, connections, requests, and routing; `pages/` contains chat, logs, and settings; `chat/` handles messages, sessions, models, and attachments. Styles, logos, and bundled dependencies live in `styles/`, `assets/`, and `vendor/`.

Edit the HTML, CSS, and native JavaScript modules directly. Marked parses Markdown and DOMPurify sanitizes it. TOML form editing uses toml-patch to preserve untouched fields and comments. Bundled dependencies and licenses are listed in [vendor/README.md](vendor/README.md).
