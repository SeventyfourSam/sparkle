/** Remove the controlled listener tombstone only after the upstream merge/cleanup. */
export function finalizeCustomProfile(profile: MihomoConfig, controlDns: boolean): void {
  if (controlDns && profile.dns?.listen === '') delete profile.dns.listen
}
