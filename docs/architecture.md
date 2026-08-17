# Architecture

> Telemob is an unofficial, independent client. It is not affiliated with,
> endorsed by, or maintained by Gravitational Inc. or the Teleport project.

Telemob is one Expo/React Native application with a shared Go networking core.
Expo is the application framework rather than the native runtime boundary:
development and release builds compile the local Swift or Kotlin module beside
the React Native application.

```text
Expo Router screens
        │ typed requests, snapshots, and events
        ▼
Expo native module (Swift or Kotlin)
        ├──► libghostty-vt + native terminal view
        │
        └──► generated gomobile bindings ──► Shared Go core
        │ HTTPS + authenticated binary WebSocket / SSH
        ▼
Teleport proxy ──► SSH node
```

## Repository boundaries

- `src/app` owns routing and mobile screens.
- `src/lib/teleport` owns the TypeScript client boundary, secure profile
  restoration, and the deterministic web preview.
- `src/lib/network` owns connectivity observation, connection-error taxonomy,
  bounded retry timing, and recovery from network-path changes.
- `src/lib/terminal` owns input sequences, viewport/session coordination,
  reconnect behavior, and React subscriptions. It does not parse or paint the
  terminal screen.
- `go/teleportmobile` owns authentication, proxy requests, session state,
  WebSocket PTY transport, output sequencing, and replay.
- `modules/expo-teleport` exposes the Go API to Kotlin and Swift, embeds the
  shared `libghostty-vt` parser, paints the terminal with native platform APIs,
  and owns platform behavior such as Browser MFA and background leases.
- `scripts/build-go-core.sh` generates the ignored Android AAR or iOS
  XCFramework consumed by the Expo module.

The generated native bindings are build products. They are deliberately not
committed to the repository.

## Authentication ownership

1. The Go core validates the proxy and starts Teleport's local-user password
   flow. Passwords remain in memory and are never persisted.
2. The shared UI collects a TOTP code when requested and passes it to Go.
3. For passkeys, Go starts Teleport Browser MFA with an encrypted loopback
   callback. The native bridge opens the proxy page in the system browser; the
   browser owns WebAuthn and returns the result through that callback.
4. The resulting web session remains in the Go cookie jar. Telemob exports one
   encrypted snapshot per saved profile to Expo SecureStore and restores the
   selected profile on cold launch until Teleport rejects or expires it.
5. A mounted app always prefers the live Go session over its last saved
   snapshot. The Go core renews the bearer token while any SSH terminal is
   active, including under Android's foreground service, and publishes every
   rotated token and cookie for SecureStore persistence. Renewals are also
   persisted after opening or closing a shell, and older asynchronous writes
   cannot replace newer credentials.
6. Authentication-dependent native calls are serialized while profiles switch,
   because the Go core has one current web-session context. Already-open SSH
   WebSockets remain independent and continue running during that switch.
7. A confirmed authorization failure while loading resources clears only the
   rejected profile's session snapshot while retaining its connection settings.
   DNS, TLS, and other transient failures retain authentication and expose Retry
   and pull-to-refresh recovery.
8. Local forwarding has a separate step-up flow that asks Teleport for a
   temporary SSH user certificate. Telemob generates the SSH key on-device,
   stores the key and certificate only inside the encrypted profile snapshot,
   and never persists the password, TOTP value, or passkey assertion.

Resource discovery and terminal connection attempts share one connectivity
observer. It tracks Wi-Fi, cellular, Ethernet, VPN, and IP changes without
requiring public-internet validation, because a private Teleport proxy can be
reachable on a local network that Android or iOS considers internet-less.
Transient failures use bounded exponential backoff and wake immediately when a
new network path appears. Offline waiting does not consume a retry attempt.

Browser MFA avoids requiring Associated Domains or Digital Asset Links for
proxy hostnames entered by users. It requires Teleport 18.8 or newer and a
system browser that trusts the proxy certificate.

## Resource and terminal transport

The production core implements the local-user web-session flow used by the
Teleport proxy:

1. `GET /webapi/ping` validates the proxy and discovers cluster information.
2. MFA begin and finish requests establish the authenticated web session.
3. A short-lived bearer token and session cookie authorize node discovery.
4. The bearer token is renewed while the underlying web session remains valid.
5. `/v1/webapi/sites/:cluster/connect/ws` carries the authenticated terminal
   connection and Teleport version-1 binary terminal envelopes.

Authorization, RBAC filtering, SSH certificates, session recording, and audit
behavior remain under the Teleport proxy's control. Telemob does not bypass the
proxy or connect directly to SSH port 22.

Successful SSH connections update a bounded, per-profile node-preference index
in SecureStore. It contains favorites, the 50 most recent node timestamps, the
last successful login selected for each node, and the profile's node-list query,
filter, and sort settings. Failed connection attempts are not recorded as
recents, and forgetting a profile removes its node-preference entry.

The Go module does not import Teleport's internal `lib/client` package. It keeps
the mobile binary smaller by implementing the required web and WebSocket
boundary with `gorilla/websocket`. Teleport's own code and documentation remain
under their respective licenses.

## Local TCP forwarding

Each forward binds a TCP listener to `127.0.0.1` only; port `0` asks the
operating system to choose an available port. The Go core authenticates to the
Teleport SSH proxy with the temporary certificate, opens the selected node via
Teleport's proxy subsystem, then creates one standard SSH `direct-tcpip`
channel per local client connection. Teleport and the target node remain the
authority for role restrictions, destination access, audit behavior, and
certificate expiry.

Multiple listeners and multiple client connections can run concurrently.
Listener definitions may be saved per profile, but saved definitions do not
contain credentials and do not start automatically. An explicit Stop closes the
listener and every connection using it. A lost SSH transport closes the affected
forward and leaves its saved definition available for a deliberate restart.

Android registers active forwards with the same user-visible foreground service
as terminal sessions. iOS uses the same finite background-task lease as terminal
sessions, so forwarding is foreground-reliable but only best-effort after the
app is suspended. Neither platform exposes a listener on Wi-Fi, Ethernet, VPN,
or cellular interfaces.

## Terminal rendering and input

The same pinned `libghostty-vt` source parses the remote byte stream on Android
and iOS. A small shared C bridge produces an exact cell-grid snapshot. Android
paints it with a native `Canvas`; iOS paints it with Core Graphics and UIKit.
React Native lays out the terminal view but does not create one component per
cell or line. Ghostty also reports alternate-screen, mouse-tracking, and
bracketed-paste modes and generates terminal query responses written back to
the SSH PTY.

The PTY size is derived from the measured viewport. Ordinary shell screens use
a compact font; alternate-screen TUIs use a larger font and receive the true
resulting row and column count. There is no hard-coded 80- or 84-column PTY.

Shared window breakpoints adapt every screen without checking a specific phone
or tablet model. Login changes from one column to a split composition when
space permits. Node discovery uses one, two, or three columns inside a bounded
content width. On short landscape screens, terminal chrome becomes denser so
the PTY retains as much height as possible. iOS and Android both permit runtime
orientation changes, and iPad is an enabled native target.

Touch taps, wheel gestures, and held drags become standard Ghostty-encoded mouse
events only when the remote application enables mouse tracking. Without mouse
tracking, swipes navigate local scrollback, held drags select native terminal
text, and safe OSC 8 links can be opened with confirmation. Full-buffer search,
selection copy, and the scrollbar operate directly on Ghostty's screen state.
Keyboard input otherwise passes through as terminal bytes. Ctrl and Alt are
one-shot modifiers for the next key, avoiding a prefix sequence such as
`Ctrl+B`, `Q` becoming `Ctrl+B`, `Ctrl+Q`.

## Session and background ownership

The React terminal screen subscribes to a process-wide terminal workspace. Each
tab has an independent controller, target, connection state, dimensions,
unread state, native Ghostty parser, and replay cursor. Route unmounting or tab
switching detaches the view but does not close SSH. The Go core assigns PTY
frames a monotonic sequence and retains a bounded 1 MiB replay window below
React. On resume, every live controller fetches missed frames and pings its
WebSocket. A failed check creates a new SSH session and a fresh native terminal
so old output is not appended to a replacement shell.

An unexpected terminal transport failure enters a bounded reconnect loop. A
network change wakes that loop immediately; a final transient failure leaves a
themed Retry action in the terminal instead of closing its tab. Expected remote
shell exits still close normally. Explicit Teleport 401 or 403 responses stop
retrying and expose a controlled Sign in action, while DNS, timeout, TLS, and
proxy reachability failures never clear saved authentication.

Closing a shell removes only that terminal tab and activates a neighboring tab,
or pops to the existing node list when none remain. Closing SSH does not log out
of Teleport. Forgetting a profile disconnects only that profile's terminals;
other profiles and their terminals remain available.

Android registers every SSH WebSocket with one user-visible foreground service.
Its notification shows the active-terminal count, opens the most recently
registered terminal, and offers Disconnect or Disconnect all as appropriate.
Closing one tab updates the notification without stopping the service while
other tabs remain. If notification permission is denied, Android still requires
the foreground service but may surface its notice only in the system's
active-apps UI, depending on OS behavior. While a terminal remains registered,
the native Go core renews Teleport's short-lived web bearer before it expires;
when React Native is available, rotated bearer and cookie credentials are sent
back to the encrypted profile store. Disconnecting a terminal performs one
final export so a subsequent cold launch restores the newest credentials.

iOS uses `beginBackgroundTask`, which provides only a finite execution window.
The connection is therefore best-effort in the background and is always checked
when the app becomes active again. No target-side multiplexer, daemon, package,
or configuration is required.

## Trust boundary

Normal connections use the phone's trusted certificate authorities and verify
the proxy hostname. The explicit insecure TLS option disables both checks for
Telemob's own HTTPS and WebSocket traffic. It does not and cannot modify the
system browser's certificate policy.

SecureStore protects the profile index and stores every serialized profile
session under a separate key using platform facilities. Passwords and TOTP codes
are never written to the profile store. SecureStore does not make a compromised
or unlocked device a trusted environment. The Teleport proxy remains the source
of truth for expiration and authorization.

## Intentionally unsupported today

- SSO and identity-provider login.
- Application, database, Kubernetes, and desktop resources.
- File transfer, agent forwarding, remote/dynamic forwarding, and session joining.
- Per-session MFA and native platform passkey association.
- Indefinite iOS background execution.

See [Development](development.md) for build details and [Releases](releases.md)
for the signed-build pipeline.
