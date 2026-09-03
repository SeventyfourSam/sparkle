# macOS Mihomo DNS helper

Sparkle's `sparkle-dns-helper` is a Darwin-only, narrowly scoped helper owned
and shipped by Sparkle. On first enable, Sparkle asks once to install it as the
root-owned `/Library/PrivilegedHelperTools/com.sparkle.SparkleDnsHelper` and
the matching `/Library/LaunchDaemons/com.sparkle.SparkleDnsHelper.plist`.
The daemon exposes only an authenticated Unix socket at
`/var/run/sparkle-dns-helper.sock`; `acquire` accepts a loopback listener on a
non-53 port, performs bounded UDP and TCP DNS exchanges, then updates the
primary network service through public SystemConfiguration APIs. It never
edits `/etc/resolver`, invokes `scutil`, or executes arbitrary commands.

The helper persists a root-only pending/active lease under
`/var/root/Library/Application Support/Sparkle/dns-lease.json` and serializes
all lease mutations with a file lock plus an SCPreferences lock. It writes the
pending snapshot before mutation, verifies the committed fields, and restores
only the Sparkle-owned `ServerAddresses` and `ServerPort` fields. If either
field was externally replaced, the helper reports a conflict and leaves the
current configuration untouched.

The LaunchDaemon is `RunAtLoad`/`KeepAlive` and reconciles pending or active
state before accepting requests and every few seconds thereafter. It validates
the listener with UDP and TCP DNS exchanges, restores an unhealthy lease, and
migrates a lease when macOS changes the primary network service. A reboot thus
cannot leave a dead non-53 resolver lease without a recovery process. Helper
upgrade stops the old daemon, atomically replaces the root-owned executable and
plist, and starts the same daemon; the persisted lease is reconciled by the new
process. Uninstall restores the lease first and refuses to remove the daemon
when a field-aware conflict prevents safe restoration. Normal status and
release use the authenticated socket and do not prompt for administrator
credentials; an absent or broken daemon is repaired with one elevated install
attempt so a resolver lease is never silently abandoned.

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
then disable the mode, restart Sparkle, unplug/reconnect the active interface,
and confirm the pre-existing `ServerAddresses` and `ServerPort` are restored.
