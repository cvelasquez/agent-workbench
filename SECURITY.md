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
session id, file name or history file.
