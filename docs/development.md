# Development

> Telemob is an unofficial, independent client and has no affiliation with
> Gravitational Inc. or the Teleport project.

## Toolchain

- Node.js 22 or newer with npm.
- Go 1.26.4 or newer. Android release bindings must use Go 1.26.4 or newer so
  the generated 64-bit ELF libraries support 16 KB page sizes.
- `gomobile` and `gobind` at the version pinned by `go/teleportmobile/go.mod`.
- Android SDK, NDK, and JDK 17 for Android builds.
- Xcode on macOS for iOS builds.

Install JavaScript dependencies with the committed lockfile:

```bash
npm ci
```

Install the Go mobile tools:

```bash
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260812174124-2f419b2fb945
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260812174124-2f419b2fb945
```

## Web preview

```bash
npm run web
```

Expo web uses the deterministic client in `src/lib/teleport/client.ts`. It is
useful for UI development but never contacts a real Teleport proxy. Expo Go has
the same limitation because it cannot load the custom native module.

## Android

Generate the Go AAR before Expo prebuild:

```bash
npm run build:core:android
npm run verify:android-native
npx expo prebuild --platform android
npx expo run:android --device
```

The generated AAR is written to
`modules/expo-teleport/android/libs/teleportmobile.aar` and is ignored by Git.
The generated AAR contains `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64` so
each ABI delivered by Google Play includes the Go bridge. Local development is
tested on a Pixel 10. When invoking Gradle directly for that device, pass
`-PreactNativeArchitectures=arm64-v8a` to shorten a device-only debug build;
never use that override for a release bundle.

Android terminal sessions use a foreground service. Test both notification
permission outcomes, the notification Disconnect action, app background/resume,
and the in-app Disconnect button after native changes.

Android builds support portrait and landscape. Pixel 10 remains the primary
physical-device target, while the x86 and x86_64 bindings also support Android
emulator and compatible ChromeOS delivery.

Expo prebuild applies the Google Play compliance plugin after the standard Expo
plugins. The generated main activity is resizable and has no fixed orientation
or aspect-ratio attributes. The generated app theme also omits the deprecated
status-bar and navigation-bar color parameters; screens draw edge to edge and
use safe-area insets instead.

## iOS

On macOS:

```bash
npm run build:core:ios
npx expo prebuild --platform ios
npx expo run:ios --device
```

The generated XCFramework is written to
`modules/expo-teleport/ios/Frameworks/Teleportmobile.xcframework` and is ignored
by Git. The Expo podspec intentionally compiles only `ExpoTeleportModule.swift`;
gomobile headers must remain owned by the vendored XCFramework rather than the
Expo module's generated umbrella header.

The iOS target supports both iPhone and iPad. App Store releases therefore need
current iPhone and iPad screenshots in App Store Connect.

## Responsive UI verification

Responsive behavior is derived from the live window dimensions, not from a
device-model allowlist. Check all three screens at these representative sizes:

| Class | Representative viewport | Expected behavior |
| --- | --- | --- |
| Compact phone | 390 x 844 portrait | Single-column login and node list |
| Short landscape phone | 844 x 390 | Split login, dense terminal controls |
| Tablet portrait | 1024 x 1366 | Split login, two-column node grid |
| Tablet landscape | 1366 x 1024 | Split login, three-column node grid |

Rotate while a terminal is connected. The terminal must consume the remaining
screen, recompute its rows and columns, and send the resulting PTY resize to the
remote process. Also verify rotation with the software keyboard both open and
dismissed; keyboard height must not be mistaken for a permanent device size.

## Connecting to a development proxy

- The phone must be able to resolve and route to the proxy hostname. A host
  entry on the development computer does not configure the phone.
- Private DNS names generally require local DNS, VPN, or an explicit development
  network configuration.
- Prefer installing the development CA on the phone. Use Telemob's insecure TLS
  switch only for a proxy whose identity you verified another way.
- Browser MFA uses the system browser, so its certificate still needs to be
  trusted by that browser even when Telemob's insecure TLS switch is enabled.

## Validation

Run all repository checks before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run test:go
npm run build:core:android
npm run verify:android-native
```

`verify:android-native` accepts the generated AAR by default and may also be
given an APK or AAB path. It checks that `libgojni.so` is present for
`armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`, then inspects every 64-bit
shared library for 16 KB ELF LOAD alignment.

Native transport changes should additionally be exercised against a development
Teleport cluster on the affected platform. Terminal changes should be checked
with an ordinary shell and at least one alternate-screen TUI, in both portrait
and landscape when viewport behavior changed.

## Generated and local-only files

Do not commit:

- `android/` or `ios/` generated by Expo prebuild;
- `.tools/`, which holds local Go build tools and caches;
- generated AARs or XCFrameworks;
- signing keys, provisioning profiles, certificates, or local environment files.

The EAS pre-install hook regenerates the correct Go artifact independently on
each cloud platform.
