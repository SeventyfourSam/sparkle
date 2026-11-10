import { Button, ListBox } from '@heroui/react'
import { useState } from 'react'
import PubSub from 'pubsub-js'
import SettingItem from '@renderer/components/base/base-setting-item'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { findSystemMihomo, getFilePath, restartCore } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import { systemCoreOnlyBuild } from '../../../shared/build-flags'

export function useCustomCoreSettings(systemPaths: string[]) {
  const { appConfig, patchAppConfig } = useAppConfig()
  const [busy, setBusy] = useState(false)
  const paths = Array.from(
    new Set([appConfig?.systemCorePath, ...systemPaths].filter((p): p is string => !!p))
  )
  const changeConfig = async (patch: Partial<AppConfig>): Promise<void> => {
    setBusy(true)
    try {
      if (!(await patchAppConfig(patch))) return
      await restartCore()
      PubSub.publish('mihomo-core-changed')
    } catch (error) {
      notify(error, { variant: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  const importCore = async (): Promise<void> => {
    try {
      const files = await getFilePath(['*'], '导入本地 Mihomo 内核', 'Mihomo 可执行文件')
      if (files?.[0]) await changeConfig({ core: 'system', systemCorePath: files[0] })
    } catch (error) {
      notify(error, { variant: 'danger' })
    }
  }
  const changeCore = async (core: AppConfig['core']): Promise<void> => {
    if (core !== 'system') return changeConfig({ core })
    const selected =
      appConfig?.systemCorePath || paths[0] || (await findSystemMihomo().catch(() => []))[0]
    if (selected) await changeConfig({ core, systemCorePath: selected })
    else await importCore()
  }
  const handleSelection = async (core: AppConfig['core']): Promise<boolean> => {
    if (core !== 'system') return false
    if (appConfig?.systemCorePath && systemPaths.includes(appConfig.systemCorePath)) return false
    await changeCore(core)
    return true
  }
  return { paths, busy, changeConfig, changeCore, importCore, handleSelection }
}

export function customCoreOptions() {
  return [
    <ListBox.Item key="mihomo" id="mihomo" textValue="内置内核">
      内置内核
      <ListBox.ItemIndicator />
    </ListBox.Item>,
    <ListBox.Item key="system" id="system" textValue="系统 / 本地内核">
      系统 / 本地内核
      <ListBox.ItemIndicator />
    </ListBox.Item>
  ]
}

export function LocalCoreSetting({
  controller
}: {
  controller: ReturnType<typeof useCustomCoreSettings>
}) {
  if (systemCoreOnlyBuild) return null
  return (
    <SettingItem compatKey="legacy" title="本地内核" divider>
      <Button
        size="sm"
        isPending={controller.busy}
        isDisabled={controller.busy}
        onPress={controller.importCore}
      >
        导入本地内核
      </Button>
    </SettingItem>
  )
}
