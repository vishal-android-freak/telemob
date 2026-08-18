# Local TCP forwarding

Telemob can expose a TCP service reachable from a selected Teleport SSH node as
a loopback port on the phone. This is useful for a private web console, database
port, or another TCP service that already allows connections from that node.

## Starting a forward

1. Open the node list and select the `⇄` action beside an allowed SSH login.
2. Enter the destination host and port as the selected node should resolve and
   reach them. Use local port `0` to let the phone select a free port.
3. Authorize the temporary SSH certificate with a password and either TOTP or
   Browser MFA passkey.
4. Connect the phone app that needs the service to the displayed
   `127.0.0.1:<port>` address.

`127.0.0.1` means the phone itself. It is deliberately not reachable from other
devices on the same Wi-Fi network. Saved rules retain only node and address
settings; they never start automatically and never contain a password, TOTP
code, passkey assertion, cookie, or SSH private key.

## Managing saved forwards

- **Start** opens a listener from the saved settings.
- **Edit** changes the saved name, destination host and port, or preferred local
  port. Saving an edit does not restart or alter an active listener.
- **×** asks for confirmation before removing the saved settings. Removing a
  saved forward does not stop an active listener; use **Stop** for that.

## Transport and authorization

Telemob generates an SSH key on the phone and asks the configured Teleport proxy
for a temporary user certificate. It verifies the proxy and node SSH host
certificates against the host authorities returned by Teleport. TLS-routing and
separate SSH-listener proxy configurations are both supported, including FIPS
clusters.

For TLS-routing proxies, Telemob first connects using Teleport's native
`teleport-proxy-ssh` ALPN transport over TCP/TLS. If an HTTP reverse proxy
accepts the connection but strips that custom ALPN value, Telemob falls back to
Teleport's official `/webapi/connectionupgrade` WebSocket transport and performs
the same TLS/SSH negotiation inside it. WebSocket is therefore a compatibility
path, not the terminal renderer's local transport or the preferred forwarding
path.

The listener opens one SSH `direct-tcpip` channel through the selected node for
each local client connection. Teleport and the node enforce the user's roles,
port-forwarding permission, destination reachability, certificate lifetime,
session recording, and audit policy. Telemob cannot bypass those controls.

## Lifetime and platform behavior

- Multiple forwards and multiple client connections can run concurrently.
- Stop closes the listener and all connections currently using it.
- If the SSH transport fails, Telemob closes that forward rather than silently
  sending traffic through a replacement connection. A saved rule can be started
  again after connectivity returns.
- Android keeps active forwards in the visible Telemob foreground service.
- iOS permits only a finite general-purpose background task. A forward is
  reliable while Telemob is foregrounded and best-effort after iOS suspends it.
- Local TCP forwarding is implemented. Remote forwarding and dynamic/SOCKS
  proxying are not.

The explicit insecure-TLS setting also applies to the SSH-over-TLS proxy
connection. It should be used only for a proxy whose identity was verified by a
separate trusted method. SSH host certificates are still validated.
