import type { PreparedProfile } from './profile-builder'

// Source changes and configuration application share this queue. A failed
// operation must not prevent later edits from being applied.
let pending: Promise<unknown> = Promise.resolve()

export function withConfigTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation)
  pending = result.catch(() => {})
  return result
}

const launchKeys = [
  'core',
  'diffWorkDir',
  'systemCorePath',
  'corePermissionMode',
  'serviceRunMode',
  'serviceCpuAffinity',
  'coreStartupMode',
  'mihomoCpuPriority',
  'disableLoopbackDetector',
  'disableEmbedCA',
  'disableSystemCA',
  'disableNftables',
  'safePaths'
] as const
const controllerKeys = [
  'external-controller',
  'external-controller-tls',
  'external-controller-unix',
  'external-controller-pipe',
  'external-controller-cors',
  'external-ui',
  'external-ui-url',
  'external-ui-name',
  'secret',
  'tls'
]

export function requiresCoreRestart(previous: PreparedProfile, next: PreparedProfile): boolean {
  return (
    previous.workDir !== next.workDir ||
    launchKeys.some(
      (key) => JSON.stringify(previous.appConfig[key]) !== JSON.stringify(next.appConfig[key])
    ) ||
    controllerKeys.some(
      (key) => JSON.stringify(previous.config[key]) !== JSON.stringify(next.config[key])
    )
  )
}

export function rollbackLaunchPatch(
  previous: PreparedProfile,
  next: PreparedProfile
): Partial<AppConfig> {
  return Object.fromEntries(
    launchKeys
      .filter(
        (key) => JSON.stringify(previous.appConfig[key]) !== JSON.stringify(next.appConfig[key])
      )
      .map((key) => [key, previous.appConfig[key]])
  )
}

export function checkAppliedConfig(expected: MihomoConfig, actual: ControllerConfigs): void {
  if (Boolean(expected.tun?.enable) !== Boolean(actual.tun?.enable)) {
    throw new Error('配置加载后 TUN 状态与预期不一致')
  }
  if (
    expected['udp-fallback'] !== undefined &&
    expected['udp-fallback'] !== actual['udp-fallback']
  ) {
    throw new Error('配置加载后 udp-fallback 未正确应用')
  }
  for (const port of ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'] as const) {
    if ((expected[port] || 0) !== actual[port]) throw new Error(`配置加载后 ${port} 未正确应用`)
  }
}
