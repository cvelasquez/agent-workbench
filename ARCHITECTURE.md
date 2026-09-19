# Architecture

How Agent Workbench is put together, and the rules every change is reviewed
against. Read this before touching the server; read
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to work on the repository.

Agent Workbench is a **local visual interface for coding-agent CLIs**. It does
not talk to any provider's API. It launches the binary you already have
installed and logged in —`claude`, `codex`, `opencode` or `agy`— inside a
pseudo-terminal, and adds around it what a terminal alone doesn't give you:
tabs, browsable history, the conversation as cards, a file tree, a git panel
and a context meter.

---

## 1. The hard rules

These are security requirements, not style preferences. A design that breaks
one is discarded even if it's more convenient.

### 1.1 Credentials are never touched

- The app never reads, copies, parses or forwards any CLI's credentials or
  session tokens. The "never opened" column in [section 4](#4-what-is-read-from-each-cli)
  is the list.
- There is no OAuth, no "sign in" button, and no credential prompt in the UI.
  If you aren't logged in, you log in inside the terminal, the way the CLI
  asks. The app doesn't take part.
- No authentication variable is ever injected into the processes it launches.
  The environment is inherited as is. **An adapter may only remove variables,
  never add them**, and each removal the user should know about is surfaced as
  a notice.
- One declared exception: `OPENCODE_SERVER_PASSWORD`, a random 48-hex password
  generated on every start, given **only** to the `opencode serve` process the
  app launches, because that command has no flag to receive it. It isn't an
  account credential, it's never logged and never sent to the browser.

### 1.2 The CLI binaries are used unmodified and unbundled

- No CLI is included in the repository or the npm package, or downloaded on
  install. Each one is looked up in the `PATH`; one is enough.
- A missing CLI doesn't hide its history: its sessions stay in the sidebar,
  dimmed.
- The CLIs aren't patched or wrapped in a way that alters their behavior.
  Launching a subcommand the CLI itself documents is using it, not wrapping it.

### 1.3 The brand

- The product is called **Agent Workbench**. Neither the name, the logo nor any
  feature carries the name of a CLI or its maker.
- A CLI's name is *compatibility data* and lives in two places: its adapter id
  (`AGENT_IDS` in `packages/shared/src/agents.ts`) and that adapter's folder.
  Everything generic uses neutral identifiers (`agentCli`, `sessionIndex`) and,
  when a text must say which CLI, `adapter.label` — never a literal.

### 1.4 The local server

The app runs a Node server that launches processes: exposed, it would be a
remote-execution vector.

- Listens **only** on `127.0.0.1`, on an ephemeral port.
- A random per-start token is required by the WebSocket and **every** HTTP
  route. Requests whose `Origin` isn't the app's own are rejected.
- No telemetry, no analytics, **no outgoing network calls**.
- **The client never names an absolute path.** Every path arriving over the
  WebSocket is relative and resolved inside the `cwd` of a tab the server
  itself opened (`path-guard.ts`, `resolveInside`). Sessions are named by
  `(agent, sessionId)`, folders by a server-side picker id, exports by project
  key. Without this, listening on loopback wouldn't matter: a UI bug could read
  a credentials file with one message.
- The guard runs **before reading**, not only before writing: a versioned file
  that is a link to somewhere outside the project isn't opened.

---

## 2. Layout

A pnpm monorepo, TypeScript throughout.

```
packages/
  server/     Node 20+, Express, ws, node-pty, chokidar; node:sqlite on Node 22.13+
    src/agents/
      adapter.ts           the interface of a CLI adapter
      registry.ts          the list of adapters; which CLI opens each tab
      locate.ts            find a command in the PATH, .cmd shims included
      jsonl-follower.ts    read a JSONL by offset, for any CLI
      sqlite.ts            someone else's SQLite database, read-only
      transport-limits.ts  how much text travels to the browser
      claude-code/  codex/  opencode/  antigravity/    one folder per CLI
    src/
      terminal-registry.ts    the ptys and their life cycle
      session-index.ts        the projects sidebar, built from every adapter's history
      path-guard.ts           resolveInside: the only way a client path becomes a real one
      memory-hub.ts           shared memory: the one thing written inside a project
      handoff/                continue a conversation with another CLI
      global-search.ts        search across the text of every conversation
      vault/                  the app's own copy of the history
    scripts/                  the checks run by `pnpm check`
  web/        Vite, React 18, xterm.js, highlight.js
    src/i18n/   the interface texts, nine languages
  shared/     the protocol types, shared by both sides
scripts/
  build-npm.mjs   builds the npm package into dist-npm/
  demo/           made-up data and four simulated CLIs, for screenshots
assets/           the README screenshots, from `pnpm demo:shots`
```

`pnpm dev` runs the server with Vite as middleware; `pnpm build` + `pnpm start`
serve the compiled interface. One process serves the interface and the
WebSocket on the same port, so the `Origin` check and the token work the same
in development and production.

There is no Electron or Tauri. The UI avoids browser APIs with no webview
equivalent and talks only over the WebSocket, so wrapping it later is a
packaging change, not an architectural one.

**Protocol:** one WebSocket, JSON messages discriminated by `type`, types in
`shared/`. No `any` at the edges: whatever arrives is `unknown` until a parser
narrows it. Texts the server sends to the user travel as a key plus values
(`ServerText`), and the browser builds the sentence in its language.

---

## 3. The decisions that shape everything else

### 3.1 A process doesn't depend on the WebSocket

The ptys live in a server registry with their own life cycle; the WebSocket is
only transport. If a process died with its socket, an accidental reload would
wipe out a working session.

- Each terminal keeps a ring buffer of recent output to repaint the screen when
  the client reconnects. The client re-attaches by `terminalId`.
- A pty dies only if the user closes it, its process ends, or the server shuts
  down.

### 3.2 A tab isn't a process

A tab can exist without a pty: it's *asleep*. That's what starting the app
gives you. The conversation, the meter, git and the file tree come from the
history file and the `cwd`; the pty is only needed to **write** to the agent,
and the user decides when (`terminal.wake`). Restoring six tabs doesn't start
six CLI processes.

### 3.3 node-pty on Windows

Windows 11 is the primary platform and the one that can't break.

- The executable is resolved at startup. A `.cmd`/`.bat` shim (the common case
  for npm-installed CLIs) is launched through `cmd.exe /c`.
- **Behind `cmd /c`, no argument may contain spaces or quotes.** A second pair
  of quotes breaks the whole launch, not just that argument. Adapters validate
  ids by shape (uuid, `ses_…`) before building a command line — which also
  stops an id like `x&<command>` from being executed by `cmd`.
- **Never pass a signal to `kill()` on Windows.** It throws, deferred, from
  inside a node-pty callback no `try/catch` reaches, and takes the server down.
  `kill()` without arguments on `win32`; SIGTERM → SIGKILL elsewhere.
- Every terminal `resize` is forwarded to the pty.

### 3.4 The generic server doesn't name any CLI

Everything the server knows about a CLI lives behind `AgentAdapter`
(`agents/adapter.ts`). The terminal registry, the hub, the index, the watcher
and the socket talk only to that interface.

| The generic code asks… | Member |
|---|---|
| where the binary is, and what to say if it's missing | `locate()`, `missingMessage()` |
| with which arguments it's launched | `launch()` → `LaunchPlan` (or a promise of one) |
| how a message is written into the pty | `input` |
| with which environment | `environment()` — may remove, never add |
| what to do once the process is running | `onSpawned()` → `LaunchHook` |
| what history exists and how it's followed | `history` → `HistorySource`, `SessionFollower` |
| whether the process is working, idle or waiting | `status`, or null |
| how a question card is answered | `questions`, or absent |
| which folders the folder picker must never list | `protectedDirs()` |

Rules the interface can't enforce by itself, and that every adapter follows:

- The environment never gains variables.
- Native history is read, never written.
- An adapter doesn't type into the pty: it provides data, and key sequences are
  built in `pty-input.ts`.
- **A capability is a measurement, not a promise.**

### 3.5 Capabilities

`AgentCapabilities` (`shared/agents.ts`) travels to the browser with each CLI.
The interface never asks "is this CLI X?"; it asks "does it have a permission
cycle?", "does it publish tokens?", "can it take images by path?".

- **A capability is off on both sides.** The interface hides the control, and
  the socket rejects the message with `agent-unsupported` *without writing to
  the pty*. With only the UI side, a stale client would send keys to a CLI that
  doesn't expect them.
- **The parser never fails on a capability.** An unknown field falls back to
  "off"; an unknown CLI in a list is dropped alone. A newer server hides a
  control, it doesn't break the screen.
- The mapping from capabilities to controls lives in one file without JSX,
  `web/src/agent-ui.ts`, so the checks can import it.

Adding a CLI means: a new folder under `agents/`, its id in `AGENT_IDS`, one
static import in `registry.ts`, its reads declared in section 4 of this file,
and a writer for its history format in `scripts/demo/`.

---

## 4. What is read from each CLI

Each adapter declares what it reads; generic code opens no CLI folder by
itself. Nothing is ever **written** in any CLI's folder.

| CLI | Read | Never opened |
|---|---|---|
| **Claude Code** (`~/.claude`) | `projects/*.jsonl` (history) and `projects/<slug>/memory/*.md`; `sessions/<pid>.json` (live status); `plans/*.md` and session `.md` files, **only** when the conversation being viewed named them. The folder is never walked | `.credentials.json` |
| **Codex** (`CODEX_HOME` or `~/.codex`) | `sessions/**/rollout-*.jsonl`, `archived_sessions/`. `CODEX_HOME` itself is never listed | `auth.json`, `cap_sid`, `.sandbox-secrets/`, `config.toml` (MCP server environments can carry secrets), the `*.sqlite` files |
| **OpenCode** (xdg-basedir folders) | the SQLite database, read-only: named columns of `session`, `message` and `part`, always filtered by id; the models catalog. From the app's own `opencode serve`, over loopback with basic auth: a fixed list of seven endpoints | `auth.json`, `account.json`, `mcp-auth.json`; the `account`, `credential`, `session_share` and `permission` tables; response headers and bodies stored in error records; `opencode.json` (can carry API keys) |
| **Antigravity CLI** (`~/.gemini/antigravity-cli`) | `brain/<id>/…/transcript*.jsonl`, `history.jsonl`, two fields of `settings.json`, and a **copy** of the conversations index (see below). `~/.gemini` is never walked | `mcp/`, MCP config files, the OS keychain, the contents of `conversations/*`, the whole IDE folder `~/.gemini/antigravity/`, the browser profile, and everything of Gemini CLI (`oauth_creds.json`, `google_accounts.json`, `.env`) |

Every folder above is in its adapter's `protectedDirs()`: the folder picker
won't list or enter it, installed or not.

**SQLite databases in WAL mode.** Opening one read-only still creates `-wal`
and `-shm` files next to it. For a small index (Antigravity) the app reads a
private temporary copy, deleted after each read. OpenCode's database is too
large to copy, so that footprint is declared instead: it's the only trace the
app leaves in any CLI's folder. No `opencode` subcommand is ever run to read
history, because any of them modifies the database.

**One-off importers** (`vault/importers/`, run by hand with
`pnpm vault:import`) rescue orphaned history of tools without an adapter. They
aren't part of the server, read a narrow, explicit list of files, and never
touch credentials.

### Where the app writes

- Its own configuration directory: tabs, index cache, notes, archived
  sessions, settings, and the history copy (or the folder the user picks).
- The system temp folder: pasted images and attachments, per-tab CLI logs,
  temporary database copies. Folders are created `0o700`, files `0o600`.
- **One place inside a project: shared memory** — `.agents/memory/`, the text
  *between the markers* of a block in `AGENTS.md`/`CLAUDE.md`, and a few lines
  at the end of `.gitignore`. Always after a file-by-file preview and the
  user's confirmation. The client sends **options**, never changes or paths;
  the server builds the plan, validates all of it with `resolveInside` before
  the first write, and rebuilds it on confirm instead of trusting what the
  browser saw.

---

## 5. Checks

The web has no test runner; the server has `pnpm check`, a chain of scripts in
`packages/server/scripts/`. They cover what breaks silently: the incremental
JSONL follower (lines split across reads, UTF-8 cut in half), the context
window, `git status --porcelain=v2 -z` parsing, the path guard, the shared
memory bridge, every adapter's event mapping, the history copy, handoff, global
search and the nine locale files.

Two rules for writing one:

- **A check never touches the real thing.** It points the home directory and
  every CLI variable at a folder of its own *before importing anything*, never
  launches a real CLI and never loads node-pty.
- **Compare against literals.** The UI texts and capabilities of existing CLIs
  are compared byte by byte with what they were, so adding a CLI can't quietly
  change another one.

If you touch a covered area, the new case goes into its check.

---

## 6. About the `§` citations in code comments

Comments cite sections like `§3.2` or `§11.12`. They point to the maintainer's
working notes, which are in Spanish and aren't part of the repository. You
don't need them: a comment that cites a section also states the reason in
place, and this file carries the rules. If one doesn't, that's a bug in the
comment — open an issue.
