# 自定义 Mihomo

`custom` 分支自动跟随 Sparkle 上游正式版，应用版本格式为 `上游版本-custom.修订号`。
内置内核及在线更新均使用 [SeventyfourSam/mihomo 的正式 Release](https://github.com/SeventyfourSam/mihomo/releases/latest)。
当前提供 Windows x64 和 macOS arm64，内置带有 `/upgrade` 自更新适配的 Mihomo 正式版。
构建及更新按 Release 中的实际文件名下载，并验证 `SHA256SUMS`；不回退到官方内核。

## UDP 规则回退

在「内核设置 → 高级设置 → UDP 规则回退」中设置，默认开启，与 Mihomo 默认行为一致。

```yaml
udp-fallback: false
```

关闭后，规则命中的出站不支持 UDP 时直接失败，不再继续匹配下一条规则。
它只影响新建 UDP 关联，不改变代理组内选点、重试及 PASS 规则的含义。
界面修改会保存并重启内核；通过内核配置 API 也可以实时 PATCH `udp-fallback`。
显式的 `false` 会保留在最终运行配置中。

## 手写 hook

在订阅的 YAML 配置或 YAML 覆写中手写，配置编辑器提供补全和校验；不增加 hook 管理界面。
未引用 provider 时不启用任何 hook。示例地址需替换为自己的服务：

```yaml
hook-providers:
  RegisterHost:
    type: api
    mode: async
    url: http://127.0.0.1:1234/hooks/host
    timeout: 2s
  ConfirmIp:
    type: api
    mode: sync
    url: http://127.0.0.1:1234/hooks/ip
    timeout: 2s
    on-error: block
    success-status: 200
    confirmation-ttl: 30s

hooks:
  - event: HOST
    match: DOMAIN-SUFFIX,example.com
    providers: [RegisterHost]
  - event: IP
    match: DOMAIN-SUFFIX,example.com
    providers: [ConfirmIp]
```

`hooks` 和 `hook-providers` 会随原配置及覆写进入运行配置。规则独立于业务出站匹配。
同步 IP hook 成功后才放行业务目标；异步事件使用内存队列，不保证持久化。
完整字段和时序说明见 [内核 hooks 文档](https://github.com/SeventyfourSam/mihomo/blob/custom/docs/hooks.md)。

## 内核更新

「内核设置」中的下载按钮沿用原版调用方式：向运行中的 Mihomo 发送 `POST /upgrade?channel=release`。
Mihomo 自行从 `SeventyfourSam/mihomo` 下载、替换并重启。Sparkle 不再另行下载内核或维护更新副本。
旧的内置预览版选择自动迁移为内置内核，手动导入功能保留。

## Sparkle 更新与自动发布

应用更新清单、安装包和下载链接统一来自 `SeventyfourSam/sparkle`。
版本比较保留完整的 `-custom.N` 后缀，因此同一上游版本的不同修订也能正常发现和安装更新。
保留原版的自动检查开关、下载校验和安装流程；旧的滚动通道设置迁移为正式版。

`Custom Release` 每天 09:37（Asia/Singapore）检查上游最新正式 Release：

1. 有新正式版时合并到 `custom`。合并前将 `package.json` 的版本暂时对齐基础版本，避免版本后缀造成冲突。
2. 检查类型、运行回归测试，再推送合并结果和新的 `-custom.N` 版本。
3. 固定同一个 Mihomo Release，构建 Windows x64 和 macOS arm64。
4. 两个平台全部成功后，发布正式 Release、`latest.yml` 和 SHA-256 清单。

已成功发布的上游版本不重复构建；构建或发布失败时，下次每日任务会重试未发布版本。
合并冲突或测试失败时停止，不推送失败的合并。手动运行该工作流可以发布当前改动的新修订。

## 编译打包

```powershell
git switch custom
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:custom
pnpm build:win --x64
```

macOS arm64 在对应平台运行 `pnpm build:mac --arm64`。
`prepare` 会准备自定义内核及原有资源，首次安装需联网。
输出在 `dist`；Windows 便携包需在归档根目录加入空文件 `PORTABLE`。
GitHub Actions 的 `Custom Release` 工作流会构建上述两个平台并发布更新，可用 `gh workflow run custom-release.yml --ref custom` 手动运行。

定制代码的目录和上游接入点见 [定制模块维护说明](customization.md)。
