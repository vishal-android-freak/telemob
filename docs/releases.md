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

| Tag | EAS profile | Android | iOS |
| --- | --- | --- | --- |
| `v1.X.Y` | `production` | Store-signed AAB | App Store archive |
| `v1.X.Y-beta.N` | `beta` | Installable internal APK | Ad hoc IPA for registered devices |

The workflow waits for both platform builds. A failed Android or iOS archive
fails the GitHub Actions run. The EAS JSON results are uploaded as a workflow
artifact and the EAS build links are added to the job summary.

Tagging creates builds; it does not automatically submit them to Google Play or
App Store Connect and does not publish a GitHub Release.

## Maintainer setup

1. Link the repository to an EAS project and set `expo.owner` and
   `expo.extra.eas.projectId` in `app.json`.
2. Configure Android and iOS signing credentials once with interactive EAS
   builds for both the `production` and `beta` profiles.
3. Register iOS beta test devices with `eas device:create`, then regenerate the
   ad hoc profile when the device list changes.
4. Create an Expo personal access token and add it to the GitHub repository as
   the `EXPO_TOKEN` Actions secret.
5. Protect release tags and limit who can create them.

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

Follow the `Mobile release` workflow in GitHub Actions and open its EAS links to
download or submit the resulting artifacts.

## Forks

Fork maintainers must replace the upstream EAS owner/project ID and usually the
Android package and iOS bundle identifier. They must also configure their own
Expo token, signing credentials, Apple team, and registered beta devices.

Secrets are intentionally unavailable to pull requests from forks, and ordinary
branches never start signed release builds.
