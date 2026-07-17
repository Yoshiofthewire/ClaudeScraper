# Claude Usage Dashboard

Scrapes Claude Code's interactive `/usage` panel and serves it as a web
dashboard and a JSON endpoint, from a single always-on Docker container.
There's no scriptable API for this data (`claude auth status` only reports
login state, and `claude -p --output-format json` reports the cost of the
single query just run, not account-wide plan usage) — this drives the real
interactive TUI in a pty and reads the rendered screen, on a background
timer, and caches the result.

## Quick start

```sh
docker compose up --build
```

Then visit **http://localhost:8080**.

- **First run (no stored credentials):** the page walks you through Claude
  Code's login — click "Start login", visit the printed URL in any browser,
  and paste the code back into the page. No `docker exec` or `-it` needed.
- **After login:** credentials persist in the `claude-usage-data` named
  volume, so restarting the container goes straight to the dashboard.
- **Alternative to the web login:** copy [`.env.example`](.env.example) to
  `.env` and set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` run
  elsewhere) or `ANTHROPIC_API_KEY` — either skips the web login flow
  entirely.

### Or with plain `docker run`

```sh
docker build -t claude-usage .
docker volume create claude-usage-data
docker run -d --name claude-usage -p 8080:8080 -v claude-usage-data:/data claude-usage
```

## Web dashboard & JSON endpoint

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Dashboard (authenticated) or login flow (not yet authenticated) |
| `/settings` | GET | Settings page (authenticated only; redirects to `/` otherwise) |
| `/api/usage` | GET | Cached `UsageInfo` as JSON (see [Data model](#data-model)) plus `lastUpdatedAt`/`stale`/`error`/`plan`. Returns `503` before authentication. This is the endpoint other tools/runners should poll. |
| `/api/refresh` | POST | Force an immediate re-scrape; returns the same shape as `/api/usage` |
| `/api/login/state` | GET | `{ authenticated, status, loginUrl?, error? }` |
| `/api/login/start` | POST | Begin the web-driven login flow |
| `/api/login/code` | POST | `{ "code": "..." }` — submit the pasted-back login code |
| `/api/settings` | GET | Current settings: `{ plan, helloPromptOnReset }` |
| `/api/settings` | POST | `{ plan?, helloPromptOnReset? }` — update settings; `400` on an invalid `plan` |

Usage data refreshes in the background every `USAGE_REFRESH_INTERVAL_MS`
(default 5 minutes); `/api/usage` and the dashboard always serve the cached
result instantly rather than triggering a scrape per request. Use the
dashboard's "Refresh now" button, or `POST /api/refresh`, to force an
immediate update.

If a background refresh fails (timeout, unrecognized panel), the cache
keeps the last good data and marks it `stale: true` with an `error` field,
rather than discarding known-good data.

## Settings

Visit **`/settings`** (linked from the dashboard header) once authenticated to
manage:

- **Plan** — which Claude subscription tier the account is on (`Pro`, `Max`,
  or `Max x20`). Claude Code doesn't expose this itself, so it's recorded
  here and merged into `/api/usage`'s response as a `plan` field, for
  consumers that want it as context alongside the usage bars.
- **Hello prompt on reset** — a toggle to automatically send a "Hello"
  prompt through Claude Code whenever a usage bar's window resets (detected
  by a drop in that bar's % used between background scrapes). Off by
  default; enable it on the settings page.
- **Pair a mobile app** — a placeholder for a future mobile pairing QR code.

Settings persist in `settings.json` in the same `CLAUDE_CONFIG_DIR`-mounted
volume as credentials, so they survive container restarts.

## One-shot CLI (still available)

The underlying scraper is also usable directly, without the server, for
local scripting:

```sh
docker compose run --rm app node bin/claude-usage.js --json
```

or, outside Docker (with `CLAUDE_CONFIG_DIR` pointed at a directory holding
real Claude Code credentials):

```sh
npm install
CLAUDE_CONFIG_DIR=~/.claude node bin/claude-usage.js
```

| Flag | Description |
|------|-------------|
| *(none)* | Human-readable table on stdout (default) |
| `--json` | Structured JSON on stdout (see [Data model](#data-model)) |
| `--raw` | The raw extracted panel text verbatim |
| `--timeout <ms>` | Override the scrape's overall timeout (default `20000`) |
| `-h`, `--help` | Show usage help and exit `0` |
| `-v`, `--version` | Show the package version and exit `0` |

### Exit codes (CLI only)

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Unexpected/internal error, or `CLAUDE_CONFIG_DIR` unset |
| `3` | Scrape timed out |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Under `docker compose up` (the Quick start workflow), the *host* port to publish — the container always listens on 8080 internally, regardless of this value. When running the server entrypoint directly (`npm start`, or `docker run` without compose), `PORT` sets the actual internal listen port. |
| `USAGE_REFRESH_INTERVAL_MS` | `300000` | How often the background scrape refreshes cached usage data |
| `CLAUDE_CONFIG_DIR` | `/data` (set in the image) | Where Claude Code's config/credentials live. Point this at your mounted volume. |
| `CLAUDE_USAGE_WORKDIR` | `/home/node/workspace` (set in the image) | Fixed working directory `claude` is launched from — used for both the scrape and the login flow, and as the key `preseed.js` writes trust/onboarding flags under. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Long-lived token from `claude setup-token`. Alternative to completing the web login flow. |
| `ANTHROPIC_API_KEY` | — | Direct API-key auth, alternative to a Claude subscription login. Note: usage-panel content differs for API-key accounts (cost estimates rather than plan-percentage bars). |

No built-in access control — the web UI (including the login code exchange)
is assumed to sit behind trusted network access (localhost, private LAN, or
your own reverse proxy/VPN).

## Data model

`/api/usage` (and `--json`) returns a `UsageInfo` object, plus cache
metadata:

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
  "raw": "<full extracted panel text, always populated>",
  "lastUpdatedAt": "2026-07-16T12:00:00.000Z",
  "stale": false,
  "error": null
}
```

- **`bars`** — one entry per progress bar shown (session window, weekly
  all-models, and any per-model weekly bars). `resetsText` is the panel's
  own verbatim relative-time string; `null` when the panel doesn't show a
  reset line for that bar.
- **`session`** — the "Session" block's local cost/duration estimate for
  the scrape's Claude Code invocation. `totalCostUsd` is `null` if
  unparsable.
- **`characteristics`** — the "What's contributing to your limits usage?"
  entries. Often empty — the scan can still be in progress when the scrape
  completes, which is not treated as an error.
- **`raw`** — always populated, regardless of how much else parsed
  successfully.
- **`lastUpdatedAt`** — ISO timestamp of the last successful background
  scrape, or `null` before the first one completes.
- **`stale`** — `true` if the most recent background refresh failed (the
  fields above are from the last successful scrape).
- **`error`** — the most recent refresh failure's message, or `null`.

## Module API

Not published as an npm package — documented for development.

### `src/usageParser.js`

```ts
parseUsage(text: string): UsageInfo
```
Pure function. Parses the plain-text lines of a rendered `/usage` panel
into the `UsageInfo` shape above. Tolerant by design: unrecognized lines
are ignored.

### `src/usageDriver.js`

```ts
scrapeUsage(session: PtySessionLike, options?: {
  readyQuietMs?: number, readyTimeoutMs?: number,
  stableQuietMs?: number, stableTimeoutMs?: number,
}): Promise<UsageInfo>
```
Drives a pty session through the full `/usage` flow.

### `src/loginDriver.js`

```ts
startLogin(session: PtySessionLike, options?: {
  readyQuietMs?: number, readyTimeoutMs?: number,
  urlQuietMs?: number, urlTimeoutMs?: number,
}): Promise<{ term: TerminalBuffer, loginUrl: string }>

submitLoginCode(session: PtySessionLike, term: TerminalBuffer, code: string, options?: {
  resultQuietMs?: number, resultTimeoutMs?: number,
}): Promise<{ success: true } | { success: false, message: string }>
```
Drives a pty session through `/login`: extracts the authorization URL, then
submits the pasted-back code and reports success/failure.

### `src/usageCache.js`

```ts
createUsageCache(options: { scrapeUsage: () => Promise<UsageInfo>, intervalMs: number }): {
  start(): void, stop(): void, refresh(): Promise<void>,
  getState(): { data: UsageInfo | null, lastUpdatedAt: Date | null, stale: boolean, error: string | null },
}
```
Background-refreshed cache. Keeps the last good `data` on a failed refresh,
marking `stale: true` instead of discarding it.

### `src/credentials.js`

```ts
hasCredentials(configDir: string): boolean
```
True if `.credentials.json` exists in `configDir`, or
`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` is set.

### `src/settings.js`

```ts
loadSettings(configDir: string): { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }
saveSettings(configDir: string, patch: { plan?: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset?: boolean }): same shape, throws if `patch.plan` isn't a valid plan value
```
Reads/writes `settings.json` in `configDir`, the same directory
`.credentials.json` lives in. A missing or corrupt file reads back as
defaults (`{ plan: null, helloPromptOnReset: false }`).

### `src/htmlView.js`

```ts
renderDashboard(state: { data: UsageInfo | null, lastUpdatedAt: Date | null, stale: boolean, error: string | null }): string
renderLoginPage(loginState: { status: string, loginUrl?: string, error?: string }): string
renderSettings(settings: { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }): string
```
Pure server-rendered HTML, no build step.

### `src/server.js`

```ts
createServer(options: {
  configDir: string, workDir: string, intervalMs?: number,
  spawnSession?: () => PtySessionLike,
  scrapeOptions?: object, loginOptions?: object,
}): http.Server
```
Wires the cache, login flow, and views together behind the routes listed
above. Returns an unstarted server — call `.listen(port)`.

### `src/index.js`

```ts
parseCliArgs(argv: string[]): {
  json: boolean, raw: boolean, timeoutMs: number, help: boolean, version: boolean,
}

run(options?: {
  timeoutMs: number, json?: boolean, raw?: boolean,
  workDir?: string, configDir?: string,
}): Promise<0 | 3>
```
Orchestrates the [one-shot CLI](#one-shot-cli-still-available)
(`bin/claude-usage.js`): `parseCliArgs` turns raw argv into parsed options,
and `run` preseeds config, drives a pty session through the `/usage` scrape,
writes human/JSON/raw output to stdout, and resolves to an exit code (`0`
on success, `3` on scrape timeout or other error). `workDir`/`configDir`
default to `CLAUDE_USAGE_WORKDIR`/`CLAUDE_CONFIG_DIR`.

### `src/ptySession.js`, `src/terminalBuffer.js`, `src/preseed.js`, `src/format.js`, `src/pollUntil.js`

Unchanged from before, except `pollUntil` (the terminal-settle polling
helper) moved out of `usageDriver.js` into its own module so
`loginDriver.js` can share it.

## Development

```sh
npm install
npm test
npm start   # runs the web server locally; needs CLAUDE_CONFIG_DIR set
```

`test/fixtures/usage-subscription.txt`, `test/fixtures/login-url-screen.txt`,
`test/fixtures/login-success-screen.txt`, `test/fixtures/login-method-menu-screen.txt`,
`test/fixtures/login-invalid-code-screen.txt`, and `test/fixtures/login-url-wrapped-screen.txt`
are real captured screens (hand-captured, PII redacted) used to test the parsers/drivers without
needing a live login. If a future Claude Code release changes any of these
screens' rendered text, capture a fresh one the same way and update the
relevant fixture/regex.

Bumping the pinned `@anthropic-ai/claude-code` version in the Dockerfile:
update the version in both the `npm install -g` line and re-verify the
fixtures/parsers still match the new release's rendered output. Also re-run a
full manual login walkthrough (start the container fresh and complete a real
browser OAuth round-trip) after a version bump, since the fixtures are static
snapshots that can't catch interaction-protocol changes (e.g. new intermediate
screens, different paste-handling requirements) the way a live re-run would.
