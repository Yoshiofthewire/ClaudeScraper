# Settings panel

Date: 2026-07-16

## Problem

Once authenticated, the dashboard (`GET /`) shows usage data but has no
place to record account/preference metadata that Claude Code itself doesn't
expose: which subscription plan the account is on, whether to auto-send a
prompt after usage windows reset, and (eventually) how to pair a mobile
client. We want a settings panel, reachable only after auth, covering:

1. A toggle for the account's plan tier (Pro / Max / Max x20), exposed
   through the JSON API.
2. A persisted on/off preference for sending a "Hello" prompt after every
   usage-window reset.
3. A placeholder for a future mobile-app pairing QR code.

## Non-goals

- No automatic reset-detection or prompt-sending logic. Item 2 is a stored
  preference only in this pass — the trigger that reads it and actually
  drives a pty session to send a prompt on reset is future work.
- No real QR code generation or mobile pairing protocol. Item 3 is a static
  visual placeholder.
- No new web framework or client-side build step — same server-rendered
  HTML + inline vanilla JS as the rest of the app.
- No access control beyond the existing "authenticated or not" gate — same
  trust model as the rest of the app (README's "no built-in access
  control" note applies here too).

## Architecture

**New module `src/settings.js`** (mirrors `credentials.js`'s
filesystem-read style):

```ts
loadSettings(configDir: string): { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }
saveSettings(configDir: string, patch: { plan?: ..., helloPromptOnReset?: boolean }): same shape, throws on invalid plan value
```

Reads/writes `settings.json` in `configDir` — the same mounted volume
`.credentials.json` already lives in, so settings survive container
restarts the same way credentials do. A missing or corrupt file is treated
as defaults (`{ plan: null, helloPromptOnReset: false }`) rather than an
error, consistent with the codebase's general tolerance for
missing/malformed on-disk state.

**Routes (`src/server.js`)**

```
GET  /settings        settings page HTML (redirects to / if not authenticated)
GET  /api/settings     current settings as JSON
POST /api/settings     { plan?, helloPromptOnReset? } -> validates, persists, returns full settings
```

`GET /api/usage` and `POST /api/refresh` gain a `plan` field in their
response body, read from settings (not from the scrape itself) — it's
account metadata layered onto the usage payload, not something the
`/usage` panel reports.

**View (`src/htmlView.js`)**

`renderSettings(settings)` — a card in the existing visual style with three
sections:

1. **Plan** — radio buttons for Pro / Max / Max x20, saved via
   `POST /api/settings` on change.
2. **Hello prompt on reset** — a checkbox, saved the same way, with a small
   muted note clarifying it only stores the preference for now (no
   automatic sending yet — see Non-goals).
3. **Pair a mobile app** — a static dashed-border placeholder box with
   "QR code coming soon" text. No JS, no image.

`renderDashboard` gets a "Settings" link in its header row next to
"Refresh now". The settings page gets a "Back to dashboard" link.

## Data flow

- Loading `/settings`: `GET` handler checks `authenticated` (same flag
  `server.js` already tracks), reads settings via `loadSettings`, renders.
- Saving a setting: client-side JS fires `POST /api/settings` with just the
  changed field(s) on radio/checkbox change (no explicit "Save" button,
  consistent with how little interaction the rest of the app asks for),
  then re-renders from the response.
- `plan` reaching `/api/usage`: `server.js`'s existing handler spreads
  `state.data` into the response body; it now also spreads
  `{ plan: loadSettings(configDir).plan }` in.

## Error handling

- `POST /api/settings` with a `plan` outside
  `null | "Pro" | "Max" | "Max x20"` returns `400` with
  `{ error: "invalid plan" }`, settings file untouched.
- `GET /settings` while unauthenticated redirects (`302`) to `/`, same as
  visiting the dashboard unauthenticated shows the login page instead —
  no separate "please log in" error state needed.
- A corrupt/unreadable `settings.json` is treated as defaults on read
  (logged, not thrown) so a hand-edited or partially-written file can't
  take down the dashboard or the API.

## Testing

- `test/settings.test.js` — load defaults when file absent, round-trip
  save/load, corrupt-file falls back to defaults, invalid `plan` value
  rejected.
- `test/server.test.js` — `GET/POST /api/settings` status codes and
  bodies, `GET /settings` auth gating, `plan` field present in
  `/api/usage` and `/api/refresh` responses.
- `test/htmlView.test.js` — `renderSettings` includes the three sections
  and reflects the passed-in settings (selected plan, checked toggle).

## Docs

- `README.md`: add `/settings`, `/api/settings` to the routes table; add
  `src/settings.js` to the Module API section.
- `docs/API.md`: document `GET/POST /api/settings` and the new `plan`
  field on `/api/usage`'s response body.
