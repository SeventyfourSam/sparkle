import { Button, Input, Switch } from '@heroui/react'
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import { getFilePath } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'
import {
  defaultAgentServerOptions,
  type AgentServerOptions,
  type AgentServerStatus
} from '../../../shared/agent-server'

const invoke = (action: string, ...args: unknown[]) =>
  window.electron.ipcRenderer.invoke(`agentServer:${action}`, ...args)
const labels = {
  stopped: '未运行',
  starting: '启动中',
  running: '运行中',
  restarting: '等待重试',
  error: '启动失败'
}

export default function AgentServerSettings(): React.JSX.Element {
  const { data, error, mutate } = useSWR<AgentServerStatus>(
    'agentServer:get',
    () => invoke('get'),
    { refreshInterval: 2000 }
  )
  const [draft, setDraft] = useState<AgentServerOptions>(defaultAgentServerOptions)
  const [busy, setBusy] = useState(false)
  const saved = data ? JSON.stringify(data.options) : ''
  useEffect(() => {
    if (saved) setDraft(JSON.parse(saved))
  }, [saved])
  const choose = async (): Promise<void> => {
    try {
      const files = await getFilePath(['*'], '选择 AgentServer 程序', 'AgentServer 可执行文件')
      if (files?.[0]) setDraft((value) => ({ ...value, executable: files[0] }))
    } catch (error) {
      notify(error, { variant: 'danger' })
    }
  }
  const save = async (restart = false): Promise<void> => {
    setBusy(true)
    try {
      await mutate(
        await invoke(restart ? 'restart' : 'configure', ...(restart ? [] : [draft])),
        false
      )
    } catch (error) {
      notify(error, { variant: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingCard header="AgentServer">
      <SettingItem title="自动启动" divider>
        <Switch
          size="sm"
          aria-label="随 Sparkle 自动启动 AgentServer"
          isSelected={draft.enabled}
          isDisabled={busy || !data}
          onChange={(enabled) => setDraft((value) => ({ ...value, enabled }))}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </SettingItem>
      <SettingItem title="独立程序" divider>
        <div className="flex w-full gap-2">
          <Input
            aria-label="AgentServer 可执行文件"
            value={draft.executable}
            onChange={(event) =>
              setDraft((value) => ({ ...value, executable: event.target.value }))
            }
            placeholder="AgentServer 可执行文件的完整路径"
            className="flex-1"
            disabled={busy}
          />
          <Button size="sm" onPress={choose} isDisabled={busy}>
            选择文件
          </Button>
        </div>
      </SettingItem>
      <SettingItem title="本机接入端口" divider>
        <Input
          aria-label="AgentServer 本机接入端口"
          type="number"
          min={1024}
          max={65535}
          value={String(draft.port)}
          onChange={(event) =>
            setDraft((value) => ({ ...value, port: Number(event.target.value) }))
          }
          className="w-28"
          disabled={busy}
        />
      </SettingItem>
      <SettingItem title="网页服务端口" divider>
        <Input
          aria-label="AgentServer 网页服务端口"
          type="number"
          min={1024}
          max={65535}
          value={String(draft.webPort)}
          onChange={(event) =>
            setDraft((value) => ({ ...value, webPort: Number(event.target.value) }))
          }
          className="w-28"
          disabled={busy}
        />
      </SettingItem>
      <p className="text-sm text-default-500 mb-2">
        接入端口供本机 Codex / Claude 连接；网页服务监听 0.0.0.0，手机访问电脑 IP 与网页端口。
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm flex-1" role="status">
          {data ? labels[data.state] : error ? '状态读取失败' : '正在读取…'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={busy || !data?.options.enabled || saved !== JSON.stringify(draft)}
          onPress={() => save(true)}
        >
          重启服务
        </Button>
        <Button size="sm" isDisabled={busy || !data} isPending={busy} onPress={() => save()}>
          保存并应用
        </Button>
      </div>
      {data?.error && <p className="text-sm text-danger mt-2 break-all">{data.error}</p>}
    </SettingCard>
  )
}
