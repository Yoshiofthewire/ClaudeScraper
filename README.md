# Claude Usage Scraper

Scrapes Claude Code's interactive `/usage` panel and prints current usage as
a one-shot CLI. There's no scriptable API for this data (`claude auth status`
only reports login state, and `claude -p --output-format json` reports the
cost of the single query just run, not account-wide plan usage) — this drives
the real interactive TUI in a pty and reads the rendered screen.

> **No network API.** This is a CLI and Docker image, not a server — there
> are no HTTP endpoints. "API" below means the CLI's flags/exit codes, the
> container's env vars and volume, and the internal JS module functions.

## Quick start

```sh
docker build -t claude-usage .
docker volume create claude-usage-data

# One-time interactive login. Drops you into the real Claude Code TUI —
# once it's ready, type /login and follow the prompts. It's a manual
# paste-URL flow (visit the printed URL in any browser, paste the code
# back) — no port publishing needed.
docker run --rm -it -v claude-usage-data:/data claude-usage login

# Fallback if you'd rather use a portable long-lived token instead:
docker run --rm -it -v claude-usage-data:/data claude-usage login --token

# Subsequent one-shot scrapes
docker run --rm -v claude-usage-data:/data claude-usage
docker run --rm -v claude-usage-data:/data claude-usage --json | jq .
docker run --rm -v claude-usage-data:/data claude-usage --raw
```

## CLI reference

```
claude-usage [options]
```

| Flag | Description |
|------|-------------|
| *(none)* | Human-readable table on stdout (default) |
| `--json` | Structured JSON on stdout (see [Data model](#data-model)); all logging goes to stderr so `\| jq` is always safe |
| `--raw` | The raw extracted panel text verbatim — escape hatch if a future Claude Code UI change desyncs the parser |
| `--timeout <ms>` | Override the scrape's overall timeout (default `20000`) |
| `-h`, `--help` | Show usage help and exit `0` |
| `-v`, `--version` | Show the package version and exit `0` |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Unexpected/internal error, or `CLAUDE_CONFIG_DIR` unset |
| `2` | Not logged in — run `... login` |
| `3` | Scrape timed out (panel never rendered — rate-limited, network issue, or unrecognized UI state; try `--raw` to see what was captured) |

### Docker "commands"

The image's entrypoint (`docker/entrypoint.sh`) branches on its first argument:

| Invocation | Behavior |
|------------|----------|
| `docker run ... claude-usage` | Default: run the one-shot scrape (`bin/claude-usage.js`, forwarding any flags above) |
| `docker run -it ... claude-usage login` | No credentials yet: exec the real `claude` TUI in `$CLAUDE_USAGE_WORKDIR` so you can run `/login` yourself |
| `docker run -it ... claude-usage login --token` | Same, but runs `claude setup-token` instead — mints a portable long-lived token (`CLAUDE_CODE_OAUTH_TOKEN`) rather than a browser-session credential |

If credentials already exist (`.credentials.json` in the volume, or
`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` set), any first argument other
than triggering the scrape is ignored — the container always goes straight
to scraping once authenticated.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_CONFIG_DIR` | `/data` (set in the image) | Where Claude Code's config/credentials live. Point this at your mounted volume; `bin/claude-usage.js` refuses to run (exit `1`) if it's unset. |
| `CLAUDE_USAGE_WORKDIR` | `/home/node/workspace` (set in the image) | Fixed working directory `claude` is launched from — used both for the scrape and for the `login` TUI, and as the key `preseed.js` writes trust/onboarding flags under. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Long-lived token from `claude setup-token` (or `login --token`). Alternative to a `.credentials.json` session. |
| `ANTHROPIC_API_KEY` | — | Direct API-key auth, alternative to a Claude subscription login. Note: usage-panel content differs for API-key accounts (cost estimates rather than plan-percentage bars). |

No ports are exposed and none are needed — login is a manual paste-URL
OAuth flow (see Quick start), not a local callback server.

## Data model

`--json` (and the return value of `run()`/`scrapeUsage()` internally) is a
`UsageInfo` object:

```jsonc
{
  "bars": [
    { "label": "Current session", "pctUsed": 36, "resetsText": "Resets 12:29pm (America/New_York)" },
    { "label": "Current week (all models)", "pctUsed": 6, "resetsText": "Resets Jul 21, 8:59am (America/New_York)" },
    { "label": "Current week (Fable)", "pctUsed": 0, "resetsText": null }
  ],
  "session": {
    "totalCostUsd": 0,
    "apiDuration": "0s",
    "wallDuration": "1s"
  },
  "characteristics": [
    {
      "pct": 84,
      "summary": "your usage came from subagent-heavy sessions",
      "detail": "Each subagent runs its own requests. Be deliberate about spawning them — and consider configuring a cheaper model for simpler subagents."
    }
  ],
  "raw": "<full extracted panel text, always populated>"
}
```

- **`bars`** — one entry per progress bar shown (session window, weekly
  all-models, and any per-model weekly bars, e.g. per promotional or
  secondary model). `resetsText` is the panel's own verbatim relative-time
  string (e.g. `"Resets 12:29pm (America/New_York)"`); `null` when the panel
  doesn't show a reset line for that bar (seen for `0%`-used per-model bars).
- **`session`** — the "Session" block's local cost/duration estimate for
  this Claude Code invocation. `totalCostUsd` is `null` if unparsable.
- **`characteristics`** — the "What's contributing to your limits usage?"
  entries, when the panel's async local-session scan finished rendering
  before the scrape's stabilization check fired. Often empty — the scan can
  still say "Scanning local sessions…" when the scrape completes, which is
  not treated as an error.
- **`raw`** — always populated, regardless of how much else parsed
  successfully. The parser never throws on unrecognized input; it just
  leaves the corresponding array/field empty.

## Module API

Not published as an npm package — these are documented for development and
for embedding directly (`import { ... } from './src/...js'`) in another Node
tool. All modules are ES modules (`"type": "module"`).

### `src/usageParser.js`

```ts
parseUsage(text: string): UsageInfo
```
Pure function. Parses the plain-text lines of a rendered `/usage` panel (as
produced by `TerminalBuffer#getText()`) into the `UsageInfo` shape described
above. Tolerant by design: unrecognized lines are ignored, and unparsable
input still returns a valid object with empty arrays and a populated `raw`
field rather than throwing.

### `src/usageDriver.js`

```ts
scrapeUsage(session: PtySessionLike, options?: {
  readyQuietMs?: number,   // default 800  — quiet time before considering the initial prompt "ready"
  readyTimeoutMs?: number, // default 15000 — bound on waiting for readiness
  stableQuietMs?: number,  // default 500  — quiet time before considering the /usage panel "settled"
  stableTimeoutMs?: number,// default 20000 — bound on waiting for the panel to render
}): Promise<UsageInfo>
```
Drives a pty session through the full `/usage` flow: waits for the initial
prompt to go quiet, writes `/usage\r`, waits for the rendered screen to both
go quiet *and* match a "this looks like the usage panel" marker (`/%\s*used/i`),
then parses the final screen text. Rejects with an `Error` if either wait
exceeds its timeout. `session` only needs `.onData(callback)` and
`.write(data)` — satisfied by `PtySession` below, or any test double (see
`test/usageDriver.test.js` for the pattern used to test this without a real
`claude` process).

### `src/ptySession.js`

```ts
class PtySession {
  constructor(command: string, args?: string[], options?: {
    cols?: number, rows?: number, cwd?: string, env?: NodeJS.ProcessEnv,
  })
  readonly pid: number
  onData(callback: (chunk: string) => void): void
  write(data: string): void
  close(options?: { exitCommand?: string, timeoutMs?: number }): Promise<void>
}
```
Thin `node-pty` wrapper with guaranteed cleanup. `close()` optionally writes
an exit command first, then waits up to half of `timeoutMs` (default `2000`)
for the child to exit naturally, escalating to `SIGTERM` and then `SIGKILL`
if it doesn't — so a crashed scrape never leaves an orphaned `claude`
process behind.

### `src/terminalBuffer.js`

```ts
class TerminalBuffer {
  constructor(options?: { cols?: number, rows?: number })
  write(data: string): Promise<void>
  msSinceLastWrite(): number
  waitQuiet(quietMs: number, timeoutMs: number): Promise<void>
  getText(): string
}
```
Wraps `@xterm/headless` to maintain a real virtual screen buffer — necessary
because Claude Code's Ink-based TUI does cursor-relative partial redraws, so
naively regexing the raw ANSI byte stream is unreliable. `write()` is
asynchronous (xterm's internal parser is), and returns a promise that
resolves once that chunk has been fully applied to the buffer.
`waitQuiet(quietMs, timeoutMs)` resolves once `quietMs` has elapsed since
the last `write()` call, or rejects once `timeoutMs` elapses first — this is
the building block `usageDriver.js` polls against.

### `src/preseed.js`

```ts
preseed(configDir: string, workDir: string): void
```
Idempotently merges onboarding/trust flags into
`$CLAUDE_CONFIG_DIR/.claude.json` (`hasCompletedOnboarding`, `autoUpdates:
false`, `bypassPermissionsModeAccepted: false`, plus a `projects[workDir]`
entry with `hasTrustDialogAccepted: true`) so the TUI skips the
theme-selection and trust dialogs when launched non-interactively for the
scrape. Preserves any unrelated existing keys in `.claude.json`. Never reads
or writes `.credentials.json`.

### `src/format.js`

```ts
formatHuman(usage: UsageInfo): string   // e.g. "Current session: 36% used (Resets 12:29pm (America/New_York))"
formatJson(usage: UsageInfo): string    // JSON.stringify(usage, null, 2)
```

### `src/index.js`

```ts
parseCliArgs(argv: string[]): {
  json: boolean, raw: boolean, timeoutMs: number, help: boolean, version: boolean,
}

run(options?: {
  timeoutMs: number, json: boolean, raw: boolean,
  workDir?: string,   // default: $CLAUDE_USAGE_WORKDIR or process.cwd()
  configDir?: string, // default: $CLAUDE_CONFIG_DIR
}): Promise<number>   // resolves to an exit code: 0 success, 3 timeout/scrape error
```
`parseCliArgs` is a pure argv parser (thin wrapper over `node:util`'s
`parseArgs`). `run()` is the full orchestration: `preseed()` → spawn a
`PtySession` for `claude` → `scrapeUsage()` → format per `json`/`raw` →
print to stdout → `session.close({ exitCommand: '/exit\r' })` in a
`finally`, guaranteeing cleanup even on error. It assumes credentials
already exist — the "not logged in" case (exit `2`) is handled upstream by
`docker/entrypoint.sh` before `run()` is ever invoked.

## Development

```sh
npm install
npm test
```

`test/fixtures/usage-subscription.txt` is a real captured `/usage` screen
(hand-captured, PII redacted) used to test `usageParser.js` without needing
a live login. If Claude Code changes the panel's rendered text in a future
release, capture a fresh one the same way and update the parser/fixture.

Bumping the pinned `@anthropic-ai/claude-code` version in the Dockerfile:
update the version in both the `npm install -g` line and re-verify the
fixture/parser still match the new release's rendered output.
