export const SPARKLE_REPOSITORY = 'SeventyfourSam/sparkle'
export const SPARKLE_RELEASES = `https://github.com/${SPARKLE_REPOSITORY}/releases`
export const SPARKLE_RELEASE_API = `https://api.github.com/repos/${SPARKLE_REPOSITORY}/releases`
export const SPARKLE_UPDATE_URL = `${SPARKLE_RELEASES}/latest/download/latest.yml`

export function appReleaseTag(version: string, tag?: string): string {
  return tag || (version.startsWith('v') ? version : `v${version}`)
}
