# Automatic Hello Prompt on Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `helloPromptOnReset` settings toggle actually do something: when a usage bar's window resets (detected by a pctUsed drop between background scrapes) and the toggle is on, automatically drive a pty session through a "Hello" prompt.

**Architecture:** Three small stdlib-only modules following the project's existing "one driver per pty interaction" pattern: a pure `resetDetector.js` (percentage-drop heuristic), a `helloPromptDriver.js` (drives one pty session through a plain-text "Hello" exchange, mirroring `usageDriver.js`), and a modified `usageCache.js` that fires an optional `onReset` callback — without awaiting it — whenever a refresh detects a reset. `server.js` wires the callback to check `settings.helloPromptOnReset` and, if on, spawn a dedicated pty session for the Hello send.

**Tech Stack:** Node.js (ESM), Node's built-in `test` runner with `node:assert/strict`, the existing `pollUntil`/`TerminalBuffer` pty-interaction helpers. No new dependencies.

## Global Constraints

- No new dependencies — Node stdlib only, consistent with the rest of the project.
- ESM syntax throughout (`import`/`export`).
- No new HTTP/API routes — this is purely an internal background-refresh side effect.
- The response Claude gives to "Hello" is never captured or exposed — fire-and-forget, log-only (`console.log`/`console.error`).
- A failed Hello send must never affect `usageCache`'s `data`/`stale`/`error` state — those reflect the usage scrape only.
- `onReset` is invoked but never awaited by `usageCache.refresh()` — a slow or hung Hello-send must never delay a background tick or a `POST /api/refresh` response.
- A fresh, separate pty session is spawned for the Hello send (not chained onto the scrape's own session) — keeps `usageDriver.js` free of any settings coupling.
- Bar shape (from `usageParser.js`): `{ label: string, pctUsed: number, resetsText: string | null }`.
- Tests use the existing patterns already in the repo: `ScriptedSession` test doubles (`onData`/`write`/`emit`/`close`), the `waitUntil(predicate, timeoutMs)` polling helper, and (for `server.test.js`) the `withServer`/`FAST_SCRAPE_OPTIONS` helpers already defined in that file.

---

### Task 1: `src/resetDetector.js` — pure reset-detection function

**Files:**
- Create: `src/resetDetector.js`
- Test: `test/resetDetector.test.js`

**Interfaces:**
- Produces: `detectReset(previousBars: Bar[] | null, newBars: Bar[]): boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/resetDetector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectReset } from '../src/resetDetector.js';

test('returns false when there is no previous data', () => {
  assert.equal(
    detectReset(null, [{ label: 'Current session', pctUsed: 10, resetsText: null }]),
    false,
  );
});

test('returns false when no bar decreased', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 20, resetsText: null }];
  assert.equal(detectReset(previous, next), false);
});

test('returns false when a bar stays the same', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  assert.equal(detectReset(previous, next), false);
});

test('returns true when a bar decreased', () => {
  const previous = [{ label: 'Current session', pctUsed: 80, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 5, resetsText: null }];
  assert.equal(detectReset(previous, next), true);
});

test('does not treat a newly-appearing label as a reset', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [
    { label: 'Current session', pctUsed: 20, resetsText: null },
    { label: 'Current week (Fable)', pctUsed: 3, resetsText: null },
  ];
  assert.equal(detectReset(previous, next), false);
});

test('returns true when only one of several bars decreased', () => {
  const previous = [
    { label: 'Current session', pctUsed: 40, resetsText: null },
    { label: 'Current week (all models)', pctUsed: 60, resetsText: null },
  ];
  const next = [
    { label: 'Current session', pctUsed: 45, resetsText: null },
    { label: 'Current week (all models)', pctUsed: 2, resetsText: null },
  ];
  assert.equal(detectReset(previous, next), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/resetDetector.test.js`
Expected: FAIL — `Cannot find module '../src/resetDetector.js'`

- [ ] **Step 3: Write the implementation**

Create `src/resetDetector.js`:

```js
export function detectReset(previousBars, newBars) {
  if (!previousBars) return false;
  const previousByLabel = new Map(previousBars.map((bar) => [bar.label, bar.pctUsed]));
  return newBars.some((bar) => {
    const prevPct = previousByLabel.get(bar.label);
    return prevPct != null && bar.pctUsed < prevPct;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/resetDetector.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/resetDetector.js test/resetDetector.test.js
git commit -m "feat: add pure reset-detection heuristic"
```

---

### Task 2: `src/helloPromptDriver.js` — drives one pty session through a Hello exchange

**Files:**
- Create: `src/helloPromptDriver.js`
- Test: `test/helloPromptDriver.test.js`

**Interfaces:**
- Consumes: `TerminalBuffer` from `./terminalBuffer.js`, `pollUntil` from `./pollUntil.js` (both already used by `usageDriver.js`/`loginDriver.js`, same style).
- Produces: `sendHelloPrompt(session: PtySessionLike, options?: { readyQuietMs?, readyTimeoutMs?, responseQuietMs?, responseTimeoutMs? }): Promise<void>` — resolves on success, rejects on timeout.

- [ ] **Step 1: Write the failing tests**

Create `test/helloPromptDriver.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendHelloPrompt } from '../src/helloPromptDriver.js';

class ScriptedSession {
  #dataCallback = null;
  writes = [];

  onData(callback) {
    this.#dataCallback = callback;
  }

  write(data) {
    this.writes.push(data);
  }

  emit(chunk) {
    this.#dataCallback?.(chunk);
  }

  async close() {}
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('waits for the ready prompt, sends Hello, and resolves once the response goes quiet', async () => {
  const session = new ScriptedSession();
  const resultPromise = sendHelloPrompt(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    responseQuietMs: 30,
    responseTimeoutMs: 500,
  });

  session.emit('❯ ready prompt\r\n');
  await waitUntil(() => session.writes.includes('Hello\r'));

  session.emit('Hello! How can I help you today?\r\n');

  await resultPromise;
  assert.equal(session.writes.includes('Hello\r'), true);
});

test('rejects if the ready prompt never settles before the timeout', async () => {
  const session = new ScriptedSession();
  const promise = sendHelloPrompt(session, {
    readyQuietMs: 20,
    readyTimeoutMs: 100,
    responseQuietMs: 20,
    responseTimeoutMs: 100,
  });

  // Keep writing so the terminal's quiet period is never satisfied.
  const interval = setInterval(() => session.emit('.'), 5);
  try {
    await assert.rejects(promise);
  } finally {
    clearInterval(interval);
  }
});

test('rejects if the response never settles before the timeout', async () => {
  const session = new ScriptedSession();
  const promise = sendHelloPrompt(session, {
    readyQuietMs: 20,
    readyTimeoutMs: 500,
    responseQuietMs: 20,
    responseTimeoutMs: 100,
  });

  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('Hello\r'));

  const interval = setInterval(() => session.emit('.'), 5);
  try {
    await assert.rejects(promise);
  } finally {
    clearInterval(interval);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/helloPromptDriver.test.js`
Expected: FAIL — `Cannot find module '../src/helloPromptDriver.js'`

- [ ] **Step 3: Write the implementation**

Create `src/helloPromptDriver.js`:

```js
import { TerminalBuffer } from './terminalBuffer.js';
import { pollUntil } from './pollUntil.js';

export async function sendHelloPrompt(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  responseQuietMs = 2000,
  responseTimeoutMs = 30000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('Hello\r');

  await pollUntil(term, () => true, { quietMs: responseQuietMs, timeoutMs: responseTimeoutMs });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/helloPromptDriver.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/helloPromptDriver.js test/helloPromptDriver.test.js
git commit -m "feat: add pty driver for sending a Hello prompt"
```

---

### Task 3: Wire reset detection into `src/usageCache.js`

**Files:**
- Modify: `src/usageCache.js`
- Test: `test/usageCache.test.js`

**Interfaces:**
- Consumes: `detectReset(previousBars, newBars): boolean` from `src/resetDetector.js` (Task 1).
- Produces: `createUsageCache` gains an optional `onReset?: () => void | Promise<void>` option, invoked (not awaited) whenever a refresh's new bars show a reset versus the immediately-prior bars.

- [ ] **Step 1: Write the failing tests**

Append these tests to `test/usageCache.test.js` (after the existing tests, same file):

```js
test('onReset fires when a bar\'s pctUsed drops between refreshes', async () => {
  let call = 0;
  const scrapes = [
    { bars: [{ label: 'Current session', pctUsed: 80, resetsText: null }], session: {}, characteristics: [], raw: '' },
    { bars: [{ label: 'Current session', pctUsed: 5, resetsText: null }], session: {}, characteristics: [], raw: '' },
  ];
  let resetFired = 0;
  const cache = createUsageCache({
    scrapeUsage: async () => scrapes[call++],
    intervalMs: 10000,
    onReset: () => { resetFired++; },
  });

  await cache.refresh();
  assert.equal(resetFired, 0, 'no previous data on the first scrape, so no reset should fire');

  await cache.refresh();
  assert.equal(resetFired, 1);
});

test('onReset does not fire when usage only increases', async () => {
  let call = 0;
  const scrapes = [
    { bars: [{ label: 'Current session', pctUsed: 10, resetsText: null }], session: {}, characteristics: [], raw: '' },
    { bars: [{ label: 'Current session', pctUsed: 20, resetsText: null }], session: {}, characteristics: [], raw: '' },
  ];
  let resetFired = 0;
  const cache = createUsageCache({
    scrapeUsage: async () => scrapes[call++],
    intervalMs: 10000,
    onReset: () => { resetFired++; },
  });

  await cache.refresh();
  await cache.refresh();
  assert.equal(resetFired, 0);
});

test('refresh() resolves without waiting for onReset to settle', async () => {
  let call = 0;
  const scrapes = [
    { bars: [{ label: 'Current session', pctUsed: 80, resetsText: null }], session: {}, characteristics: [], raw: '' },
    { bars: [{ label: 'Current session', pctUsed: 5, resetsText: null }], session: {}, characteristics: [], raw: '' },
  ];
  const cache = createUsageCache({
    scrapeUsage: async () => scrapes[call++],
    intervalMs: 10000,
    onReset: () => new Promise(() => {}), // never resolves
  });

  await cache.refresh();
  await cache.refresh(); // must not hang, even though onReset's promise never settles
  assert.equal(cache.getState().data.bars[0].pctUsed, 5);
});

test('does not throw when a reset is detected but no onReset callback was provided', async () => {
  let call = 0;
  const scrapes = [
    { bars: [{ label: 'Current session', pctUsed: 80, resetsText: null }], session: {}, characteristics: [], raw: '' },
    { bars: [{ label: 'Current session', pctUsed: 5, resetsText: null }], session: {}, characteristics: [], raw: '' },
  ];
  const cache = createUsageCache({ scrapeUsage: async () => scrapes[call++], intervalMs: 10000 });
  await cache.refresh();
  await assert.doesNotReject(cache.refresh());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/usageCache.test.js`
Expected: FAIL — the four new tests fail (`resetFired` stays 0 in the first test; no behavioral change yet)

- [ ] **Step 3: Write the implementation**

Modify `src/usageCache.js` to the following (adds the `detectReset` import, the `onReset` option, a `previousBars` snapshot taken before each scrape, and the fire-and-forget `onReset` call):

```js
import { detectReset } from './resetDetector.js';

export function createUsageCache({ scrapeUsage, intervalMs, onReset }) {
  let data = null;
  let lastUpdatedAt = null;
  let error = null;
  let timer = null;
  let inFlight = null;

  function refresh() {
    if (inFlight) return inFlight;
    const previousBars = data?.bars ?? null;
    inFlight = scrapeUsage()
      .then((result) => {
        const resetDetected = detectReset(previousBars, result.bars);
        data = result;
        lastUpdatedAt = new Date();
        error = null;
        if (resetDetected && onReset) {
          Promise.resolve(onReset()).catch(() => {});
        }
      })
      .catch((err) => {
        error = err.message;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getState() {
    return {
      data,
      lastUpdatedAt,
      stale: Boolean(error) && data !== null,
      error,
    };
  }

  return { start, stop, refresh, getState };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/usageCache.test.js`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all test files, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/usageCache.js test/usageCache.test.js
git commit -m "feat: fire onReset when usageCache detects a usage-window reset"
```

---

### Task 4: Wire the Hello send into `src/server.js`, fix outdated copy

**Files:**
- Modify: `src/server.js`
- Modify: `src/htmlView.js`
- Modify: `README.md`
- Test: `test/server.test.js`
- Test: `test/htmlView.test.js`

**Interfaces:**
- Consumes: `sendHelloPrompt(session, options)` from `src/helloPromptDriver.js` (Task 2); the `onReset` option on `createUsageCache` (Task 3); `loadSettings(configDir)` from the already-merged `src/settings.js`.
- Produces: `createServer` gains an optional `helloPromptOptions = {}` option (same pattern as `scrapeOptions`/`loginOptions`), used only to pass fast timeouts through to `sendHelloPrompt` in tests.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js` (append at the end of the file). Add this constant near the existing `FAST_SCRAPE_OPTIONS`/`FAST_LOGIN_OPTIONS` constants at the top of the file:

```js
const FAST_HELLO_OPTIONS = { readyQuietMs: 20, readyTimeoutMs: 500, responseQuietMs: 20, responseTimeoutMs: 500 };
```

Then append these two tests at the end of the file:

```js
test('a detected reset spawns a Hello-prompt session when helloPromptOnReset is enabled', async () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  const sessions = [];
  await withServer(
    {
      configDir,
      workDir: '/tmp',
      intervalMs: 60000,
      scrapeOptions: FAST_SCRAPE_OPTIONS,
      helloPromptOptions: FAST_HELLO_OPTIONS,
      spawnSession: () => {
        const s = new ScriptedSession();
        sessions.push(s);
        return s;
      },
    },
    async (base) => {
      await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helloPromptOnReset: true }),
      });

      // Let the background scrape (session 0) establish a baseline pctUsed.
      await waitUntil(() => sessions.length >= 1);
      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/usage\r'));
      sessions[0].emit('Current session\n80% used\nResets 1pm\n');

      let pctUsed;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/usage`);
        const body = await res.json();
        pctUsed = body.bars?.[0]?.pctUsed;
        if (pctUsed === 80) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(pctUsed, 80);

      // Force a second scrape (session 1) reporting a lower pctUsed than the baseline.
      const refreshPromise = fetch(`${base}/api/refresh`, { method: 'POST' });
      await waitUntil(() => sessions.length >= 2);
      sessions[1].emit('❯ ready\r\n');
      await waitUntil(() => sessions[1].writes.includes('/usage\r'));
      sessions[1].emit('Current session\n5% used\nResets 6pm\n');
      await refreshPromise;

      // The detected reset spawns a third session and drives it through the Hello exchange.
      await waitUntil(() => sessions.length >= 3);
      sessions[2].emit('❯ ready\r\n');
      await waitUntil(() => sessions[2].writes.includes('Hello\r'));
      sessions[2].emit('Hello! How can I help?\r\n');

      assert.equal(sessions[2].writes.includes('Hello\r'), true);
    },
  );
});

test('a detected reset does not spawn a Hello-prompt session when helloPromptOnReset is disabled', async () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  const sessions = [];
  await withServer(
    {
      configDir,
      workDir: '/tmp',
      intervalMs: 60000,
      scrapeOptions: FAST_SCRAPE_OPTIONS,
      helloPromptOptions: FAST_HELLO_OPTIONS,
      spawnSession: () => {
        const s = new ScriptedSession();
        sessions.push(s);
        return s;
      },
    },
    async (base) => {
      // helloPromptOnReset defaults to false — settings left untouched.
      await waitUntil(() => sessions.length >= 1);
      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/usage\r'));
      sessions[0].emit('Current session\n80% used\nResets 1pm\n');

      let pctUsed;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/usage`);
        const body = await res.json();
        pctUsed = body.bars?.[0]?.pctUsed;
        if (pctUsed === 80) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(pctUsed, 80);

      const refreshPromise = fetch(`${base}/api/refresh`, { method: 'POST' });
      await waitUntil(() => sessions.length >= 2);
      sessions[1].emit('❯ ready\r\n');
      await waitUntil(() => sessions[1].writes.includes('/usage\r'));
      sessions[1].emit('Current session\n5% used\nResets 6pm\n');
      await refreshPromise;

      // Give any (incorrect) Hello-send a chance to happen before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sessions.length, 2, 'no third session should be spawned when the toggle is off');
    },
  );
});
```

Add this test to `test/htmlView.test.js` (append at the end of the file):

```js
test('renderSettings no longer claims automatic sending is unwired', () => {
  const html = renderSettings({ plan: null, helloPromptOnReset: false });
  assert.doesNotMatch(html, /isn't wired up yet/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.js test/htmlView.test.js`
Expected: FAIL — the two new server tests time out/fail (no third session is ever spawned yet, since `onReset` isn't wired to anything); the new htmlView test fails (the outdated sentence is still present)

- [ ] **Step 3: Write the implementation**

In `src/server.js`, add the import (alongside the existing driver imports):

```js
import { sendHelloPrompt } from './helloPromptDriver.js';
```

Add `helloPromptOptions = {}` to the destructured options:

```js
export function createServer({
  configDir,
  workDir,
  intervalMs = 300000,
  spawnSession = () => new PtySession('claude', [], {
    cwd: workDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  }),
  scrapeOptions = {},
  loginOptions = {},
  helloPromptOptions = {},
} = {}) {
```

Replace the `createUsageCache({...})` call with:

```js
  const cache = createUsageCache({
    intervalMs,
    scrapeUsage: async () => {
      const session = spawnSession();
      try {
        return await scrapeUsagePanel(session, scrapeOptions);
      } finally {
        await session.close({ exitCommand: '/exit\r' });
      }
    },
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
    },
  });
```

In `src/htmlView.js`, remove the outdated note paragraph from `renderSettings` (delete this line from the "Hello prompt on reset" section):

```js
        <p class="muted small">Saves your preference — automatic sending isn't wired up yet.</p>
```

In `README.md`, replace the "Hello prompt on reset" bullet in the "## Settings" section:

```markdown
- **Hello prompt on reset** — a toggle to record a preference for sending a
  "Hello" prompt after every usage-window reset. Currently a stored
  preference only — the automatic sending isn't wired up yet.
```

with:

```markdown
- **Hello prompt on reset** — a toggle to automatically send a "Hello"
  prompt through Claude Code whenever a usage bar's window resets (detected
  by a drop in that bar's % used between background scrapes). Off by
  default; enable it on the settings page.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server.test.js test/htmlView.test.js`
Expected: PASS (all tests, including the new ones)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all test files, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/htmlView.js README.md test/server.test.js test/htmlView.test.js
git commit -m "feat: send a Hello prompt after a detected usage-window reset"
```
