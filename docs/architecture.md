# Telemob architecture

Telemob is one Expo/React Native product with a shared Go networking core.
Expo is the application framework, not the runtime boundary: development builds
compile the local Swift and Kotlin module alongside the React Native app.

```text
Expo Router screens
        │ typed JSON requests/events
        ▼
Expo native module (Swift / Kotlin)
        │ generated gomobile bindings
        ▼
Shared Go core
        │ HTTPS + authenticated binary WebSocket
        ▼
Teleport proxy ──► SSH node
```

## Authentication ownership

- The Go core starts password authentication and coordinates Teleport's MFA
  challenge/response exchange. Passwords stay in memory and are never persisted.
- TOTP is collected by the shared Expo UI and returned through the Go core.
- Passkey prompts are necessarily platform-owned: AuthenticationServices on iOS
  and Credential Manager on Android perform the ceremony. Both return the same
  assertion JSON contract to Go, which completes the Teleport challenge.
- The resulting Teleport web session remains in the Go core's cookie jar and is
  exported as an encrypted SecureStore snapshot. It is restored on cold launch
  until Teleport expires it; passwords are never included.
- Native passkeys require an OS-verified relationship between the app and the
  proxy's WebAuthn RP domain. iOS uses Associated Domains/AASA; Android uses
  Digital Asset Links. TOTP has no such deployment requirement.

## Current vertical slice

The app includes login, TOTP/passkey states, node discovery, login selection, and
an interactive terminal UI. `go/teleportmobile` implements the production
transport and defines the gomobile-safe API. Its integration tests exercise TLS
login, CSRF protection, session cookies, node mapping, WebSocket authentication,
and PTY byte streaming against an in-process proxy.

The Kotlin bridge links the generated AAR and invokes Android Credential Manager.
The Swift bridge links the generated XCFramework and invokes Authentication
Services. Native builds choose this bridge by default; Expo web and Expo Go fall
back to the deterministic driver.

## Terminal and background ownership

React screens subscribe to a process-wide terminal session manager. Route
unmounting detaches the view but does not close SSH. The Go core assigns every
PTY data frame a monotonic sequence and keeps a bounded 1 MiB replay window
below React. On resume, the manager replays missing frames, sends a WebSocket
ping, and resizes the PTY. A failed liveness check creates both a fresh SSH
session and a fresh terminal parser, preventing stale scrollback from being
mixed into a new shell.

Android starts a `specialUse` foreground service while SSH is active, shows an
ongoing notification, and exposes an explicit Disconnect action. iOS uses a
finite `beginBackgroundTask` lease; iOS may suspend the process after that lease
expires, so resume is best-effort and always includes verification. No server
multiplexer, daemon, package, or configuration is required.

## Production transport

The Go core uses Teleport's local-user web-session flow:

1. `GET /webapi/ping` validates the proxy and discovers the cluster.
2. MFA begin/finish endpoints complete password + TOTP or passkey login.
3. A short-lived bearer token and secure session cookie authorize node listing.
4. The token is renewed before expiry while the web session remains valid.
5. Terminal sessions use `/v1/webapi/sites/:cluster/connect/ws`, authenticate
   over the socket, and exchange Teleport version-1 binary terminal envelopes.

This keeps node authorization, session recording, and audit behavior on the
Teleport proxy. SSO, app/database access, file transfer, session joining, and
per-session WebAuthn challenges remain outside the first build.

The mobile core does not import Teleport's `lib/client`; it implements the web
API and terminal envelope boundary with a small WebSocket dependency. Teleport's
repository and protocol implementation are AGPL-licensed, so distribution still
needs an explicit legal/licensing review rather than an assumption based only on
the dependency graph.
