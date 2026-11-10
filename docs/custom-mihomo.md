# 自定义 Mihomo

`custom` 分支基于 Sparkle 上游稳定版 `1.26.10`，当前应用版本为 `1.26.10-custom.2`。
内置内核及在线更新均使用 [SeventyfourSam/mihomo 的正式 Release](https://github.com/SeventyfourSam/mihomo/releases/latest)。
当前提供 Windows x64 和 macOS arm64，首次接入的版本为 `v1.19.33-custom.2`。
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

「内核设置」中的下载按钮检查自定义正式 Release。旧的内置预览版选择自动迁移为内置自定义版。
更新先完成下载、校验和可执行文件检查，再切换内核；启动或版本校验失败会恢复原内核。
更新文件保存在应用数据目录，不修改安装目录，后续应用包带有更新内核时优先使用较新版本。
通过「导入本地内核」选择的内核仍由用户重新导入更新。

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
GitHub Actions 的 `Custom Build` 工作流可手动构建上述两个平台，并上传构建产物，不自动发布 Release。

定制代码的目录和上游接入点见 [定制模块维护说明](customization.md)。
