const CUSTOM_VERSION_SUFFIX = /-custom(?:\.[0-9A-Za-z-]+)*$/i

export function upstreamAppVersion(version: string): string {
  return version.replace(CUSTOM_VERSION_SUFFIX, '')
}

export function isCustomBuild(version: string): boolean {
  return CUSTOM_VERSION_SUFFIX.test(version)
}
