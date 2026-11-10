import { Button, Switch, Tooltip } from '@heroui/react'
import { IoIosHelpCircle } from 'react-icons/io'
import SettingItem from '@renderer/components/base/base-setting-item'
import { useCustomConfigAction } from './use-config-action'

export default function UdpFallbackSetting() {
  const { config, saving, save } = useCustomConfigAction()
  return (
    <SettingItem
      compatKey="legacy"
      title="UDP 规则回退"
      divider
      actions={
        <Tooltip delay={0}>
          <Button isIconOnly size="sm" variant="ghost" data-color="default">
            <IoIosHelpCircle className="text-lg" />
          </Button>
          <Tooltip.Content>
            命中的出站不支持 UDP 时继续匹配后续规则。关闭后直接失败，仅影响新建 UDP 关联。
          </Tooltip.Content>
        </Tooltip>
      }
    >
      <Switch
        size="sm"
        isSelected={config?.['udp-fallback'] ?? true}
        isDisabled={saving}
        onChange={(value) => save({ 'udp-fallback': value })}
        aria-label="UDP 规则回退"
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </SettingItem>
  )
}
