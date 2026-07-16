# Claude Usage Dashboard — API Reference

HTTP API served by [`src/server.js`](../src/server.js) for polling Claude
Code plan/usage data programmatically. Default base URL:
`http://localhost:8080` (port configurable via `PORT`; see
[README.md](../README.md#environment-variables)).

No authentication/access control is built in — put this behind a trusted
network boundary (localhost, private LAN, or your own reverse proxy/VPN).

All responses are `application/json` unless noted otherwise.

## `GET /api/usage`

The main integration point. Returns the last cached scrape of Claude Code's
`/usage` panel. Does **not** trigger a live scrape — it's instant, served
from a background-refreshed cache (default every 5 minutes, configurable via
`USAGE_REFRESH_INTERVAL_MS`).

**Status codes**

| Status | Meaning |
|--------|---------|
| `200` | Cached usage data (see body shape below) |
| `503` | Not authenticated yet — no credentials stored. Body: `{ "error": "not authenticated" }` |

**200 response body**

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

| Field | Type | Notes |
|-------|------|-------|
| `bars` | array | One entry per progress bar (session window, weekly all-models, per-model weekly). `resetsText` is the panel's own verbatim relative-time string, `null` if absent. |
| `session.totalCostUsd` | number \| null | `null` if unparsable |
| `session.apiDuration` / `session.wallDuration` | string | As shown in the panel, e.g. `"1s"`, `"2m 3s"` |
| `characteristics` | array | "What's contributing to your limits usage?" entries. Often empty. |
| `raw` | string | Full extracted panel text, always populated regardless of parse success |
| `lastUpdatedAt` | string (ISO 8601) \| null | Timestamp of last *successful* background scrape; `null` before the first one completes |
| `stale` | boolean | `true` if the most recent background refresh failed — fields above are from the last good scrape |
| `error` | string \| null | Message from the most recent refresh failure, or `null` |

**Example**

```sh
curl http://localhost:8080/api/usage
```

## `POST /api/refresh`

Forces an immediate re-scrape instead of waiting for the next background
interval. Returns the same body shape as `GET /api/usage` (post-refresh).
Same `503`-if-not-authenticated behavior.

```sh
curl -X POST http://localhost:8080/api/refresh
```

## `GET /api/login/state`

Reports authentication/login progress. Poll this while driving the login
flow below.

```jsonc
{
  "authenticated": false,
  "status": "awaiting-code",
  "loginUrl": "https://claude.ai/oauth/...",
  "error": null
}
```

`status` is one of: `idle`, `awaiting-code`, `submitting`, `success`,
`error`.

## `POST /api/login/start`

Begins the web-driven login flow (spawns a `claude` pty session and starts
`/login`). No request body. Response is the same shape as
`GET /api/login/state` once the authorization URL is ready (or an error).

```sh
curl -X POST http://localhost:8080/api/login/start
```

## `POST /api/login/code`

Submits the login code pasted back from the browser OAuth step.

**Request body**

```json
{ "code": "the-pasted-code" }
```

**Status codes**

| Status | Meaning |
|--------|---------|
| `200` | See body — `{ status: "success" }`, or `{ status: "awaiting-code", error }` to retry, or `{ status: "error", error }` |
| `400` | Missing `code` in body |

```sh
curl -X POST http://localhost:8080/api/login/code \
  -H 'Content-Type: application/json' \
  -d '{"code":"XXXX-XXXX"}'
```

## `GET /`

Returns the server-rendered HTML dashboard (if authenticated) or the login
page (if not). Not JSON — for browser use, not programmatic polling.

## Typical integration flow

1. `GET /api/login/state` → if `authenticated: false`, drive the login flow
   (`POST /api/login/start`, then `POST /api/login/code`) once, interactively.
2. Once authenticated, just poll `GET /api/usage` on whatever cadence you
   need — it's free (cached), no need to call `/api/refresh` unless you need
   data newer than the last background scrape.
3. Check `stale`/`error` on each response — a `stale: true` result still has
   usable (if outdated) `bars`/`session`/`characteristics` data from the last
   good scrape, rather than nothing.
