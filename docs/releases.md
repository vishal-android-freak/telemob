# Releases

> Telemob is an unofficial, independent client and has no affiliation with
> Gravitational Inc. or the Teleport project.

GitHub Actions validates every change and starts signed Android and iOS builds
on EAS when a supported version tag is pushed.

## Tag formats

Only these forms are accepted:

- Stable: `v1.X.Y`, for example `v1.2.3`.
- Beta: `v1.X.Y-beta.N`, for example `v1.2.3-beta.0`.

Other tags matching the broad GitHub trigger fail during metadata validation and
do not start a mobile build. The workflow derives Expo's user-facing numeric
version (`1.2.3`) from either tag. EAS remotely increments Android `versionCode`
and iOS `buildNumber` on each build.

## Build profiles

| Tag | EAS profiles | Android | iOS |
| --- | --- | --- | --- |
| `v1.X.Y` | `production` | Store-signed AAB | App Store archive |
| `v1.X.Y-beta.N` | `beta` | Store-signed AAB; submitted to Play Open testing | App Store archive; submitted to TestFlight |

After shared source validation, Android and iOS run as independent sibling jobs.
They start concurrently, neither job depends on the other, and one platform's
failure does not cancel or skip the other platform. The overall workflow still
reports failure when either job fails. Each job uploads its own EAS JSON result
as a workflow artifact. For beta tags, the completed Android build is submitted
to Google Play's `beta` track, which is the Open testing track.

Before submitting Android, its job downloads the exact AAB produced by EAS and
checks it with
`scripts/verify-android-native-libs.sh`. A release fails if the Go bridge is
missing from any AAB ABI or if any 64-bit native library is not aligned for
16 KB memory pages. The EAS pre-install hook pins Go 1.26.4 and builds the Go
bridge and the pinned Ghostty terminal JNI library for `armeabi-v7a`,
`arm64-v8a`, `x86`, and `x86_64`. Both native layers pass the required 16 KB
linker alignment; the completed AAB is checked rather than trusting an
intermediate archive. The iOS job builds Ghostty with Homebrew's versioned
`zig@0.15` bottle to avoid the upstream macOS archive linker failure on current
Xcode workers.

Stable tags create builds without submitting them. Beta tags submit Android to
Google Play Open testing and upload iOS to TestFlight, but do not submit the iOS
build for App Review or publish a GitHub Release.

Because the iOS target supports iPad, App Store Connect requires both iPhone and
iPad product-page screenshots. Refresh both sets when a release materially
changes navigation, node cards, or the terminal layout.

## Store review demo

Signed native builds contain an offline, deterministic review flow. It is
activated only when all of these values are entered exactly:

- Proxy: `demo.telemob.invalid`
- Username: `play-review`
- Password: `telemob-demo`
- Second factor: `TOTP`
- Authenticator code: `123456`

These are identifiers for local demo content, not credentials for an external
service. They are intercepted before any network request is made. Every other
login continues through the real Teleport transport. The demo session uses the
same native terminal bridge and Android foreground service as a real session so
store reviewers can verify background retention, notification permission, and
the notification Disconnect action.

## Maintainer setup

1. Link the repository to an EAS project and set `expo.owner` and
   `expo.extra.eas.projectId` in `app.json`.
2. Configure Android and iOS signing credentials once with interactive EAS
   builds for both the `production` and `beta` profiles.
3. Assign an App Store Connect API key to `com.naarang.telemob` in EAS for
   submissions, link the EAS project to the App Store Connect app, and set its
   numeric Apple ID in the `testflight` submit profile.
4. Create an Expo personal access token and add it to the GitHub repository as
   the `EXPO_TOKEN` Actions secret.
5. Create a Google service account with access to the Google Play Android
   Developer API. In Play Console, grant it access to Telemob with the `View app
   information` and `Release apps to testing tracks` permissions.
6. Upload the service-account JSON key to the EAS project's Android credentials
   for `com.naarang.telemob`. Do not commit the key or add it to GitHub Actions.
7. Configure the Play Console Open testing track, including countries, tester
   access, and a feedback address.
8. Protect release tags and limit who can create them.

EAS cloud builds require network access and may consume plan build credits.
Signing credentials remain managed by EAS; they are not committed to Git.

## Cutting a release

Make sure `main` is green and the intended commit is checked out, then create
and push an annotated tag:

```bash
git tag -a v1.2.3 -m "Telemob v1.2.3"
git push origin v1.2.3
```

For a beta:

```bash
git tag -a v1.2.3-beta.0 -m "Telemob v1.2.3 beta 0"
git push origin v1.2.3-beta.0
```

Follow the `Mobile release` workflow in GitHub Actions. A beta tag builds both
platforms, automatically submits the Android AAB to Play Open testing, and
uploads the iOS archive to TestFlight. Open the workflow's EAS links to inspect
the builds and submission results.

## Forks

Fork maintainers must replace the upstream EAS owner/project ID and usually the
Android package and iOS bundle identifier. They must also configure their own
Expo token, signing credentials, Apple team, Google Play app, and Google service
account key in EAS.

Secrets are intentionally unavailable to pull requests from forks, and ordinary
branches never start signed release builds.
