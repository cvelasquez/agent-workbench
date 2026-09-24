# Security

Agent Workbench runs a local server that launches processes, so security
reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/cvelasquez/agent-workbench/security/advisories/new)).

Include what you did, what happened and what you expected. You'll get an answer
within a few days. Fixes ship in the next release and are credited in the
changelog, unless you prefer otherwise.

Only the latest published version is supported.

## The security model, in short

- The server listens **only on `127.0.0.1`**, on an ephemeral port.
- A random per-start token is required by the WebSocket and every HTTP route,
  and requests with a foreign `Origin` are rejected.
- **Remote access is off by default and never opens the app to the network.**
  With it on, the port is a fixed one —still on `127.0.0.1`— and another
  computer reaches it through an SSH tunnel that you set up. That computer is
  paired once with a one-time code and then presents its own credential, of
  which the app stores only a hash. A paired device can't pair or revoke
  others, and can't make the host open files or folders with its own apps. The
  `Host` and `Origin` checks apply to it as well.
- **The Android app** comes in the same way, through an SSH tunnel it opens
  itself. Its SSH key is generated on the host, shown once in the pairing QR
  and never written to the host's disk; the line you add to `authorized_keys`
  restricts it to the tunnel to the app's port, with no terminal and no
  commands. On the phone, the key and the device credential are encrypted with
  the Android Keystore, the host's SSH fingerprint is pinned on the first
  connection, and unencrypted traffic is allowed only to `127.0.0.1`, the
  phone's end of the tunnel. See [`PRIVACY.md`](PRIVACY.md).
- **No telemetry and no outgoing network calls.** The CLIs you launch talk to
  their providers exactly as they do in a plain terminal.
- The app **never reads, stores or forwards credentials** of any CLI, has no
  login of its own, and injects no authentication variables into the processes
  it launches.
- The browser never names an absolute path: every path is resolved inside the
  folder of a tab the server itself opened.
- Nothing is written in any CLI's folder. Inside a project, the only writes are
  the shared-memory files, after a preview and your confirmation.

The full list of what is read and what is never opened, per CLI, is in
[`ARCHITECTURE.md`](ARCHITECTURE.md#4-what-is-read-from-each-cli).

## What counts

Anything that breaks one of the statements above: a way to reach the server
from another origin or machine, to read or write outside a tab's folder, to
make the app open a credentials file, or to execute a command through a crafted
session id, file name or history file. With remote access: a way in without
pairing, a pairing code that works twice or survives its attempts, a revoked
device that still gets in, or a paired device doing what only the host may.
With the Android app: a pairing QR still good after it was used or cancelled,
a key line that allows more than the tunnel, a way to make the app connect to
a host whose fingerprint changed, or a secret stored unencrypted on the phone.

Reaching the machine over SSH is outside the app: it's your system's SSH server,
with your user's login. The README recommends a key restricted to the tunnel.
