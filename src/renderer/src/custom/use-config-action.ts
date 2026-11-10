import { useState } from 'react'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { patchControledMihomoConfig, restartCore } from '@renderer/utils/ipc'
import { notify } from '@renderer/utils/notification'

export function useCustomConfigAction() {
  const { controledMihomoConfig, mutateControledMihomoConfig } = useControledMihomoConfig()
  const [saving, setSaving] = useState(false)
  const save = async (patch: Partial<MihomoConfig>): Promise<void> => {
    setSaving(true)
    try {
      await patchControledMihomoConfig(patch)
      await restartCore()
    } catch (error) {
      notify(error, { variant: 'danger' })
    } finally {
      mutateControledMihomoConfig()
      setSaving(false)
    }
  }
  return { config: controledMihomoConfig, saving, save }
}
