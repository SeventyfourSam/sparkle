import { useEffect, useState } from 'react'
import { Input } from '@heroui/react'
import SettingCard from '../components/base/base-setting-card'
import SettingItem from '../components/base/base-setting-item'
import { CODEX_WEB_CHANNEL } from '../../../shared/codex-web'
import type { CodexWebOptions, CodexWebStatus } from '../../../shared/codex-web'
import { notify } from '../utils/notification'

export default function CodexWebSettings(): React.JSX.Element {
  const [saved, setSaved] = useState<CodexWebOptions>()
  const [ports, setPorts] = useState({ port: '38471', webPort: '38472' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void window.electron.ipcRenderer
      .invoke(CODEX_WEB_CHANNEL, 'status')
      .then((next: CodexWebStatus) => {
        if (live) {
          setSaved(next.options)
          setPorts({ port: String(next.options.port), webPort: String(next.options.webPort) })
        }
      })
      .catch((error) => notify(error, { variant: 'danger' }))
    return () => {
      live = false
    }
  }, [])
  const save = async (): Promise<void> => {
    if (!saved || busy) return
    const value = { port: Number(ports.port), webPort: Number(ports.webPort) }
    if (value.port === saved.port && value.webPort === saved.webPort) return
    setBusy(true)
    try {
      const next: CodexWebStatus = await window.electron.ipcRenderer.invoke(
        CODEX_WEB_CHANNEL,
        'save',
        value
      )
      setSaved(next.options)
      setPorts({ port: String(next.options.port), webPort: String(next.options.webPort) })
    } catch (error) {
      notify(error, { variant: 'danger' })
      setPorts({ port: String(saved.port), webPort: String(saved.webPort) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingCard header="Codex Web">
      {(
        [
          ['port', 'Codex 接入端口'],
          ['webPort', '网页访问端口']
        ] as const
      ).map(([key, title], index) => (
        <SettingItem key={key} title={title} divider={index === 0}>
          <Input
            aria-label={title}
            className="w-32"
            type="number"
            min={1024}
            max={65535}
            value={ports[key]}
            disabled={!saved || busy}
            onChange={(event) => setPorts({ ...ports, [key]: event.target.value })}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.blur()
              }
            }}
          />
        </SettingItem>
      ))}
    </SettingCard>
  )
}
