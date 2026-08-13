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
- Clipboard text only after the user invokes paste.

The password is not persisted. Telemob serializes the authenticated web session
into platform SecureStore so it can restore an unexpired login after a cold
launch. Signing out, an expired/rejected session, or an authorization failure
clears the saved profile.

## Network destinations

Native builds connect directly to the Teleport proxy address supplied by the
user. Browser MFA opens a page on that proxy in the system browser and uses an
encrypted local loopback callback to return the result to Telemob.

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
- Android notification permission controls how the active terminal foreground
  service is surfaced by the operating system.
- Clipboard contents are requested only through the Paste action.
- The system browser handles Browser MFA and applies its own DNS, certificate,
  cookie, and privacy behavior.

## Insecure TLS

When explicitly enabled, insecure TLS disables certificate-chain and hostname
verification for Telemob's direct proxy connections. This can expose
credentials and terminal traffic to interception. It does not change the system
browser's trust policy.

Security concerns should be reported through [SECURITY.md](../SECURITY.md).
