# Telemob Roadmap

Telemob's immediate goal is to become a dependable, daily-use mobile SSH
client for Teleport. The project will prioritize compatibility, reliability,
security, and mobile terminal ergonomics before expanding to other Teleport
resource types.

This roadmap describes intended direction rather than a commitment to specific
release dates. Priorities may change based on user feedback, Teleport protocol
changes, and contributor interest.

## v1.1 — compatibility and daily reliability

### Completed foundations

- [x] Multiple concurrent terminal sessions with a compact tab rail, per-tab
  target/state/unread indicators, independent native parser state, and
  single/all-session notification controls.
- [x] Multiple encrypted saved Teleport profiles with naming, switching,
  deletion, per-profile TLS/auth preferences, and no persisted passwords or
  TOTP codes.
- [x] Multiple local TCP forwards through role-authorized Teleport SSH nodes,
  loopback-only listeners, temporary on-device SSH identities, saved per-profile
  rules, Android foreground-service ownership, and best-effort iOS background
  retention.

### Favorites, recents, and node organization

- [x] Favorite frequently used nodes.
- [x] Show recently connected nodes and preferred SSH logins.
- [x] Sort and filter by hostname, label, cluster, status, or last connection time.
- [x] Remember useful filters independently for each Teleport profile.

### Connection recovery and session lifetime UX

- [x] Detect Wi-Fi, cellular, VPN, and general network-path changes.
- [x] Retry transient failures with bounded exponential backoff.
- [x] Distinguish proxy unavailability, DNS failure, TLS failure, authorization
  denial, and confirmed login expiry.
- [x] Preserve saved authentication during transient failures.
- [x] Display certificate or login expiry and provide a controlled reauthentication
  flow without unexpectedly replacing navigation state.
- [x] Retain pull-to-refresh, explicit Retry, and automatic recovery when the
  device moves onto a new usable network path.

### Browser-based SSO

Add browser authentication for Teleport clusters using OIDC, SAML, or GitHub
connectors. Telemob should delegate identity-provider interaction to the system
browser instead of implementing provider-specific native login forms.

## v1.2 — mobile workflow features

### Teleport Access Requests

- Search for requestable roles and SSH nodes.
- Create role- or resource-level requests with a reason and requested duration.
- Display pending, approved, denied, and expired requests.
- Activate approved access and refresh the visible resource inventory.
- Support approving or denying requests for users with reviewer permissions.

Access Requests are particularly valuable for responding to incidents from a
phone without granting permanent elevated privileges.

- [Requesting access with Teleport](https://goteleport.com/docs/connect-your-client/request-access/)
- [Resource Access Requests](https://goteleport.com/docs/identity-governance/access-requests/resource-requests/)

### SFTP file transfer

- Browse remote directories.
- Upload through the Android and iOS system document pickers.
- Download and share files through native platform interfaces.
- Show transfer progress and support cancellation.
- Create folders, rename entries, and delete entries when authorized.
- Enforce Teleport's `ssh_file_copy` role restriction.
- Avoid retaining downloaded sensitive files longer than the user requests.

- [Teleport SSH file copying](https://goteleport.com/docs/connect-your-client/teleport-clients/tsh/)
- [Teleport role controls](https://goteleport.com/docs/reference/access-controls/roles/)

### Customizable terminal keyboard

- Reorder, add, and remove utility keys.
- Support latching Ctrl, Alt, and Shift modifiers.
- Add long-press key repeat.
- Allow user-defined key combinations and command snippets.
- Support global and per-profile key layouts.
- Complete hardware-keyboard shortcuts on Android and iPadOS.
- Add pinch gestures and keyboard shortcuts for font sizing.

### Terminal appearance and tools

- Terminal themes and configurable color palettes.
- Font size, line spacing, and cursor-style controls.
- Configurable scrollback limits.
- A terminal reset action.
- Improved URL detection, opening, and copying.
- Persisted search history and better match navigation.
- Export or share selected terminal text.

- [Ghostty action reference](https://ghostty.org/docs/config/keybind/reference)

### Mobile security controls

- Optional biometric or device-credential app lock.
- A privacy overlay in the operating system's app switcher.
- Optional screenshot protection where the platform supports it.
- Optional clipboard auto-clear for copied terminal content.
- Import and manage private certificate authorities as a safer alternative to
  insecure TLS mode.
- Clearly distinguish system trust, a user-imported CA, and fully insecure TLS.
- Keep diagnostics free of credentials, session cookies, tokens, and terminal
  contents.

## Later — deeper Teleport integration

### Per-session MFA

Support the additional WebAuthn or identity-provider verification that a
Teleport role can require when opening an SSH connection. The implementation
should reuse Telemob's existing browser-MFA callback flow where possible.

Nodes protected by `require_session_mfa` cannot be reached from Telemob until
this work is implemented.

- [Teleport per-session MFA](https://goteleport.com/docs/zero-trust-access/authentication/per-session-mfa/)
- [Teleport role reference](https://goteleport.com/docs/reference/access-controls/roles/)

### Trusted and leaf clusters

- Discover root and leaf clusters available to the authenticated identity.
- Switch clusters without repeating the primary login unnecessarily.
- Group nodes by cluster and respect cluster-label RBAC.

- [Teleport Trusted Clusters](https://goteleport.com/docs/reference/architecture/trustedclusters/)

### Shared and moderated sessions

- List joinable active SSH sessions.
- Join sessions in peer, observer, or moderator modes when permitted.
- Invite other Teleport users and provide a session reason.
- Surface waiting-room and required-participant state.
- Support moderator presence verification requirements.

- [Joining Teleport sessions](https://goteleport.com/docs/zero-trust-access/authentication/joining-sessions/)

### Session history and recordings

- Show recent SSH session metadata.
- Open server-side recordings in Teleport's web interface.
- Provide useful filtering by user, node, time, and session identifier.

- [Teleport session recording](https://goteleport.com/docs/reference/architecture/session-recording/)

## Deferred scope

The following areas are intentionally deferred until the mobile SSH experience
is complete and dependable:

- Kubernetes access and `kubectl` workflows.
- Database clients and database proxying.
- Windows desktop access.
- A general-purpose local Unix shell.
- SSH agent forwarding.
- Remote forwarding and dynamic/SOCKS forwarding.
- Mosh or server-side tmux integration.

These features would substantially expand Telemob's security surface and product
scope. They should be evaluated separately rather than added at the expense of
core SSH reliability.

## Suggested implementation order

1. Connection recovery and session-expiry UX.
2. Browser-based SSO.
3. Access Requests.
4. SFTP file transfer.
5. Keyboard customization and terminal appearance.
6. Biometric lock and private CA management.
7. Trusted clusters, shared sessions, recordings, and per-session MFA.
