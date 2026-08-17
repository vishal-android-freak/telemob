<p align="center">
  <img src="assets/images/icon.png" alt="Telemob app icon" width="144" height="144">
</p>

<h1 align="center">Telemob</h1>

<p align="center">
  An open-source mobile SSH client for Teleport, built with Expo, React Native, and Go.
</p>

> [!IMPORTANT]
> Telemob is an independent, unofficial community project. It is not sponsored,
> endorsed, maintained by, or affiliated with Gravitational Inc. or the Teleport
> project. Teleport is created and maintained by Gravitational; see
> [goteleport.com](https://goteleport.com/) and
> [gravitational/teleport](https://github.com/gravitational/teleport).

Telemob lets you authenticate to a Teleport proxy, discover the SSH nodes your
role can access, and open an interactive terminal from Android or iOS. One Expo
application provides the interface while a shared Go core implements the
Teleport transport on both platforms.

Telemob is under active development. Review the [current limitations](#current-limitations)
before relying on it for critical access.

## Features

- Teleport local-user login with password and TOTP.
- Browser MFA for passkeys on supported Teleport clusters.
- Encrypted on-device restoration of the Teleport web session; passwords are
  never persisted.
- Multiple saved Teleport profiles with independent encrypted session snapshots,
  profile naming, switching, and removal.
- RBAC-filtered node discovery with per-profile favorites, recents, preferred
  SSH logins, remembered filters, and multiple sort modes.
- Interactive PTY sessions over Teleport's authenticated WebSocket transport.
- Multiple concurrent terminal tabs with independent connection state, parser
  state, scrollback, dimensions, and unread activity.
- A full-screen terminal with direct typing, paste, Ctrl/Alt modifiers,
  navigation and editing keys, F1–F12, and optional whole-line input.
- Terminal mouse clicks and scroll events for compatible full-screen TUI apps.
- Dynamic PTY sizing based on the actual mobile viewport.
- Responsive phone and tablet layouts in portrait and landscape, including
  multi-column node discovery and native iPad support.
- Android foreground-service retention with a visible session count, deep link
  to the latest terminal, and Disconnect/Disconnect all action.
- Best-effort iOS background retention and connection verification on resume.
- An explicit, disabled-by-default insecure TLS option for development clusters
  using self-signed certificates.

## Screens and runtime

Native development builds use the Go transport. Expo web and Expo Go use a
deterministic preview transport because they cannot load Telemob's custom native
module. Set `EXPO_PUBLIC_TELEPORT_NATIVE_CORE=0` to force the preview transport
inside a native development build.

Active SSH sessions are owned by a process-wide terminal workspace below the
React screens. Navigating away, switching profiles, switching terminal tabs, or
backgrounding the app does not intentionally close them. Each tab retains its
own sequenced output and bounded replay window; on resume, Telemob fills missed
output, checks liveness, and reconnects with a fresh terminal parser when
necessary. No tmux, screen, Mosh, agent, or other target-server software is
required.

## Requirements

- Node.js 22 or newer and npm.
- Go 1.26.4 or newer plus `gomobile` and `gobind` for native core builds.
- Android Studio/SDK/NDK and JDK 17 for Android development.
- macOS with Xcode for local iOS development.
- A reachable Teleport proxy and a local Teleport user.

The Android Go binding targets `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`.
iOS and iPadOS deployment targets 15.1 or newer. This app requires an Expo
development build; Expo Go is not sufficient.

## Quick start

Install the JavaScript dependencies and run the deterministic web preview:

```bash
npm ci
npm run web
```

The preview does not contact a Teleport cluster. Any non-empty password and any
six-digit TOTP value can be used.

For a native Android build:

```bash
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260812174124-2f419b2fb945
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260812174124-2f419b2fb945
npm run build:core:android
npm run verify:android-native
npx expo prebuild --platform android
npx expo run:android --device
```

For iOS on macOS, replace the core and Expo commands with:

```bash
npm run build:core:ios
npx expo prebuild --platform ios
npx expo run:ios --device
```

See [Development](docs/development.md) for environment details, native artifact
paths, testing, and troubleshooting.

## Authentication notes

### Browser MFA passkeys

Passkeys use Teleport Browser MFA so users can enter public or private proxy
domains at runtime without Telemob owning those domains. The Go core starts an
encrypted loopback callback, the native bridge opens Teleport's Browser MFA page
in the system browser, and the browser returns the WebAuthn result to the app.

Browser MFA requires Teleport 18.8 or newer with CLI browser authentication
enabled. Private proxies work when the phone can resolve the hostname and its
system browser trusts the proxy certificate. TOTP remains available on older
supported clusters.

### Self-signed proxy certificates

The login screen includes **Trust self-signed certificate**, equivalent in
intent to `tsh login --insecure`. It disables certificate-chain and hostname
verification for Telemob's HTTPS and terminal WebSocket connections. It is off
by default and should be enabled only after the proxy identity has been verified
through another trusted channel.

This setting cannot change trust inside the system browser. Browser MFA still
requires the proxy certificate to be trusted by the phone's browser.

## Current limitations

- Local Teleport users only; SSO is not implemented.
- SSH nodes only; application, database, Kubernetes, and desktop access are not
  implemented.
- No file transfer, agent forwarding, session joining, or per-session MFA.
- iOS background execution is bounded by the operating system and cannot
  guarantee an indefinitely live socket.
- The web build is a UI preview and cannot connect to a real cluster.

The detailed design and protocol boundary are documented in
[Architecture](docs/architecture.md).

## Validation

```bash
npm run typecheck
npm run lint
npm run test:go
npm run build:core:android
npm run verify:android-native
```

The native verifier rejects an Android artifact unless the Go bridge exists for
all four ABIs and every 64-bit shared library uses at least 16 KB ELF LOAD
alignment. Pull requests and pushes to `main` run the source checks in GitHub
Actions; the signed release workflow additionally verifies the exact AAB
downloaded from EAS before it can be submitted.

## Releases

Maintainer release builds are tag-driven:

- `v1.2.3` builds Android and iOS with the EAS `production` profile.
- `v1.2.3-beta.0` builds both platforms with the EAS `beta` profile.

The workflow validates the tag, derives the user-facing app version, then starts
independent Android and iOS jobs. A platform failure is reported without
cancelling the other platform's build. Both Android profiles produce a signed
AAB; beta builds are submitted to Play Open testing. Both iOS profiles use App
Store distribution; beta builds are submitted to TestFlight. Each platform
stores its own EAS build metadata with the workflow run.

See [Releases](docs/releases.md) for required secrets, credentials, tagging, and
fork setup.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
and the [documentation index](docs/README.md) before making a larger change.
Please review [Privacy and data flow](docs/privacy.md) and report vulnerabilities
using the process in [SECURITY.md](SECURITY.md).

## Credits and trademark notice

Telemob exists because of [Teleport](https://github.com/gravitational/teleport),
the open-source infrastructure access platform created by
[Gravitational](https://goteleport.com/). Teleport's public documentation,
source, and protocol behavior were invaluable references while building this
client. All credit for Teleport itself belongs to its maintainers and
contributors.

The Teleport name, logo, and related marks belong to their respective owners.
Use of the name in this repository describes compatibility only and does not
imply endorsement or affiliation.

Telemob also builds on [Expo](https://expo.dev/),
[React Native](https://reactnative.dev/), [Go](https://go.dev/),
[`gomobile`](https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile), and
[`libghostty-vt`](https://github.com/ghostty-org/ghostty), along with the other
projects listed in its dependency manifests. Ghostty's required MIT notice is
bundled with both mobile apps and kept in
`modules/expo-teleport/native/licenses`.

## License

Telemob is released under the [MIT License](LICENSE). Third-party dependencies
and referenced projects remain subject to their own licenses.
