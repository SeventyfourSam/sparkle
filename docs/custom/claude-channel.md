# Claude Code 移动端 Channel

复用 Sparkle 的两个 Web 端口，默认网页为 `http://电脑局域网地址:38472/`。Codex 和 Claude 会话在同一个列表中展示、在同一页面打开；只有新建时选择会话类型，没有单独的 Claude 页面。Claude 桥接连接本机接入端口的 `/claude/channel`，不会额外开放端口。旧 `/claude` 网页地址会跳转回首页。

## 使用

1. 在电脑安装最新版官方 Claude Code，并在官方 CLI 中完成登录。支持官方订阅与 Console API Key；是否能使用 Channel 由 Claude 的版本、账号和组织策略决定。
2. 启动 Sparkle，在电脑浏览器打开 `http://127.0.0.1:38472/`，手机访问 `http://电脑局域网地址:38472/`。
3. 作为局域网自用工具，网页不设访问码或登录步骤。接入的 Codex 和 Claude 会话直接出现在同一个列表中。
4. 新建时选择 Codex 或 Claude，再选择工作目录。选择 Claude 后可新建，或填写完整会话 ID 恢复。首次启动时，在原生终端面板中阅读提示，手动完成项目信任、MCP 和开发 Channel 确认。面板只提供选择按键，不接受登录凭据或任意终端输入。
5. 接入后发送消息；工具权限请求会显示允许本次/拒绝。网页不会代替用户自动确认权限。

本机已将 `claude` 的默认启动参数接入 Sparkle，终端直接运行 `claude` 或 `claude --resume <会话ID>` 即可。`--version`、`--help`、`auth`、`update`、`mcp` 等管理命令和 `-p` 模式保持原来的行为。Sparkle 不运行时正常启动官方 CLI。已经运行但没有预先启用 Channel 的会话，需先退出，再用 `claude --resume <会话ID>` 恢复。

默认命令通过独立启动层实现，官方可执行文件继续原地更新。Windows 的 PowerShell 配置只追加一个带标记的加载块，CMD 使用用户 PATH 中的独立 shim；已有配置保留。默认入口记录在 `~/.local/share/sparkle/claude-command`，实际服务启动后会更新所用运行时、桥接文件与端口。安装默认入口由 `scripts/custom/install-claude-command.mts` 完成；网关只有在用户已启用它时更新启动层，测试实例不修改用户的默认命令。

Sparkle 不读写 `~/.claude.json`、`settings.json`、项目 MCP 配置或 Codex 配置。MCP 和只读事件 Hooks 仅通过当前进程的 `--mcp-config` / `--settings` 注入，原来的设置与 Hooks 仍由官方 CLI 合并。本机桥接的内部令牌、连接描述及启动脚本保存在 Sparkle 自己的数据目录中，全程自动传递，用户无需输入。

回复提供复制按钮（保留原始 Markdown），用户消息不显示复制按钮。URL、绝对路径和相对路径使用与 Codex 相同的链接与文件预览；会话内链接和文件在新标签页打开，目录内的子目录与 `..` 在当前标签页跳转。文件只读访问限制在该会话的项目目录中。

## 边界

- 自定义 Channel 仍处于官方研究预览，需要 `--dangerously-load-development-channels server:sparkle` 及原生手动确认。Sparkle 使用官方文档给出的自定义入口，不绕过账号或组织限制。如终端提示 Channels 不可用，请检查官方 CLI、账号及组织设置；MCP 初始化成功并不能证明 Channel 事件已被模型处理。
- 消息的“已提交通道”只代表 MCP 通知已写出。忙碌时 Claude 可以排队处理，调用回复工具后才显示“Claude 已回复”。断线或超时不自动重发。
- 工具审批采用原生 Channel permission relay，只影响本次调用。原终端和网页的首个有效答复生效；当前官方协议没有审批已在其他端完成的通知，所以原终端答复后网页可能暂留旧卡片。网页提交后也只确认已发送，不伪造执行结果。
- 原生 `/model`、`/resume` 等交互命令及 `AskUserQuestion` 问答不属于 Channel 消息协议，仍在原终端操作。恢复已有会话可通过新建对话框的会话 ID 输入完成。网页不把斜杠命令当普通消息发送。
- Sparkle 自己启动的进程可从网页中断和停止，退出 Sparkle/修改端口时一起停止；电脑终端启动的进程只断开桥接，不被 Sparkle 终止。关闭手机网页不会停止任务。
- 历史来自官方 CLI Hook 提供的当前会话 JSONL，只读、以 1 MiB 分块扫描，找到最近 10 条真实消息或文件起点后停止，每批最多 10 条消息，页面保留最多 20 条消息；工具调用、上下文压缩及终端记录不占消息额度，连续活动默认整体折叠，详情展开后分批读取。内存只保留有界消息摘要及活动位置，不将原始工具结果发送到折叠状态的网页；后续同步复用缓存，只处理追加的记录。翻页期间忽略同一次手势的后续滚动，保持当前阅读位置；更早历史按需读取。终端内部提示不显示。历史格式属于兼容层，未知记录跳过，实时片段与未确认消息不会无限积累。
- 网页按局域网自用方式提供服务，不要求访问码。原生桥接仍只接受本机直接连接，使用自动生成的内部令牌；浏览器 WebSocket 校验来源。Sparkle 不接管 Claude 登录，不读取 OAuth Token/Cookie，也不转发模型 API。

## 模块与验证

后端在 `src/main/custom/claude-channel/`，页面在 `src/renderer/src/custom/claude-channel/`，MCP 子进程入口构建为 `out/main/claude-channel.js`。`node-pty` 只用于官方交互 CLI，并隔离在独立子进程中；会话退出后释放其原生句柄并结束子进程。原生依赖及启动 helper 从 asar 解包，支持 Windows/macOS/Linux；macOS arm64 使用对应平台的预编译模块。会话生命周期使用只读 command Hook，其余高频事件使用 HTTP Hook；Hook 不返回权限决定。

`pnpm run test:claude-channel` 验证无需访问码的网页使用、本机桥接和来源限制、默认命令、会话生命周期、消息及审批、MCP stdio 契约、重连、会话切换保护和有界历史。不使用真实用户配置、模型服务或登录凭据。浏览器与真实 CLI 的隔离验证须另行执行；本地假 API Key 无法保证获得官方 Channel 研究预览资格。

官方参考：[Channels](https://code.claude.com/docs/en/channels)、[Channel 协议](https://code.claude.com/docs/en/channels-reference)、[Hooks](https://code.claude.com/docs/en/hooks)。
