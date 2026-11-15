# 独立部署 Codex Web

部署包内置与 Sparkle 相同的移动端网页和网关，不需要安装 Sparkle、Mihomo、npm 依赖或构建工具。服务和 Codex 必须运行在同一台电脑上；手机通过局域网访问网页。

## MacBook Apple Silicon

下载本次 Release 的 `sparkle-codex-web-<版本>-macos-arm64.tar.gz`，解压后进入目录，运行：

```sh
./start.sh
```

支持 macOS 13.5 及更新版本，自带 Node.js 24 ARM64，无需另外安装 Node。终端保持打开，按 Ctrl+C 停止；不注册后台服务、不修改系统设置或 Codex 配置。

## 已有 Node 的其他环境

下载 `sparkle-codex-web-<版本>-node.tar.gz`，需要 Node.js 24 或更新版本。macOS / Linux 运行 `./start.sh`；Windows 运行 `start.cmd`。也可直接运行 `node server.cjs`。无须 `npm install`，可离线启动。

## 端口与 Codex

| 参数         | 默认值  | 监听地址    | 用途                       |
| ------------ | ------- | ----------- | -------------------------- |
| `--port`     | `38471` | `127.0.0.1` | 本机 Codex app-server 接入 |
| `--web-port` | `38472` | `0.0.0.0`   | 手机网页及浏览器连接       |

需要调整时，例如：

```sh
./start.sh --port 39471 --web-port 39472
```

在同一电脑的自定义 Codex 中，由用户手动在 `~/.codex/config.toml` **顶层**设置相应接入端口（放在首个 `[table]` 前）：

```toml
web_server_port = 38471
```

需要支持该字段的自定义 Codex；原版 Codex 不会主动连接。配置后重启相应 Codex app-server（共享后台也需重启），再打开会话。该字段始终填写 `--port` 的值，不能填写网页端口。网关不会安装、启动或升级 Codex，不读取或写入其配置、登录凭据。

手机打开 `http://电脑的局域网IP:38472/`，本机可打开 `http://127.0.0.1:38472/`。网页可查看、新建、恢复会话，发送消息、审批、回答问答及浏览项目文件。网页无需登录，请在可信局域网临时使用。首次启动时，macOS 如询问是否允许本地网络连接，请允许。

Sparkle 内置服务若已占用这两个端口，请退出对应服务或改用另一组端口，并同步手动调整 Codex 接入端口；不会自动抢占或换端口。

支持 `--help` 和 `--version`。可从任意工作目录启动脚本，网页路径始终相对部署包解析。

## 校验与许可

Release 附带 `SHA256SUMS`，包含两种独立部署包的 SHA-256。包内附 GPLv3 `LICENSE` 与 `THIRD_PARTY_NOTICES.txt`；Mac 包另附 Node 运行时许可。对应版本源码：<https://github.com/SeventyfourSam/sparkle/releases>，选择相同版本的 Source code。
