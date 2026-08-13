# Telemob agent guidance

Telemob is an unofficial, independent open-source mobile client for Teleport. It
is not affiliated with, endorsed by, or maintained by Gravitational Inc. or the
Teleport project.

## Project context

- The app uses Expo SDK 57 and React Native with a shared gomobile Go core.
- Read the exact versioned Expo documentation at
  <https://docs.expo.dev/versions/v57.0.0/> before changing Expo or native build
  behavior.
- Read `docs/architecture.md` before changing authentication, transport,
  terminal ownership, or background execution.
- Read `docs/development.md` before running native builds.

## Validation

Run the relevant checks before handing off a change:

```bash
npm run typecheck
npm run lint
npm run test:go
```

Do not commit generated `android/`, `ios/`, gomobile AAR/XCFramework, `.tools/`,
credentials, certificates, provisioning profiles, or local environment files.

## Android development target

Local Android builds and installs are validated on the connected Pixel 10 and
must target only `arm64-v8a`. Pass `-PreactNativeArchitectures=arm64-v8a` and do
not compile emulator or other device ABIs unless the maintainer explicitly asks
for broader ABI support.

## Git history

Do not add AI-tool attribution or `Co-Authored-By` trailers to commits or pull
requests.
