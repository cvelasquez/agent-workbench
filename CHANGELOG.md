# Changelog

All notable changes to Agent Workbench. Versions follow
[semantic versioning](https://semver.org); while in `0.x`, a minor version may
change behavior.

## 0.4.0 — unreleased

### Added

- **Remote access over SSH (optional, off by default).** Leave the app running
  on one computer and use it from the browser of another one on the same
  network, with no CLI installed there. The app keeps listening only on
  `127.0.0.1`: the other computer reaches it through an SSH tunnel, so nothing
  is opened to the network. A new ⇄ dialog turns it on (fixed port, applied on
  restart), gives you the tunnel command to copy, pairs a device with a one-time
  code and lists the paired devices, which you can rename or revoke on the spot.
  A paired device can use the whole app but can't manage remote access or open
  files with the host's apps. See "Remote access over SSH" in the README.
- **System notifications.** A bell button in the header: "finished" and "is
  waiting for you", with the tab's name, shown only when the window isn't in
  view. Same rule as the notification sound; each browser keeps its own choice.
- **A phone-sized layout.** Under 768 px the interface becomes a single
  column: the projects sidebar slides in from the left, the active tab sits in
  the header and opens the list of tabs, and a strip switches between the
  conversation, the CLI, changes, files, plans, memory, notes and the console.
  The CLI view adds a row of keys a phone keyboard lacks (Esc, Tab, arrows,
  Ctrl+C). On any touch screen, what used to appear on hover is always visible,
  and a long press selects a session row. `/?tab=<id>` in the address opens
  that tab. Nothing changes on a desktop-sized window.

### Fixed

- **Two windows on the same tab left the terminal drawn for the other one's
  size** until a divider was moved. A window now sends its size again when it
  gets the focus back.

## 0.3.1 — 2026-09-19

### Fixed

- **macOS: no tab could start a CLI** (`posix_spawnp failed`). The terminal
  library ships its helper binary without the executable bit, so the interface
  loaded but every tab failed to open. The app now repairs it when it starts. It
  affected every version up to 0.3.0: update and restart.

### Changed

- Every push, and every release before it is uploaded, now installs the package
  from scratch and starts it on Windows, Linux and macOS, with Node 20 and 22:
  the server has to come up and a pseudo-terminal has to spawn a process. That
  test is what found the bug above.

## 0.3.0 — 2026-09-19

### Added

- **The interface in nine languages**: English, Spanish, German, French,
  Brazilian Portuguese, Russian, Japanese, Korean and Simplified Chinese. It
  opens in the browser's language and switches from the header without
  reloading. Adding a language is one JSON file
  ([how](CONTRIBUTING.md#adding-a-language)).
- **Attach a file** to a message from the composer.
- **Pasted text as a chip**: a long paste becomes a numbered, editable chip in
  the composer and a collapsed card in the thread, instead of flooding both.
- **Notification sounds** when a CLI finishes or is waiting for you, on any
  tab. Synthesized, no audio files; toggle and volume in the header.
- **Open with the system app** from the file tree.
- **Thread font size** control.
- Notes panel moved to the right side.

### Fixed

- Codex on Windows: a long message could be left unsent because the Enter
  arrived while Codex was still processing the paste.
- A task notification from the CLI was drawn as if the user had written it.
- Whatever the app sends to a CLI in natural language (attachments, handoff
  message, the shared-memory block) is now always in English, regardless of the
  interface language.

### Changed

- The server console, the launcher and the documentation are in English.
- Protocol version 8: a page left open across the update asks you to reload.
- Releases are published from GitHub Actions with npm provenance.

## 0.2.0 — 2026-09-16

- Four CLIs behind adapters: Claude Code, Codex, OpenCode and Antigravity CLI.
- Shared memory across CLIs, continue a conversation with another CLI, search
  across every conversation, and the app's own copy of the history with
  Markdown export.

## 0.1.0 — 2026-09-10

- First release: tabs, browsable history, the conversation as cards, context
  meter, git panel and file tree around the Claude Code CLI.
