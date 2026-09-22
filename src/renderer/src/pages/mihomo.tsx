import { Button, Select, SelectItem, Switch, Tab, Tabs } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import PermissionModal from '@renderer/components/mihomo/permission-modal'
import ServiceModal from '@renderer/components/mihomo/service-modal'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import PortSetting from '@renderer/components/mihomo/port-setting'
import { platform } from '@renderer/utils/init'
import { IoMdCloudDownload } from 'react-icons/io'
import PubSub from 'pubsub-js'
import {
  manualGrantCorePermition,
  mihomoUpgrade,
  restartCore,
  revokeCorePermission,
  findSystemMihomo,
  getFilePath,
  deleteElevateTask,
  installService,
  uninstallService,
  startService,
  initService,
  restartService
} from '@renderer/utils/ipc'
import React, { useState, useEffect } from 'react'
import ControllerSetting from '@renderer/components/mihomo/controller-setting'
import EnvSetting from '@renderer/components/mihomo/env-setting'
import AdvancedSetting from '@renderer/components/mihomo/advanced-settings'
import LogSetting from '@renderer/components/mihomo/log-setting'
import { notify } from '@renderer/utils/notification'

let systemCorePathsCache: string[] | null = null
let cachePromise: Promise<string[]> | null = null

const getSystemCorePaths = async (): Promise<string[]> => {
  if (systemCorePathsCache !== null) return systemCorePathsCache
  if (cachePromise !== null) return cachePromise

  cachePromise = findSystemMihomo()
    .then((paths) => {
      systemCorePathsCache = paths
      cachePromise = null
      return paths
    })
    .catch(() => {
      cachePromise = null
      return []
    })

  return cachePromise
}

getSystemCorePaths().catch(() => {})

const Mihomo: React.FC = () => {
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    core = 'mihomo',
    corePermissionMode = 'elevated',
    serviceRunMode = 'auto',
    coreStartupMode = 'post-up',
    mihomoCpuPriority = 'PRIORITY_NORMAL'
  } = appConfig || {}
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { ipv6 } = controledMihomoConfig || {}

  const [upgrading, setUpgrading] = useState(false)
  const [changingCore, setChangingCore] = useState(false)
  const [showPermissionModal, setShowPermissionModal] = useState(false)
  const [showServiceModal, setShowServiceModal] = useState(false)
  const [systemCorePaths, setSystemCorePaths] = useState<string[]>(systemCorePathsCache || [])
  const [loadingPaths, setLoadingPaths] = useState(systemCorePathsCache === null)
  const availableCorePaths = Array.from(
    new Set(
      [appConfig?.systemCorePath, ...systemCorePaths].filter((path): path is string => !!path)
    )
  )

  useEffect(() => {
    getSystemCorePaths()
      .then(setSystemCorePaths)
      .catch(() => {})
      .finally(() => setLoadingPaths(false))
  }, [])

  const onChangeNeedRestart = async (patch: Partial<MihomoConfig>): Promise<void> => {
    await patchControledMihomoConfig(patch)
    await restartCore()
  }

  const handleConfigChangeWithRestart = async (patch: Partial<AppConfig>): Promise<void> => {
    try {
      setChangingCore(true)
      if (!(await patchAppConfig(patch))) return
      await restartCore()
      PubSub.publish('mihomo-core-changed')
    } catch (e) {
      notify(e, { variant: 'danger' })
    } finally {
      setChangingCore(false)
    }
  }

  const handleCoreUpgrade = async (): Promise<void> => {
    try {
      setUpgrading(true)
      await mihomoUpgrade(core === 'mihomo' ? 'release' : 'alpha')
      setTimeout(() => PubSub.publish('mihomo-core-changed'), 2000)
    } catch (e) {
      if (typeof e === 'string' && e.includes('already using latest version')) {
        notify('已经是最新版本')
      } else {
        notify(e, { variant: 'danger' })
      }
    } finally {
      setUpgrading(false)
    }
  }

  const handleLocalCoreSelect = async (): Promise<void> => {
    try {
      const files = await getFilePath(['*'], '导入本地 Mihomo 内核', 'Mihomo 可执行文件')
      if (files?.[0]) {
        await handleConfigChangeWithRestart({ core: 'system', systemCorePath: files[0] })
      }
    } catch (e) {
      notify(e, { variant: 'danger' })
    }
  }

  const handleCoreChange = async (newCore: AppConfig['core']): Promise<void> => {
    if (newCore === 'system') {
      const systemCorePath = appConfig?.systemCorePath || (await getSystemCorePaths())[0]
      if (!systemCorePath) return handleLocalCoreSelect()
      await handleConfigChangeWithRestart({ core: newCore, systemCorePath })
    } else {
      await handleConfigChangeWithRestart({ core: newCore })
    }
  }

  const handlePermissionModeChange = async (key: string): Promise<void> => {
    if (key === corePermissionMode) return

    try {
      if (!(await patchAppConfig({ corePermissionMode: key as 'elevated' | 'service' }))) return
      await restartCore()
    } catch (e) {
      notify(e, { variant: 'danger' })
    }
  }

  return (
    <BasePage title="内核设置" contentClassName="no-scrollbar">
      {showPermissionModal && (
        <PermissionModal
          onChange={setShowPermissionModal}
          onRevoke={async () => {
            if (platform === 'win32') {
              await deleteElevateTask()
              notify('提权配置已取消')
            } else {
              await revokeCorePermission()
              notify('内核权限已撤销')
            }
            await restartCore()
          }}
          onGrant={async () => {
            await manualGrantCorePermition()
            notify(platform === 'win32' ? '提权配置成功' : '内核授权成功')
            await restartCore()
          }}
        />
      )}
      {showServiceModal && (
        <ServiceModal
          onChange={setShowServiceModal}
          onInit={async () => {
            await initService()
            notify('服务初始化成功')
          }}
          onInstall={async () => {
            await installService()
            notify('服务安装成功')
          }}
          onUninstall={async () => {
            await uninstallService()
            notify('服务卸载成功')
          }}
          onStart={async () => {
            await startService()
            notify('服务启动成功')
          }}
          onRestart={async () => {
            await restartService()
            notify('服务重启成功')
          }}
        />
      )}
      <SettingCard>
        <SettingItem
          compatKey="legacy"
          title="内核版本"
          actions={
            core === 'mihomo' || core === 'mihomo-alpha' ? (
              <Button
                size="sm"
                isIconOnly
                variant="light"
                isLoading={upgrading}
                onPress={handleCoreUpgrade}
              >
                <IoMdCloudDownload className="text-lg" />
              </Button>
            ) : null
          }
          divider
        >
          <div className="flex items-center gap-2">
            <Select
              aria-label="内核版本"
              classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
              className="w-37.5"
              size="sm"
              selectedKeys={new Set([core])}
              disallowEmptySelection={true}
              isDisabled={changingCore}
              onSelectionChange={(v) => handleCoreChange(v.currentKey as AppConfig['core'])}
            >
              <SelectItem key="mihomo">内置稳定版</SelectItem>
              <SelectItem key="mihomo-alpha">内置预览版</SelectItem>
              <SelectItem key="system">系统 / 本地内核</SelectItem>
            </Select>
            <Button size="sm" isLoading={changingCore} onPress={handleLocalCoreSelect}>
              导入本地内核
            </Button>
          </div>
        </SettingItem>
        {core === 'system' && (
          <SettingItem compatKey="legacy" title="内核文件路径" divider>
            <Select
              aria-label="内核文件路径"
              classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
              className="w-87.5"
              size="sm"
              selectedKeys={new Set([appConfig?.systemCorePath || ''])}
              disallowEmptySelection={availableCorePaths.length > 0}
              isDisabled={changingCore || (loadingPaths && availableCorePaths.length === 0)}
              onSelectionChange={(v) => {
                const selectedPath = v.currentKey as string
                if (selectedPath) handleConfigChangeWithRestart({ systemCorePath: selectedPath })
              }}
            >
              {availableCorePaths.length > 0 ? (
                availableCorePaths.map((path) => <SelectItem key={path}>{path}</SelectItem>)
              ) : loadingPaths ? (
                <SelectItem key="">正在查找系统内核...</SelectItem>
              ) : (
                <SelectItem key="">未找到系统内核</SelectItem>
              )}
            </Select>
            {!loadingPaths && availableCorePaths.length === 0 && (
              <div className="mt-2 text-sm text-warning">
                可从任意目录导入内核，Sparkle 会保存独立副本
              </div>
            )}
          </SettingItem>
        )}
        <SettingItem compatKey="legacy" title="内核进程优先级" divider>
          <Select
            aria-label="内核进程优先级"
            classNames={{ trigger: 'data-[hover=true]:bg-default-200' }}
            className="w-37.5"
            size="sm"
            selectedKeys={new Set([mihomoCpuPriority])}
            disallowEmptySelection={true}
            onSelectionChange={async (v) => {
              try {
                await patchAppConfig({
                  mihomoCpuPriority: v.currentKey as Priority
                })
                await restartCore()
              } catch (e) {
                notify(e, { variant: 'danger' })
              }
            }}
          >
            <SelectItem key="PRIORITY_HIGHEST">实时</SelectItem>
            <SelectItem key="PRIORITY_HIGH">高</SelectItem>
            <SelectItem key="PRIORITY_ABOVE_NORMAL">高于正常</SelectItem>
            <SelectItem key="PRIORITY_NORMAL">正常</SelectItem>
            <SelectItem key="PRIORITY_BELOW_NORMAL">低于正常</SelectItem>
            <SelectItem key="PRIORITY_LOW">低</SelectItem>
          </Select>
        </SettingItem>
        <SettingItem compatKey="legacy" title="运行模式" divider>
          <Tabs
            size="sm"
            color="primary"
            selectedKey={corePermissionMode}
            onSelectionChange={(key) => handlePermissionModeChange(key as string)}
          >
            <Tab key="elevated" title="直接运行" />
            <Tab key="service" title="系统服务" />
          </Tabs>
        </SettingItem>
        {platform === 'linux' && corePermissionMode === 'service' && (
          <SettingItem compatKey="legacy" title="服务核心运行方式" divider>
            <Tabs
              size="sm"
              color="primary"
              selectedKey={serviceRunMode}
              onSelectionChange={(key) =>
                handleConfigChangeWithRestart({
                  serviceRunMode: key as AppConfig['serviceRunMode']
                })
              }
            >
              <Tab key="auto" title="自动" />
              <Tab key="sandbox" title="沙盒" />
              <Tab key="direct" title="直接启动" />
            </Tabs>
          </SettingItem>
        )}
        {corePermissionMode !== 'service' && (
          <SettingItem compatKey="legacy" title="启动检测方式" divider>
            <Tabs
              size="sm"
              color="primary"
              selectedKey={coreStartupMode}
              onSelectionChange={(key) =>
                handleConfigChangeWithRestart({
                  coreStartupMode: key as AppConfig['coreStartupMode']
                })
              }
            >
              <Tab key="post-up" title="Post Up" />
              <Tab key="log" title="日志解析" />
            </Tabs>
          </SettingItem>
        )}
        <SettingItem compatKey="legacy" title="提权状态" divider>
          <Button size="sm" color="primary" onPress={() => setShowPermissionModal(true)}>
            管理
          </Button>
        </SettingItem>
        <SettingItem compatKey="legacy" title="服务状态" divider>
          <Button size="sm" color="primary" onPress={() => setShowServiceModal(true)}>
            管理
          </Button>
        </SettingItem>
        <SettingItem compatKey="legacy" title="IPv6">
          <Switch
            size="sm"
            isSelected={ipv6}
            onValueChange={(v) => onChangeNeedRestart({ ipv6: v })}
          />
        </SettingItem>
      </SettingCard>
      <PortSetting />
      <ControllerSetting />
      <EnvSetting />
      <LogSetting />
      <AdvancedSetting />
    </BasePage>
  )
}

export default Mihomo
