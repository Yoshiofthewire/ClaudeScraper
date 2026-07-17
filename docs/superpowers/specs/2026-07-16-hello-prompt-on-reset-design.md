# Automatic "Hello" prompt on usage-window reset

Date: 2026-07-16

## Problem

The settings panel (see [2026-07-16-settings-panel-design.md](2026-07-16-settings-panel-design.md))
added a `helloPromptOnReset` toggle that only stores a preference — nothing
actually detects a usage-window reset or sends anything. This spec wires up
the real behavior: when a usage bar's window resets and the toggle is on,
automatically drive a pty session to send a "Hello" prompt to Claude Code.

## Non-goals

- No new HTTP/API surface. This is purely an internal background-refresh
  side effect; the dashboard, `/api/usage`, and `/api/settings` are
  unaffected.
- No capturing or exposing the response Claude gives to "Hello" — fire-and-
  forget, log-only.
- No exact-time scheduling based on parsing `resetsText` into an absolute
  timestamp. Reset detection is a simple percentage-drop heuristic on data
  already scraped — see Architecture.
- No new dependencies — Node stdlib only, same as the rest of the project.

## Architecture

Three pieces, following the project's existing "one driver module per pty
interaction" pattern (`usageDriver.js` drives `/usage`, `loginDriver.js`
drives `/login`):

**`src/resetDetector.js`** (new, pure function)

```ts
detectReset(previousBars: Bar[] | null, newBars: Bar[]): boolean
```

Builds a `label -> pctUsed` map from `previousBars`. Returns `true` if any
bar in `newBars` has a matching label in the map with a strictly lower
`pctUsed` than before — a strong, simple signal that window just reset
(usage only climbs within a window otherwise). Returns `false` if
`previousBars` is `null` (first scrape ever — no baseline to compare
against) or no bar decreased. A bar with no matching previous label (e.g. a
per-model bar appearing for the first time) is not treated as a reset.

**`src/helloPromptDriver.js`** (new, mirrors `usageDriver.js`'s shape)

```ts
sendHelloPrompt(session: PtySessionLike, options?: {
  readyQuietMs?: number, readyTimeoutMs?: number,
  responseQuietMs?: number, responseTimeoutMs?: number,
}): Promise<void>
```

Waits for the pty's initial ready prompt (same `pollUntil(term, () => true,
...)` idiom `usageDriver`/`loginDriver` already use), writes `Hello\r`
(plain text — bracketed-paste markers were only needed for long login
codes, not short chat input), then waits for the terminal to go quiet again
(streaming response finished). Rejects on timeout, exactly like
`usageDriver.scrapeUsage`. No return value on success — the response text
is intentionally discarded per the fire-and-forget/log-only decision.

**`src/usageCache.js`** (modified)

`createUsageCache` gains an optional `onReset` callback:

```ts
createUsageCache(options: {
  scrapeUsage: () => Promise<UsageInfo>, intervalMs: number,
  onReset?: () => void | Promise<void>,
}): { start(), stop(), refresh(), getState() }
```

Inside `refresh()`, the current `data.bars` is snapshotted *before* the new
scrape starts. After a successful scrape, `detectReset(previousBars,
result.bars)` is checked. If `true` and `onReset` was provided, it's
invoked but **not awaited** — the cache's own `refresh()` promise resolves
based on the scrape alone, so a slow (or hung) Hello-send never delays a
background tick or a `POST /api/refresh` response. The call is wrapped with
`.catch(() => {})` as a defensive backstop against an unhandled promise
rejection; the callback itself is expected to handle its own errors (see
below).

**`src/server.js`** (modified — wiring only, no new routes)

Passes an `onReset` callback into `createUsageCache`:

```js
onReset: async () => {
  const settings = loadSettings(configDir);
  if (!settings.helloPromptOnReset) return;
  const session = spawnSession();
  try {
    await sendHelloPrompt(session, helloPromptOptions);
    console.log('[hello-prompt] sent after usage-window reset');
  } catch (err) {
    console.error(`[hello-prompt] failed: ${err.message}`);
  } finally {
    await session.close({ exitCommand: '/exit\r' }).catch(() => {});
  }
}
```

A fresh pty session is spawned rather than chaining onto the scrape's own
session — this keeps `usageDriver.js` focused solely on scraping (no
settings coupling) and keeps the driver modules decoupled. The extra
`claude` process spawn is negligible given resets happen on the order of
hours (session window) to a week (weekly window), not every poll.
`createServer` accepts an optional `helloPromptOptions` object (same
pattern as the existing `scrapeOptions`/`loginOptions`) so tests can use
fast timeouts.

## Data flow

Every `refresh()` (background tick or manual `POST /api/refresh`): scrape →
compare new bars against the pre-scrape snapshot → update cache state
(`data`/`lastUpdatedAt`/`error`, unaffected by reset detection either way)
→ if a reset was detected, fire-and-forget the settings check and Hello
send. The very first scrape after server startup has no previous snapshot,
so it can never itself trigger a Hello send.

## Error handling

A failed Hello send (pty timeout, unexpected pty error) is caught inside
the `onReset` callback in `server.js` and logged via `console.error` —
it must never affect `usageCache`'s `data`/`stale`/`error` state, since
that's what the dashboard and `/api/usage` consumers rely on. The usage
scrape itself has already completed successfully by the time `onReset`
fires; a Hello-send failure is a wholly separate, non-critical concern.

## Copy fix

`renderSettings`'s hello-prompt section currently reads: "Saves your
preference — automatic sending isn't wired up yet." That sentence becomes
false once this ships and must be removed (or replaced with something
accurate, e.g. no note at all, since the toggle now does what its label
says). The equivalent sentence in `README.md`'s "## Settings" section
("Currently a stored preference only — the automatic sending isn't wired
up yet.") gets updated the same way.

## Testing

- `test/resetDetector.test.js` — pure-function cases: `previousBars: null`
  → `false`; all bars unchanged or increased → `false`; one bar decreased
  → `true`; a new label with no previous entry → not treated as a reset;
  multiple bars where only one decreased → `true` (still just a boolean,
  matching "one Hello per scrape cycle" regardless of how many bars reset).
- `test/helloPromptDriver.test.js` — scripted-pty test mirroring
  `usageDriver.test.js`'s pattern: emit a ready prompt, assert `Hello\r`
  was written, emit a response, assert the promise resolves; also a
  timeout case mirroring the existing timeout tests in that style.
- `test/usageCache.test.js` — additions: `onReset` fires when a fake
  `scrapeUsage` returns a lower `pctUsed` than the previous call; does NOT
  fire on the very first call (no previous data) or when usage only
  increases; `refresh()` resolves without waiting for `onReset`'s promise
  (use a slow/never-resolving fake `onReset` and assert `refresh()` still
  settles promptly).
- `test/server.test.js` — end-to-end: with settings `helloPromptOnReset:
  true` and a scripted second scrape reporting a lower `pctUsed` than the
  first, a third `ScriptedSession` is spawned and driven through the
  ready → `Hello\r` → response exchange. A companion test confirms that
  with `helloPromptOnReset: false` (the default), no third session is
  spawned even when a reset is detected.
