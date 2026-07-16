# Single-container web dashboard for Claude usage

Date: 2026-07-16

## Problem

The project currently ships as a one-shot CLI wrapped in three
`docker-compose` services (`login`, `login-token`, `scrape`) that all build
the same image and each run to completion for a single invocation. There is
no persistent process, no web interface, and no way for another program to
pull usage data except by shelling out to `docker compose run --rm scrape
--json`.

We want one long-running container that:

1. On first startup (no stored credentials), walks the user through Claude
   Code's login via its own web UI — no separate `docker run -it` step.
2. Once authenticated, serves a nice human-readable dashboard of current
   usage metrics.
3. Serves that same data as JSON, for other tools/runners to poll.

## Non-goals

- No built-in authentication/access control on the web UI (operator is
  responsible for network exposure — localhost, private LAN, or their own
  reverse proxy/VPN).
- No support for driving the `claude setup-token` (long-lived token) flow
  through the web UI. Setting `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
  as an env var remains the supported way to skip interactive login
  entirely — that path already works today and needs no new code.
- No new web framework dependency. Node's built-in `http` module only.

## Architecture

One container, one process (`src/server.js`), started unconditionally by
`docker/entrypoint.sh`. It replaces the three `docker-compose` services with
a single `app` service.

```
entrypoint.sh: preseed() then exec `node bin/claude-usage-server.js` — always, no branching

server.js on startup:
  - checks for credentials (.credentials.json in CLAUDE_CONFIG_DIR,
    or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY env vars)
  - authenticated  -> start usageCache (immediate scrape + background
                       interval, default every 5 minutes)
  - unauthenticated -> serve the login flow until credentials appear,
                        then start usageCache

Routes:
  GET  /                  dashboard HTML (or login page HTML if unauthenticated)
  GET  /api/usage         cached UsageInfo as JSON (+ lastUpdatedAt, stale, error)
  POST /api/refresh       force an immediate re-scrape; returns fresh JSON
  GET  /api/login/state   poll: { authenticated, status, loginUrl?, error? }
  POST /api/login/start   begin the pty-driven /login flow
  POST /api/login/code    submit the pasted-back code
```

`usageCache.js` reuses the existing `usageDriver.scrapeUsage()` with a fresh
`PtySession` per cycle, exactly like `src/index.js`'s `run()` does for a
single invocation today — the scraping core (`usageParser.js`,
`usageDriver.js`, `ptySession.js`, `terminalBuffer.js`) is unchanged, just
invoked on a timer instead of once.

`docker/entrypoint.sh` shrinks to: preseed, then exec the server. The
existing "not logged in -> exit 2" CLI-only branch is removed; the server
owns that state now by serving the login page instead.

The existing one-shot CLI (`bin/claude-usage.js`) is left as-is — still
useful for local scripting/dev — but is no longer what the Docker image
runs by default.

## Login flow (new `src/loginDriver.js`)

Mirrors `usageDriver.js`'s shape but drives the `/login` screen instead of
`/usage`:

1. `POST /api/login/start` spawns a `PtySession` running `claude` (same
   preseeded workdir), writes `/login\r`, and waits for the terminal buffer
   to settle and contain a URL pattern. The extracted URL is returned; the
   pty session is held open in server memory in a single global "pending
   login" slot (single-user tool — one login attempt at a time).
2. `GET /api/login/state` returns `{status: "awaiting-code", loginUrl}` so
   the frontend can render the clickable link and a paste-code form.
3. `POST /api/login/code {code}` writes the code + Enter into the
   still-open pty, waits for the buffer to settle again, and checks for a
   success marker vs. an error/retry marker in the resulting text.
4. On success: waits for `.credentials.json` to actually appear in
   `CLAUDE_CONFIG_DIR` (in addition to the screen-text signal), closes the
   pty cleanly (`/exit\r` then the existing escalating close), flips server
   state to authenticated, and kicks off the first usage scrape + starts
   the background interval.
5. On failure: surfaces the screen's error text to the frontend. The user
   can retry by submitting another code (same open pty) or by calling
   `/api/login/start` again (closes the stale pty first, opens a new one).
6. An idle timeout (5 minutes) auto-closes an abandoned login pty so it
   doesn't leak.

**Implementation prerequisite:** unlike `usageParser.js`, which is built
against a real captured fixture (`test/fixtures/usage-subscription.txt`),
there is no existing fixture for the `/login` screen's URL/success/error
text. Before writing `loginDriver.js`'s parsing regexes, capture a real
`/login` screen transcript the same way (hand-captured, PII redacted) and
add it as `test/fixtures/login-*.txt`. Do not guess the regexes against
assumed text.

## HTML/API surface

- **Dashboard (`GET /`, authenticated)**: progress bars per `bars[]` entry
  (label, % used, reset text), the session cost/duration block, the "what's
  contributing to usage" characteristics list, a "last updated Xs ago"
  timestamp, and a manual "Refresh now" button (`POST /api/refresh`, then
  re-render). Server-rendered HTML with inline `<style>` and a small
  vanilla-JS snippet for the refresh button and periodic soft-refresh — no
  build step, no frontend framework. Real visual polish (spacing,
  typography, color-coded bars by usage %), not a bare table.
- **Login page (`GET /`, unauthenticated)**: "Start login" button when
  idle; once started, the clickable URL + paste-code form; inline error
  display; auto-redirect to the dashboard on success.
- **`GET /api/usage`**: `{ ...UsageInfo, lastUpdatedAt, stale }` (200) when
  authenticated; `{ error: "not authenticated" }` (503) when not. This is
  the machine-readable endpoint other runners poll.
- **Error handling**: a failed background scrape (timeout, unrecognized
  panel) keeps the last good cached data and marks it `stale: true` with an
  `error` field, rather than discarding known-good data. The dashboard
  shows a small warning banner when stale. No backoff logic — failures just
  retry on the next 5-minute tick.
- **New env vars**: `PORT` (default `8080`), `USAGE_REFRESH_INTERVAL_MS`
  (default `300000`). Existing `CLAUDE_CONFIG_DIR`, `CLAUDE_USAGE_WORKDIR`,
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` behave exactly as today.

## Docker changes

- `Dockerfile`: add `EXPOSE 8080`; otherwise unchanged (already installs
  `@anthropic-ai/claude-code` and copies `src`/`bin`).
- `docker-compose.yml`: single `app` service — `build: .`, mounts the
  `claude-usage-data` volume at `/data`, publishes `8080:8080`, passes
  through `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` from `.env`, no
  `command:` override. The `login` and `login-token` services are removed.
- `docker/entrypoint.sh`: preseed, then unconditionally exec the server
  entrypoint (`bin/claude-usage-server.js`).

## Testing

- `loginDriver.test.js` — mocked `PtySession` test double (same pattern as
  `usageDriver.test.js`), fed the newly captured real login fixture text.
- `usageCache.test.js` — inject a fake `scrapeUsage`, verify
  caching/staleness/interval behavior with fake timers; no real pty.
- `htmlView.test.js` — pure-function rendering tests: given a `UsageInfo`,
  assert key content appears; given each login state, assert the right
  form/error renders.
- `server.test.js` — start the real server on an ephemeral port in-process,
  hit routes with Node's built-in `fetch`, assert status codes/JSON
  shapes/redirects, using an injected fake cache/login-driver so no real
  `claude` process is needed.
- Manual verification: `docker compose up` against a fresh volume, full
  browser walkthrough of login -> dashboard -> refresh.
