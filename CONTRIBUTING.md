# Contributing to Agent Workbench

Thanks for taking a look at the project. It's a small, personal tool, so the
rules are few too. The ones there are, though, aren't negotiable: almost all of
them exist because something went wrong once.

---

## Before writing code

Read [`ARCHITECTURE.md`](ARCHITECTURE.md). It isn't courtesy documentation: it
has the project's hard rules, the code map, what is read from each CLI and the
pitfalls that shape the design: why a tab isn't a process, why
`kill('SIGTERM')` took the server down on Windows, why nothing with spaces goes
behind `cmd /c`. A change that ignores those rules is rejected even if it
works.

Code comments cite sections like `§3.2`. They point to the maintainer's working
notes, which aren't part of the repository; the comment itself carries the
reason.

---

## The four non-negotiable rules

1. **The app doesn't touch any CLI's credentials.** `~/.claude/.credentials.json`
   isn't read, copied or forwarded, nor are the credentials of Codex, OpenCode
   or Antigravity, nor any token: the list of what is never opened, per CLI, is
   in `ARCHITECTURE.md`, section 4. There's no login in the interface. No authentication
   variables are injected into the environment of the processes it launches.

2. **The CLI binaries are used unmodified and unbundled.** They're looked up in
   the `PATH`. They aren't included in the repository, aren't downloaded, and
   aren't wrapped in a way that alters their behavior.

3. **The server listens only on `127.0.0.1`**, with an ephemeral port and a
   random per-start token required by both the WebSocket and every HTTP route.
   No telemetry and no outgoing network calls at all.

4. **The brand.** The product is called Agent Workbench. Neither the name, nor
   the logo, nor any feature carries the name of a CLI or its maker. In the
   code, neutral identifiers (`agentCli`, `cliBinary`, `sessionIndex`). The
   README may say in plain text that it works with the Claude Code, Codex,
   OpenCode and Antigravity CLIs: that's compatibility, not endorsement.

   By the same logic, a CLI's name may appear in the code in two places, as
   compatibility data: its adapter id (`AGENT_IDS` in
   `packages/shared/src/agents.ts`) and that adapter's folder
   (`packages/server/src/agents/claude-code/`, `codex/`, `opencode/`,
   `antigravity/`), where identifiers do name it
   (`createClaudeCodeAdapter`). Outside those folders it's named by the
   adapter registry and by two modules that work with the files of specific
   CLIs: the shared memory (`memory-bridge.ts`, which knows Claude Code's slug
   and each CLI's instructions file) and the one-off importer for the
   Antigravity IDE (`vault/importers/`). The generic server —terminals, hub,
   index, socket— talks to the adapter interface and doesn't know which CLI
   it's dealing with (`ARCHITECTURE.md`, sections 1.3 and 3.4).

Any change that touches these points is reviewed against those four criteria
before anything else.

---

## Style

- **English** for identifiers, file names, issues, pull requests and the
  documentation. Existing code comments are in **Spanish**; new ones can be in
  either, as long as they're consistent within a file.
- **Every new UI text goes through `t()`** and into every locale file in
  `packages/web/src/i18n/locales/` ([below](#adding-a-language)).
- **No `any` in the protocol types.** Whatever comes in over the network is
  `unknown` until a parser narrows it (`packages/shared/src/validation.ts`).
- Comments explain **why**, not what. If a comment can be inferred by reading
  the line below it, it's redundant. If it documents a pitfall, it's worth its
  weight in gold.
- **No unnecessary dependencies.** Each new package is justified in one line in
  the pull request. Today the full list is: express, ws, node-pty and chokidar
  on the server; react, xterm and highlight.js in the interface.
- Small commits with descriptive messages. One branch per topic.

---

## Before opening a pull request

```bash
pnpm typecheck   # all three packages
pnpm check       # checks for the JSONL follower, the git parsing and the path guard
pnpm build       # the interface must build for production
```

`pnpm check` isn't a formality. It covers what breaks silently:

- JSONL lines split across two reads and UTF-8 characters cut in half;
- the rename record of `git status --porcelain=v2`, which carries an extra
  field and throws the whole parser out of sync if it isn't consumed;
- the path guard, which is the only thing that stops a path from the client
  from reading outside the tab's directory.

If you touch any of those three areas, add the case to the corresponding check.

---

## Testing by hand

Some things no automated check covers, because they need a real CLI
responding:

- that new messages show up in the conversation panel while the CLI writes;
- that `Ctrl+V` and `Alt+V` still reach the CLI untouched (image pasting breaks
  if anything intercepts those keys);
- that reloading the browser keeps the processes and repaints the screen;
- that closing a tab really ends the process, without leaving orphans.

## Demo data and screenshots

`pnpm demo` starts the app with made-up projects and conversations, without
touching your history or your configuration: a fake home with made-up histories
for all four CLIs, the four simulated CLIs first in the `PATH` —the demo won't
start if it finds a real one— and, on Windows, a `W:` drive mounted with
`subst` so no path contains your user name. It's useful for working on the
interface with stable data and for showing it without exposing anything of your
own.

`pnpm demo:shots` (after `pnpm build`) takes the README screenshots with that
same environment and the Chrome you have installed. **The repo's screenshots
come from there and nowhere else**: they're public, and a screenshot of your
real installation shows the names of your projects. If you change the
interface, regenerate them with that command instead of replacing them by hand.

## Adding a language

The interface texts live in `packages/web/src/i18n/locales/`, one flat JSON file
per language; `en.json` is the reference.

1. Copy `packages/web/src/i18n/locales/en.json` to `<lang>.json`, where `<lang>`
   is the language's BCP 47 code (`it`, `pt-BR`), and translate every value.
   Keep the keys, the `{{placeholders}}` and tags like `<code>` untouched.
   Plural keys end in `_one`, `_few`, `_many` and `_other`: include the forms
   your language uses, and only those (Russian needs four; Chinese, Japanese
   and Korean, just `_other`). Keys stay sorted, in `JSON.stringify(…, null, 2)`
   format.
2. Add the code to `LOCALES`, `LOCALE_NAMES` (the name in its own language),
   `LOCALE_BADGES` (the header button), `DEFAULT_FORMAT_TAGS` (the region for
   dates and numbers) and `LOADERS` in `packages/web/src/i18n/index.ts`, and
   teach `matchLocale` in `i18n/detect.ts` any regional variant it should
   accept. A plain code like `it` already matches `it-CH`.
3. Run `pnpm check`: `check-i18n.mjs` lists missing keys, wrong placeholders and
   missing plural forms.
4. Look at it: `pnpm demo:shots --dev --lang <lang>` takes the README
   screenshots with the interface in your language and leaves them in the
   system's temp folder (`agent-workbench-shots/<lang>/`). Check that no label
   is cut off.

Missing texts fall back to English at runtime, but `pnpm check` doesn't pass
until the file has every key.

## Publishing a release

What gets published to npm is `dist-npm/`, generated by `pnpm build:npm` — not
the repository. It takes the version from the root `package.json`, so start
there:

```bash
npm version patch --no-git-tag-version   # or minor / major, at the root
# add the version to CHANGELOG.md, commit, and then:
git tag v<version> && git push origin main v<version>
```

The tag starts `.github/workflows/publish.yml`: it checks that the tag matches
`package.json`, runs the checks, builds `dist-npm/` and publishes it to npm with
provenance (trusted publishing over OIDC: there's no npm token anywhere), then
creates the GitHub release.

To review by hand what would travel:

```bash
pnpm build:npm
cd dist-npm && npm pack --dry-run        # review the file list
```

npm **doesn't let you republish a version that's already published**, not even
an identical one: if something went wrong, you fix it and publish the next one.
That's why it's worth checking `npm pack --dry-run` first, and testing the
`.tgz` by installing it in an empty folder:

```bash
cd dist-npm && npm pack
mkdir /tmp/test && cd /tmp/test && npm init -y
npm install /path/to/agent-workbench-<version>.tgz
./node_modules/.bin/agent-workbench
```

---

## What fits and what doesn't

**Fits:** cross-platform compatibility fixes, history-format cases that change
between versions of a CLI, accessibility, performance with large repositories or
histories. A new CLI too, behind its own adapter (`ARCHITECTURE.md`, section 3.4),
with its reads declared in section 4 and a writer for its format in the demo.

**Doesn't fit:** git operations that write (commit, stage, push) from the
interface —there's an agent editing files, and the terminal is where the command
is visible before it runs—, any form of authentication inside the app, and
configuration options that a good default can avoid. The app has to be
understandable without a manual: the user's mental effort goes into their
project, not into our tool.
