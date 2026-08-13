# Security policy

Telemob handles credentials and remote shell sessions, so security reports are
taken seriously.

Telemob is an unofficial, independent project. It is not affiliated with or
maintained by Gravitational Inc. or the Teleport project. Vulnerabilities in
Teleport itself should be reported through Teleport's own security process.

## Supported versions

Until the first stable public release, only the latest commit on `main` is
supported. After stable releases begin, the latest stable release and current
beta line will receive security fixes when practical.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. If that option
is unavailable, contact the repository owner privately through their GitHub
profile before sharing details publicly.

Do not open a public issue containing:

- passwords, TOTP seeds, passkey responses, bearer tokens, or cookies;
- private proxy hostnames, certificates, IP addresses, or node inventories;
- terminal recordings or logs containing confidential output;
- a working exploit before a fix or mitigation is available.

Include affected versions, platform and OS version, reproduction steps, impact,
and any suggested mitigation. Reports will be acknowledged and triaged as soon
as maintainer availability permits; this community project does not promise a
commercial response SLA.

## Deployment guidance

- Leave insecure TLS disabled unless you independently verified the development
  proxy and understand that certificate-chain and hostname checks are bypassed.
- Install a private CA on the phone when possible instead of bypassing TLS.
- Revoke the Teleport web session and sign out of Telemob if a phone is lost or
  compromised.
- Treat beta builds as test software and review release notes before upgrading.
