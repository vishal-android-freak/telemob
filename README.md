# Telemob

Telemob is a mobile Teleport client prototype for iOS and Android. It uses
Expo/React Native for one shared product UI and a Go core, exported with gomobile,
for Teleport authentication, resource discovery, and terminal sessions.

The current vertical slice includes:

- username/password login with passkey and TOTP challenge states;
- secure on-device profile metadata storage;
- encrypted Teleport web-session restoration until the cluster session expires;
- node discovery, filtering, and SSH-login selection;
- a full-screen mobile terminal with direct typing, paste, sticky Ctrl/Alt,
  navigation/editing keys, F1–F12, and optional whole-line input;
- Teleport local-user login with TOTP and Browser MFA passkeys;
- RBAC-filtered node discovery over the Teleport web API;
- an audited PTY session over Teleport's authenticated WebSocket transport;
- Swift and Kotlin bridges to the same Go implementation;
- an explicit, disabled-by-default insecure TLS option for self-signed test clusters;
- native session ownership with bounded output replay and clean reconnects;
- Android background retention through a visible foreground-service notification;
- best-effort iOS background execution within Apple's client-app limits;
- a deterministic development transport for Expo web and UI work.

Native development builds use the production Go transport by default. Expo web
and Expo Go use the deterministic transport because they cannot load the custom
module. Set `EXPO_PUBLIC_TELEPORT_NATIVE_CORE=0` to force the development driver
in a native build.

## Run the current slice

```bash
npm install
npm run web
```

Use any non-empty password. For TOTP, use any six digits. This web preview never
contacts a Teleport cluster.

```bash
npm run build:core:android
npx expo prebuild
npx expo run:android
# or, on macOS:
npm run build:core:ios
npx expo run:ios
```

This app needs an Expo development build; Expo Go cannot load the custom Teleport
native module.

Android builds target Pixel 10 / `arm64-v8a` only. Use Java 21 for Android
Gradle builds; newer Java releases may not yet work with Android's JDK image
transform.

After a successful native login, Telemob stores the Teleport web-session
token and session cookie with Expo SecureStore and restores them on cold launch.
The saved session is discarded when it expires or when the user signs out. The
Teleport password is never persisted.

## Terminal lifecycle

The active SSH session belongs to the native session manager, not the terminal
screen. Navigating away or backgrounding the app does not intentionally close
it. Native output is sequenced and retained in a bounded 1 MiB replay window,
so returning to the terminal fills output missed while React was paused without
duplicating bytes. A real WebSocket ping verifies liveness on resume. If the
connection died, Telemob creates a new SSH session and a fresh terminal parser;
old scrollback is never appended to the new shell.

Android keeps a user-started terminal alive with a visible foreground-service
notification and Disconnect action. iOS grants ordinary apps only a limited
background execution extension, so Telemob preserves the connection on a
best-effort basis and verifies or reconnects it on return. Telemob does not
require or install tmux, screen, Mosh, an agent, or any other software on the
target server.

## Validate

```bash
npm run typecheck
npm run lint
npm run test:go
```

## Build the shared Go core

Install and initialize gomobile, then build the platform artifact:

```bash
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init
npm run build:core:android
# or, on macOS:
npm run build:core:ios
```

The generated Android AAR and iOS XCFramework are linked by the local Expo
module. To force the preview driver instead:

```bash
EXPO_PUBLIC_TELEPORT_NATIVE_CORE=0 npx expo start --dev-client
```

## Browser MFA passkeys

Passkeys use Teleport Browser MFA so users can enter arbitrary public or private
proxy domains without Apple Associated Domains or Android Digital Asset Links.
The Go core creates an encrypted loopback callback, the native bridge opens
`/web/mfa/browser/:requestId` in the system browser, and Teleport sends the
browser-owned WebAuthn assertion back to the app.

Browser MFA requires Teleport 18.8 or newer with CLI browser authentication
enabled (the default when WebAuthn is configured). Private proxies work when the
phone can resolve the hostname and its system browser trusts the proxy's CA.
TOTP continues to work on older Teleport clusters. Per-session MFA challenges
are not yet handled.

## Self-signed proxy certificates

The connection screen includes **Trust self-signed certificate**, equivalent to
`tsh login --insecure`. It disables certificate-chain and hostname verification
for the Teleport HTTPS API and terminal WebSocket. It is off by default and
should be enabled only when the proxy identity has been verified another way.
This setting does not affect the system browser; Browser MFA still requires a
certificate trusted by that browser.

See [docs/architecture.md](docs/architecture.md) for ownership boundaries,
authentication design, transport details, and current limitations.

## EAS iOS builds

The project is linked to EAS project
`c72bfab5-a90d-4b46-8c2e-d86c2c90810c`. EAS generates the ignored Go
XCFramework on its macOS worker before Expo prebuild and CocoaPods installation.

For an installable iPhone build, register the device before starting the build:

```bash
eas device:create
eas build --platform ios --profile preview
```

The `preview` profile creates a standalone ad hoc IPA. The `development`
profile creates an Expo development client, and `production` is reserved for
TestFlight or App Store distribution.
See [docs/terminal-keyboard.md](docs/terminal-keyboard.md) for the open-source
terminal keyboard research and the resulting v1 key set.
