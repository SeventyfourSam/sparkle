import { Button, Input, Tooltip } from '@heroui/react'
import { useEffect, useState } from 'react'
import SettingItem from '@renderer/components/base/base-setting-item'
import { platform } from '@renderer/utils/init'
import { isValidListenAddress } from '@renderer/utils/validate'
import { useCustomConfigAction } from './use-config-action'

export default function DnsListenSetting() {
  const { config, saving, save } = useCustomConfigAction()
  const saved = config?.dns?.listen ?? ''
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  const validation = isValidListenAddress(value)
  return (
    <SettingItem
      compatKey="legacy"
      divider
      title={platform === 'darwin' ? 'DNS 监听地址（自动接管系统 DNS）' : 'DNS 监听地址'}
    >
      <div className="flex items-center gap-2">
        {value.trim() !== saved && (
          <Button
            size="sm"
            isDisabled={!validation.ok || saving}
            isPending={saving}
            onPress={() => save({ dns: { listen: value.trim() } })}
          >
            确认
          </Button>
        )}
        <Tooltip isOpen={!validation.ok}>
          <Input
            aria-label="DNS 监听地址"
            data-size="sm"
            value={value}
            disabled={saving}
            className={`w-75 ${validation.ok ? '' : 'border-red-500 ring-1 ring-red-500 rounded-lg'}`}
            placeholder="例：127.0.0.1:1053（留空禁用）"
            onChange={(event) => setValue(event.target.value)}
          />
          <Tooltip.Content placement="right" offset={15} className="text-danger">
            {validation.error}
          </Tooltip.Content>
        </Tooltip>
      </div>
    </SettingItem>
  )
}
