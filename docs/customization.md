# 定制模块维护说明

上游基准为 `1.26.10`。定制逻辑通过明确的函数调用和组件插槽接入，原版业务流程留在上游文件中。
不复制整份上游文件，不在运行时替换导出函数，也不使用脚本匹配、改写上游源码。

## 模块与接入点

| 上游接入点                                 | 定制模块                                                       | 职责                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `scripts/prepare.ts` 运行任务前            | `scripts/custom/prepare.ts`                                    | 替换具名内核下载任务，准备 macOS DNS helper；保留原有资源任务和 system-core-only 过滤 |
| `config/app.ts` 读取、保存配置             | `main/custom/config.ts`                                        | 迁移旧预览通道；导入和授权本地内核后才保存；关闭受控 DNS 前释放租约                   |
| `config/controledMihomo.ts` 读取、保存配置 | `main/custom/config.ts`、`main/sys/mihomo-system-dns.ts`       | 迁移空监听值；所有受控配置调用统一经过 DNS 释放检查                                   |
| `core/factory.ts` 原有清理完成后           | `main/custom/profile.ts`                                       | 删除合并后的空监听标记，避免订阅重新启用监听                                          |
| `core/manager.ts` 生命周期                 | `main/custom/core-lifecycle.ts`                                | 启动前准备本地内核，验证 TUN，再接管 DNS；停止前恢复 DNS；保持轻量模式中的有效内核    |
| `core/mihomoApi.ts` PATCH、升级入口        | `main/sys/mihomo-system-dns.ts`、`main/core/custom-updater.ts` | 实时配置也先恢复 DNS；升级转交自定义 Release 更新器                                   |
| `utils/dirs.ts` 内置内核路径               | `main/custom/paths.ts`                                         | 在更新副本与打包内核之间选择较新版本                                                  |
| 内核、DNS、高级设置页                      | `renderer/src/custom/`                                         | 自定义内核选项、本地导入、DNS 监听输入及 UDP 回退开关                                 |
| 更新判断与界面开关                         | `shared/custom-build.ts`、`renderer/src/custom/policy.ts`      | 处理自定义版本后缀，控制官方应用更新入口及旧 DNS 选项                                 |
| 类型系统                                   | `shared/types/custom.d.ts`                                     | 使用接口声明合并扩展类型，上游类型文件保持原样                                        |

表中 `main` 和 `shared` 路径以 `src/` 为根。
hook 的编辑器 schema 和 Release 下载校验继续分别保存在已有的独立模块中。

IPC、托盘、快捷键、默认模板及原有 `build.yml` 已恢复为上游原样。
DNS 保护位于配置和 API 入口，覆盖 IPC、托盘、快捷键及内部直接调用。
macOS helper 的构建检查放在独立的 `Custom Build` 工作流中。

DNS 监听输入单独确认保存；原版 DNS 页的其他字段仍使用原有保存流程。
`udp-fallback` 未指定时沿用内核默认值 `true`，显式 `false` 在合并和清理后保留。

## 后续同步上游

1. 合并上游稳定版，保留上表中的少量接入调用。
2. 如果上游调整了配置保存或启动时序，检查对应接入点，不把定制实现重新内联回原文件。
3. 新增定制字段放入 `custom.d.ts`，新增设置放入 `renderer/src/custom/`。
4. 运行 `pnpm typecheck`、`pnpm test:custom`，再构建对应平台。

回归测试调用实际的配置模块和生命周期模块，只替换操作系统、文件、网络边界。
它们检查取消授权、启动失败和更新失败时是否保留原配置，以及恢复 DNS 是否发生在停止内核之前。
