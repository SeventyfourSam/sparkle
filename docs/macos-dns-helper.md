# macOS Mihomo DNS helper

Sparkle's `sparkle-dns-helper` is a Darwin-only, narrowly scoped helper owned
and shipped by Sparkle. A non-empty `dns.listen` automatically enables it while
Mihomo DNS and Tun are running. On first use, Sparkle asks once to install it as
the root-owned `/Library/PrivilegedHelperTools/com.sparkle.SparkleDnsHelper`
and the matching `/Library/LaunchDaemons/com.sparkle.SparkleDnsHelper.plist`.
The daemon exposes only an authenticated Unix socket at
`/var/run/sparkle-dns-helper.sock`; `acquire` accepts a loopback listener on a
non-53 port, verifies that its TCP socket is listening, then updates the
primary network service through public SystemConfiguration APIs. It never
edits `/etc/resolver`, invokes `scutil`, or executes arbitrary commands.

The helper persists a root-only pending/active lease under
`/var/root/Library/Application Support/Sparkle/dns-lease.json` and its
root-owned authentication material under
`/var/root/Library/Application Support/Sparkle/dns-helper-auth`. The daemon
does not read the mutable per-user application-data copy during boot, so reset
data, FileVault timing, and app uninstall cannot strand a lease or cause a
launchd restart loop. The daemon reads the root credential for each request;
missing or corrupt auth therefore reports machine-readable `auth_failed` to
the app without preventing boot reconciliation. Sparkle rotates the root copy
atomically only after stopping an old daemon during an explicit install/update.
All lease mutations use a file lock plus one bounded
SCPreferences transaction: the preferences are synchronized after locking,
then read, compared, merged, committed, applied, and verified before unlock.
The pending snapshot is written before mutation, and restore changes only the
Sparkle-owned `ServerAddresses` and `ServerPort` fields. While the listener is
alive, the daemon reapplies those two fields if DHCP, VPN, MDM, or another tool
overwrites them. On release, a newer external value is preserved.

The LaunchDaemon is `RunAtLoad`/`KeepAlive` and reconciles pending or active
state before accepting requests and every few seconds thereafter. It only
checks whether the configured TCP endpoint is still listening; DNS response
correctness remains Mihomo's responsibility. It releases a lease when that
listener disappears and migrates it when macOS changes the primary network
service. A reboot thus cannot leave a dead non-53 resolver lease without a
recovery process. Helper
upgrade compares the packaged executable's SHA-256 build identity with daemon
status; a mismatch or wire-version mismatch triggers one elevated install
attempt. The installer hashes the exact opened executable before copying it,
requires the source to be the canonical executable currently running the
installer with non-writable bundle/resource ancestors, then atomically replaces
the root-owned executable/plist and starts the same daemon; the v1 persisted
lease remains readable and is reconciled by the new process. Uninstall restores
the lease before removing the daemon. Normal status and release use the
authenticated socket and do not prompt for administrator credentials. When
`dns.listen`, DNS, or Tun is disabled, startup performs only
a socket status/release cleanup and never migrates or acquires a lease.
Target-change requests allow up to 20 seconds for listener probes and the
locked restore/apply transaction.

The packaged helper also supports `self-test --json`. This is a non-mutating
native parser test for successful, truncated, malformed, wrong-ID, and DNS
error responses; it opens no sockets and does not access SystemConfiguration.
CI runs it alongside the TypeScript helper tests on both macOS architectures.

`pnpm build:dns-helper -- --arch=arm64` and `--arch=x64` compile the Swift
source with SystemConfiguration/CoreFoundation against macOS 10.15. The
prepare step runs this only for Darwin targets; `extraResources` packages the
resulting binary in both macOS architectures. Non-Darwin development and
builds skip Swift compilation and retain the existing DNS behavior.

Automated tests intentionally use protocol/state fakes and do not invoke
`acquire`, because a real SystemConfiguration mutation would change the
development Mac's live resolver. Before release, perform an isolated macOS A/B
test on a disposable network profile: enable a Mihomo `127.0.0.1:1053`
listener, verify ordinary `scutil --dns` queries resolve through that listener,
then disable Tun or clear `dns.listen`, restart Sparkle, unplug/reconnect the
active interface, and confirm the pre-existing `ServerAddresses` and
`ServerPort` are restored.
