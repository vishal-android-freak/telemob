# Privacy and data flow

> Telemob is an unofficial, independent client and has no affiliation with
> Gravitational Inc. or the Teleport project.

This document describes the current open-source Telemob application. A modified
fork or third-party binary may behave differently; review its source and
publisher before installing it.

## Data Telemob handles

- The proxy address, username, and insecure-TLS preference entered by the user.
- A password held in memory while Teleport authentication is in progress.
- TOTP codes or Browser MFA results used to complete authentication.
- Teleport web-session cookies and tokens returned by the selected proxy.
- Node metadata and terminal bytes authorized by that proxy.
- Per-profile node favorites, recent connection timestamps, preferred SSH
  logins, and saved node-list filters.
- Per-profile saved local-forward definitions, plus temporary SSH private keys,
  certificates, and Teleport host authorities used to authorize active forwards.
- Clipboard text only after the user invokes paste.

Passwords and TOTP codes are not persisted. Telemob can save multiple Teleport
profiles. Each profile contains display metadata plus its own authenticated web
session snapshot under a separate platform SecureStore key, allowing an
unexpired login to be restored after a cold launch or profile switch. Forgetting
a profile removes its saved session and node preferences. Signing out or a
confirmed expired/rejected session clears authentication while retaining the
profile's connection settings for reauthentication. Transient connectivity
failures do not erase saved authentication.

Forwarding passwords, TOTP codes, and passkey assertions are not persisted.
The temporary SSH private key is generated on the device and stored only inside
the same encrypted profile snapshot as the web session. Forgetting a profile
also removes its saved forwarding definitions.

## Network destinations

Native builds connect directly to the Teleport proxy address supplied by the
user. Browser MFA opens a page on that proxy in the system browser and uses an
encrypted local loopback callback to return the result to Telemob.

When the user starts a local TCP forward, Telemob listens only on
`127.0.0.1` on the phone. Local apps that connect to that port send traffic over
an SSH `direct-tcpip` channel through the selected Teleport node to the remote
host and port chosen by the user. Telemob does not bind forwarding listeners to
Wi-Fi, cellular, VPN, or other externally reachable interfaces.

The current application contains no Telemob-operated account service, traffic
relay, advertising SDK, analytics SDK, or crash-reporting SDK. Expo/EAS is used
to build the application; the production runtime does not use Expo Go or require
an EAS account.

The organization operating the selected Teleport cluster may record login,
resource, audit, and terminal-session data according to its own Teleport
configuration and policies. Telemob does not control that retention.

## Device access

- Secure storage protects the restorable session using Android or iOS platform
  facilities.
- Android notification permission controls how the active terminal/forwarding
  foreground service is surfaced by the operating system.
- Clipboard contents are requested only through the Paste action.
- The system browser handles Browser MFA and applies its own DNS, certificate,
  cookie, and privacy behavior.

## Insecure TLS

When explicitly enabled, insecure TLS disables certificate-chain and hostname
verification for Telemob's direct proxy connections. This can expose
credentials and terminal traffic to interception. It does not change the system
browser's trust policy.

Security concerns should be reported through [SECURITY.md](../SECURITY.md).
