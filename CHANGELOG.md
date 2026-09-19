# Changelog

All notable changes to Agent Workbench. Versions follow
[semantic versioning](https://semver.org); while in `0.x`, a minor version may
change behavior.

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
