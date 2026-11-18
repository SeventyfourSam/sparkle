# AgentServer 迁移

Codex / Claude 网关与移动端页面已移至独立项目 `D:/projects/AgentServer`。Sparkle 不再内嵌服务代码和依赖，只负责启动用户指定的外部可执行文件。

在 Sparkle 设置的 **AgentServer** 卡片中选择独立程序、设置本机接入端口（默认 38471）与网页端口（默认 38472），启用“随 Sparkle 自动启动”，保存并应用。Windows 选择 `AgentServer.exe`，macOS / Linux 选择具有执行权限的 `AgentServer`。没有配置时不会启动服务。

启动配置单独保存在 Sparkle 数据目录的 `agent-server.json`，不改动现有代理配置。Sparkle 以 `--managed --port <port> --web-port <webPort>` 启动程序，启动目录为程序所在目录，不经 Shell。程序就绪后通过 stdout 发出一行 `AGENT_SERVER_READY {"protocolVersion":1,"pid":... ,"port":...,"webPort":...}`；stdin 关闭表示请求优雅退出。Sparkle 只关闭自己启动的子进程，不接管已独立运行的服务。端口冲突或文件无效会显示错误。

修改配置后重启服务；取消启用会停止所托管进程。退出 Sparkle 时优雅停止，Sparkle 意外退出时由管道关闭通知 AgentServer 自行清理。异常退出有限次退避重试；自动轻量模式在启用服务时保留托盘。

AgentServer 仍可脱离 Sparkle 单独运行。服务的配置、数据、Claude 入口和 Bark 均由 AgentServer 管理；Sparkle 不读写 Codex 的 TOML、Claude 账户或 Bark key。已有 Sparkle 用户数据保留。详见 AgentServer 项目 README。
