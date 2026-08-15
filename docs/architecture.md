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
        │ HTTPS + authenticated binary WebSocket
        ▼
Teleport proxy ──► SSH node
```

## Repository boundaries

- `src/app` owns routing and mobile screens.
- `src/lib/teleport` owns the TypeScript client boundary, secure profile
  restoration, and the deterministic web preview.
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
4. The resulting web session remains in the Go cookie jar. Telemob exports an
   encrypted snapshot to Expo SecureStore and restores it on cold launch until
   Teleport rejects or expires it.
5. A mounted app always prefers the live Go session over its last saved
   snapshot. Bearer-token renewals are persisted after opening or closing a
   shell, and older asynchronous writes cannot replace newer credentials.
6. An authorization failure while loading resources clears the saved profile
   and returns the user to login.

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

The Go module does not import Teleport's internal `lib/client` package. It keeps
the mobile binary smaller by implementing the required web and WebSocket
boundary with `gorilla/websocket`. Teleport's own code and documentation remain
under their respective licenses.

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

The React terminal screen subscribes to a process-wide session manager. Route
unmounting detaches the view but does not close SSH. The Go core assigns PTY
frames a monotonic sequence and retains a bounded 1 MiB replay window below
React. On resume, the manager fetches missed frames, pings the WebSocket, and
resizes the PTY. A failed check creates a new SSH session and a fresh native
terminal so old output is not appended to a replacement shell.

Closing a shell transitions the process-wide session to `closed`. The terminal
route then pops from the navigation stack, revealing the existing node list
instead of creating a second copy of it. Closing SSH does not log out of
Teleport; only an explicit logout or a proxy rejection clears the web session.

Android starts a user-visible foreground service while SSH is active and adds a
Disconnect notification action. If notification permission is denied, Android
still requires the foreground service but may surface its notice only in the
system's active-apps UI, depending on OS behavior.

iOS uses `beginBackgroundTask`, which provides only a finite execution window.
The connection is therefore best-effort in the background and is always checked
when the app becomes active again. No target-side multiplexer, daemon, package,
or configuration is required.

## Trust boundary

Normal connections use the phone's trusted certificate authorities and verify
the proxy hostname. The explicit insecure TLS option disables both checks for
Telemob's own HTTPS and WebSocket traffic. It does not and cannot modify the
system browser's certificate policy.

SecureStore protects the serialized session at rest using platform facilities.
It does not make a compromised or unlocked device a trusted environment. The
Teleport proxy remains the source of truth for expiration and authorization.

## Intentionally unsupported today

- SSO and identity-provider login.
- Application, database, Kubernetes, and desktop resources.
- File transfer, agent forwarding, port forwarding, and session joining.
- Per-session MFA and native platform passkey association.
- Indefinite iOS background execution.

See [Development](development.md) for build details and [Releases](releases.md)
for the signed-build pipeline.
