# Contributing to Telemob

Thank you for helping improve Telemob.

Telemob is an independent, unofficial project. It is not affiliated with,
endorsed by, sponsored by, or maintained by Gravitational Inc. or the Teleport
project. Please do not represent contributions or releases as official Teleport
work.

## Before opening a change

- Search existing issues and pull requests before starting duplicate work.
- Open an issue first for large features, protocol changes, or user-visible
  architecture changes.
- Keep credentials, proxy addresses, private certificates, session tokens, and
  terminal output containing sensitive data out of issues and commits.
- Read [Development](docs/development.md) and
  [Architecture](docs/architecture.md).

## Development workflow

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci`.
3. Make the smallest coherent change and update relevant documentation.
4. Run:

   ```bash
   npm run typecheck
   npm run lint
   npm run test:go
   ```

5. Test native changes on the affected platform. Terminal changes should be
   exercised in both a normal shell and an alternate-screen TUI.
6. Open a pull request describing the behavior, rationale, risk, and validation.

Do not commit Expo-generated `android/` or `ios/` directories, gomobile AAR or
XCFramework outputs, `.tools/`, secrets, signing material, or local environment
files.

## Pull requests

Pull requests should be reviewable and narrowly scoped. Include:

- the problem being solved;
- the user-visible outcome;
- any Teleport-version or platform compatibility impact;
- screenshots or recordings for material UI changes;
- commands and devices used for validation.

Changes that affect authentication, certificate verification, credential
storage, terminal framing, session resumption, or background execution require
extra scrutiny because failures can expose credentials or interrupt access.

## CI and releases

Pull requests run TypeScript, lint, and Go tests. Signed EAS builds require
maintainer credentials and run only for supported version tags; fork pull
requests never receive those secrets. See [Releases](docs/releases.md).

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
