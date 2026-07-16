# Single-Container Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three one-shot `docker-compose` services (`login`, `login-token`, `scrape`) with a single long-running container that serves a web dashboard of Claude usage metrics, a JSON endpoint for other tools to poll, and a web-driven login flow for first-time setup.

**Architecture:** A new `src/server.js` (plain `node:http`) wires together a background-refreshed usage cache (`src/usageCache.js`), a pty-driven login flow (`src/loginDriver.js`), and server-rendered HTML views (`src/htmlView.js`) — all built on the existing, unchanged scraping core (`usageParser.js`, `usageDriver.js`, `ptySession.js`, `terminalBuffer.js`). `docker/entrypoint.sh` shrinks to always start the server; `docker-compose.yml` collapses to one `app` service.

**Tech Stack:** Node 22, ES modules, `node:http` (no new runtime dependencies), `node:test` for tests, `node-pty` + `@xterm/headless` (existing).

## Global Constraints

- Node >= 22, ES modules (`"type": "module"` in `package.json`) throughout — matches the existing codebase.
- No new runtime dependencies. Use `node:http` directly, not Express or any framework.
- No built-in authentication/access control on the web UI.
- Server listens on `PORT` (default `8080`); background usage refresh runs every `USAGE_REFRESH_INTERVAL_MS` (default `300000`).
- `CLAUDE_CONFIG_DIR`, `CLAUDE_USAGE_WORKDIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` keep their existing meaning and defaults unchanged.
- Match existing code style exactly: semicolons, 2-space indentation, named exports, `node:test` + `node:assert/strict` for tests, small real-timer waits in tests (not fake timers) — see `test/usageDriver.test.js` for the established pattern.
- The existing scraping core (`src/usageParser.js`, `src/usageDriver.js`, `src/ptySession.js`, `src/terminalBuffer.js`, `src/preseed.js`, `src/format.js`) must not change behavior — only `usageDriver.js` gets a small internal refactor (extracting `pollUntil`) with no behavior change, verified by its existing passing tests.
- `bin/claude-usage.js` (the one-shot CLI) is left working and unchanged.

---

### Task 1: `src/credentials.js` — shared credentials check

**Files:**
- Create: `src/credentials.js`
- Test: `test/credentials.test.js`

**Interfaces:**
- Produces: `hasCredentials(configDir: string): boolean` — true if `.credentials.json` exists in `configDir`, or `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` env vars are set. Used by `server.js` (Task 5) to decide authenticated vs. login-flow state, and after a login attempt to confirm credentials were actually written.

- [ ] **Step 1: Write the failing test**

Create `test/credentials.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasCredentials } from '../src/credentials.js';

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-test-'));
}

test('false when no credentials file and no env vars', () => {
  const configDir = makeTmpConfigDir();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(hasCredentials(configDir), false);
});

test('true when .credentials.json exists', () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  assert.equal(hasCredentials(configDir), true);
});

test('true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
  const configDir = makeTmpConfigDir();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-value';
  assert.equal(hasCredentials(configDir), true);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

test('true when ANTHROPIC_API_KEY is set', () => {
  const configDir = makeTmpConfigDir();
  process.env.ANTHROPIC_API_KEY = 'key-value';
  assert.equal(hasCredentials(configDir), true);
  delete process.env.ANTHROPIC_API_KEY;
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/credentials.test.js`
Expected: FAIL — `Cannot find module '../src/credentials.js'`

- [ ] **Step 3: Write the implementation**

Create `src/credentials.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

export function hasCredentials(configDir) {
  return (
    fs.existsSync(path.join(configDir, '.credentials.json')) ||
    Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) ||
    Boolean(process.env.ANTHROPIC_API_KEY)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/credentials.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials.js test/credentials.test.js
git commit -m "feat: add shared hasCredentials() check"
```

---

### Task 2: `src/usageCache.js` — background-refreshed usage cache

**Files:**
- Create: `src/usageCache.js`
- Test: `test/usageCache.test.js`

**Interfaces:**
- Consumes: an injected `scrapeUsage: () => Promise<UsageInfo>` (the caller wires this to the real pty-based scrape in Task 5; tests inject a fake).
- Produces: `createUsageCache({ scrapeUsage, intervalMs }): { start(): void, stop(): void, refresh(): Promise<void>, getState(): { data: UsageInfo|null, lastUpdatedAt: Date|null, stale: boolean, error: string|null } }`. `server.js` (Task 5) and `htmlView.js` (Task 4) both consume `getState()`'s shape directly.

- [ ] **Step 1: Write the failing tests**

Create `test/usageCache.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageCache } from '../src/usageCache.js';

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('getState starts empty before any refresh', () => {
  const cache = createUsageCache({ scrapeUsage: async () => ({}), intervalMs: 10000 });
  const state = cache.getState();
  assert.equal(state.data, null);
  assert.equal(state.lastUpdatedAt, null);
  assert.equal(state.stale, false);
  assert.equal(state.error, null);
});

test('refresh() populates data and lastUpdatedAt on success', async () => {
  const usage = { bars: [], session: {}, characteristics: [], raw: '' };
  const cache = createUsageCache({ scrapeUsage: async () => usage, intervalMs: 10000 });
  await cache.refresh();
  const state = cache.getState();
  assert.equal(state.data, usage);
  assert.ok(state.lastUpdatedAt instanceof Date);
  assert.equal(state.stale, false);
});

test('refresh() keeps last good data and marks stale on failure', async () => {
  const usage = { bars: [], session: {}, characteristics: [], raw: '' };
  let shouldFail = false;
  const cache = createUsageCache({
    scrapeUsage: async () => {
      if (shouldFail) throw new Error('scrape boom');
      return usage;
    },
    intervalMs: 10000,
  });

  await cache.refresh();
  shouldFail = true;
  await cache.refresh();

  const state = cache.getState();
  assert.equal(state.data, usage);
  assert.equal(state.stale, true);
  assert.equal(state.error, 'scrape boom');
});

test('concurrent refresh() calls share one in-flight scrape', async () => {
  let calls = 0;
  const cache = createUsageCache({
    scrapeUsage: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { bars: [], session: {}, characteristics: [], raw: '' };
    },
    intervalMs: 10000,
  });

  await Promise.all([cache.refresh(), cache.refresh()]);
  assert.equal(calls, 1);
});

test('start() refreshes immediately then again on each interval tick', async () => {
  let calls = 0;
  const cache = createUsageCache({
    scrapeUsage: async () => {
      calls++;
      return { bars: [], session: {}, characteristics: [], raw: '' };
    },
    intervalMs: 20,
  });

  cache.start();
  await waitUntil(() => calls >= 1);
  await waitUntil(() => calls >= 3, 500);
  cache.stop();

  const callsAfterStop = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, callsAfterStop);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/usageCache.test.js`
Expected: FAIL — `Cannot find module '../src/usageCache.js'`

- [ ] **Step 3: Write the implementation**

Create `src/usageCache.js`:

```js
export function createUsageCache({ scrapeUsage, intervalMs }) {
  let data = null;
  let lastUpdatedAt = null;
  let error = null;
  let timer = null;
  let inFlight = null;

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = scrapeUsage()
      .then((result) => {
        data = result;
        lastUpdatedAt = new Date();
        error = null;
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
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/usageCache.js test/usageCache.test.js
git commit -m "feat: add background-refreshed usage cache"
```

---

### Task 3: Extract `pollUntil`, capture login fixtures, add `src/loginDriver.js`

This task has a step that **requires live human interaction** (completing a real browser OAuth flow) — it cannot be automated by whoever is executing this plan. Stop and hand it to the user when you reach it.

**Files:**
- Create: `src/pollUntil.js`
- Modify: `src/usageDriver.js` (use the extracted `pollUntil` instead of its local copy — no behavior change)
- Create: `test/fixtures/login-url-screen.txt`
- Create: `test/fixtures/login-success-screen.txt`
- Create: `src/loginDriver.js`
- Test: `test/loginDriver.test.js`

**Interfaces:**
- Consumes: `TerminalBuffer` (`src/terminalBuffer.js`, unchanged) and a pty-session-like object with `.onData(cb)`/`.write(data)` — the same shape `usageDriver.scrapeUsage()` already consumes.
- Produces:
  - `pollUntil(term, predicate, { quietMs, timeoutMs, intervalMs? }): Promise<void>` (moved from `usageDriver.js`, same signature/behavior).
  - `startLogin(session, opts?): Promise<{ term: TerminalBuffer, loginUrl: string }>` — `server.js` (Task 5) holds onto the returned `term` and passes it to `submitLoginCode`.
  - `submitLoginCode(session, term, code, opts?): Promise<{ success: true } | { success: false, message: string }>`.

- [ ] **Step 1 (human-assisted, cannot be automated): Capture real `/login` screen fixtures**

Ask the user to run this now, in a real terminal, using a **scratch** config dir so it doesn't touch their normal Claude Code session:

```bash
mkdir -p /tmp/claude-login-capture
CLAUDE_CONFIG_DIR=/tmp/claude-login-capture claude
```

Once the prompt is ready, have them type `/login`, then copy the full rendered screen text (the part containing the authorization URL) into `test/fixtures/login-url-screen.txt`. Then have them complete the browser OAuth step and paste the resulting code back into the `claude` prompt; once it reports success, copy that screen's text into `test/fixtures/login-success-screen.txt`.

Redact any PII (account email, org name, session IDs) the same way `test/fixtures/usage-subscription.txt` was redacted — replace with placeholder text but keep the surrounding structure intact, since the driver's regexes match on structure/keywords, not on the redacted values.

Do not proceed to Step 5 (writing the regex constants) until these two fixture files exist and have been reviewed for stray secrets.

- [ ] **Step 2: Extract `pollUntil` with no behavior change**

Create `src/pollUntil.js`:

```js
export function pollUntil(term, predicate, { quietMs, timeoutMs, intervalMs = 20 }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (term.msSinceLastWrite() >= quietMs && predicate(term.getText())) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for expected terminal state'));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}
```

Edit `src/usageDriver.js` — remove the local `pollUntil` function (lines 8-22) and import it instead:

```js
import { TerminalBuffer } from './terminalBuffer.js';
import { parseUsage } from './usageParser.js';
import { pollUntil } from './pollUntil.js';

function looksLikeUsagePanel(text) {
  return /%\s*used/i.test(text);
}

export async function scrapeUsage(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  stableQuietMs = 500,
  stableTimeoutMs = 20000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('/usage\r');

  await pollUntil(term, looksLikeUsagePanel, {
    quietMs: stableQuietMs,
    timeoutMs: stableTimeoutMs,
  });

  return parseUsage(term.getText());
}
```

- [ ] **Step 3: Verify the extraction didn't break `usageDriver.js`**

Run: `node --test test/usageDriver.test.js`
Expected: PASS (3 tests, unchanged from before the extraction)

- [ ] **Step 4: Write the failing tests for `loginDriver.js`**

Create `test/loginDriver.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLogin, submitLoginCode } from '../src/loginDriver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test('startLogin waits for the ready prompt, sends /login, and extracts the URL', async () => {
  const session = new ScriptedSession();
  const resultPromise = startLogin(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    urlQuietMs: 30,
    urlTimeoutMs: 500,
  });

  session.emit('❯ ready prompt\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));

  session.emit('Visit https://example.com/device?code=abc123 to authorize\r\n');

  const result = await resultPromise;
  assert.equal(result.loginUrl, 'https://example.com/device?code=abc123');
});

test('submitLoginCode: full flow from URL to a successful code', async () => {
  const session = new ScriptedSession();
  const startPromise = startLogin(session, {
    readyQuietMs: 20, readyTimeoutMs: 500, urlQuietMs: 20, urlTimeoutMs: 500,
  });
  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));
  session.emit('Visit https://example.com/device to authorize\r\n');
  const { term } = await startPromise;

  const codePromise = submitLoginCode(session, term, '123456', {
    resultQuietMs: 20, resultTimeoutMs: 500,
  });
  await waitUntil(() => session.writes.includes('123456\r'));
  session.emit('Login successful! You are now authenticated.\r\n');

  const result = await codePromise;
  assert.equal(result.success, true);
});

test('submitLoginCode: full flow from URL to a rejected code', async () => {
  const session = new ScriptedSession();
  const startPromise = startLogin(session, {
    readyQuietMs: 20, readyTimeoutMs: 500, urlQuietMs: 20, urlTimeoutMs: 500,
  });
  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));
  session.emit('Visit https://example.com/device to authorize\r\n');
  const { term } = await startPromise;

  const codePromise = submitLoginCode(session, term, 'wrong', {
    resultQuietMs: 20, resultTimeoutMs: 500,
  });
  await waitUntil(() => session.writes.includes('wrong\r'));
  session.emit('That code is invalid, please try again.\r\n');

  const result = await codePromise;
  assert.equal(result.success, false);
  assert.match(result.message, /invalid/i);
});

test('startLogin extracts the URL from the real captured fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/login-url-screen.txt'), 'utf8');
  const match = text.match(/(https:\/\/\S+)/);
  assert.ok(match, 'expected the real login fixture to contain a matchable https:// URL');
});

test('submitLoginCode recognizes success in the real captured fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/login-success-screen.txt'), 'utf8');
  assert.match(text, /(login successful|logged in|authentication successful)/i);
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node --test test/loginDriver.test.js`
Expected: FAIL — `Cannot find module '../src/loginDriver.js'`

- [ ] **Step 6: Write the implementation**

Create `src/loginDriver.js`:

```js
import { TerminalBuffer } from './terminalBuffer.js';
import { pollUntil } from './pollUntil.js';

const URL_RE = /(https:\/\/\S+)/;
const SUCCESS_RE = /(login successful|logged in|authentication successful)/i;
const ERROR_RE = /(invalid code|expired|login failed|try again)/i;

function hasUrl(text) {
  return URL_RE.test(text);
}

function hasOutcome(text) {
  return SUCCESS_RE.test(text) || ERROR_RE.test(text);
}

function extractErrorLine(text) {
  const line = text.split('\n').find((l) => ERROR_RE.test(l));
  return line ? line.trim() : 'Login failed';
}

export async function startLogin(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  urlQuietMs = 500,
  urlTimeoutMs = 20000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('/login\r');

  await pollUntil(term, hasUrl, { quietMs: urlQuietMs, timeoutMs: urlTimeoutMs });

  const match = term.getText().match(URL_RE);
  return { term, loginUrl: match[1] };
}

export async function submitLoginCode(session, term, code, {
  resultQuietMs = 500,
  resultTimeoutMs = 15000,
} = {}) {
  session.write(`${code}\r`);

  await pollUntil(term, hasOutcome, { quietMs: resultQuietMs, timeoutMs: resultTimeoutMs });

  const text = term.getText();
  if (SUCCESS_RE.test(text)) {
    return { success: true };
  }
  return { success: false, message: extractErrorLine(text) };
}
```

- [ ] **Step 7: Run the tests to verify they pass; reconcile regexes against the real fixtures**

Run: `node --test test/loginDriver.test.js`
Expected: PASS (6 tests)

If the two fixture-based tests fail, open `test/fixtures/login-url-screen.txt` and `test/fixtures/login-success-screen.txt` and inspect the actual captured text. Adjust `URL_RE`, `SUCCESS_RE`, and/or `ERROR_RE` in `src/loginDriver.js` to match what Claude Code's `/login` screen really prints, then rerun until all 6 tests pass. Do not weaken the fixture-based assertions to make them pass — fix the regex instead.

- [ ] **Step 8: Commit**

```bash
git add src/pollUntil.js src/usageDriver.js src/loginDriver.js test/loginDriver.test.js test/fixtures/login-url-screen.txt test/fixtures/login-success-screen.txt
git commit -m "feat: add pty-driven login flow with captured fixture coverage"
```

---

### Task 4: `src/htmlView.js` — dashboard and login page rendering

**Files:**
- Create: `src/htmlView.js`
- Test: `test/htmlView.test.js`

**Interfaces:**
- Consumes: the `{ data, lastUpdatedAt, stale, error }` shape from `usageCache.getState()` (Task 2), and a `{ status, loginUrl?, error? }` login-state shape matching what `server.js` (Task 5) will track (`status` one of `'idle' | 'starting' | 'awaiting-code' | 'submitting' | 'error'`).
- Produces: `renderDashboard(state): string` (full HTML document), `renderLoginPage(loginState): string` (full HTML document). Both are pure functions — no I/O.

- [ ] **Step 1: Write the failing tests**

Create `test/htmlView.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, renderLoginPage } from '../src/htmlView.js';

test('renderDashboard shows a waiting message before first scrape', () => {
  const html = renderDashboard({ data: null, lastUpdatedAt: null, stale: false, error: null });
  assert.match(html, /Waiting for the first scrape/);
});

test('renderDashboard renders bars, session, and characteristics', () => {
  const html = renderDashboard({
    data: {
      bars: [{ label: 'Current session', pctUsed: 42, resetsText: 'Resets 1pm' }],
      session: { totalCostUsd: 1.2345, apiDuration: '3s', wallDuration: '5s' },
      characteristics: [{ pct: 80, summary: 'subagent-heavy sessions', detail: 'Be deliberate.' }],
      raw: '',
    },
    lastUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    stale: false,
    error: null,
  });
  assert.match(html, /Current session/);
  assert.match(html, /42%/);
  assert.match(html, /Resets 1pm/);
  assert.match(html, /\$1\.2345/);
  assert.match(html, /subagent-heavy sessions/);
});

test('renderDashboard shows a stale warning banner when the latest refresh failed', () => {
  const html = renderDashboard({
    data: { bars: [], session: {}, characteristics: [], raw: '' },
    lastUpdatedAt: new Date(),
    stale: true,
    error: 'scrape timed out',
  });
  assert.match(html, /banner-warn/);
  assert.match(html, /scrape timed out/);
});

test('renderDashboard escapes untrusted text', () => {
  const html = renderDashboard({
    data: {
      bars: [{ label: '<script>evil()</script>', pctUsed: 1, resetsText: null }],
      session: {},
      characteristics: [],
      raw: '',
    },
    lastUpdatedAt: new Date(),
    stale: false,
    error: null,
  });
  assert.doesNotMatch(html, /<script>evil\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renderLoginPage shows a start button when idle', () => {
  const html = renderLoginPage({ status: 'idle' });
  assert.match(html, /Start login/);
});

test('renderLoginPage shows the URL and code form when awaiting a code', () => {
  const html = renderLoginPage({ status: 'awaiting-code', loginUrl: 'https://example.com/auth' });
  assert.match(html, /https:\/\/example\.com\/auth/);
  assert.match(html, /id="code"/);
});

test('renderLoginPage shows the error banner and a retry button', () => {
  const html = renderLoginPage({ status: 'error', error: 'invalid code' });
  assert.match(html, /banner-error/);
  assert.match(html, /invalid code/);
  assert.match(html, /Try again/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/htmlView.test.js`
Expected: FAIL — `Cannot find module '../src/htmlView.js'`

- [ ] **Step 3: Write the implementation**

Create `src/htmlView.js`:

```js
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function barColor(pct) {
  if (pct >= 85) return '#e5484d';
  if (pct >= 60) return '#f5a623';
  return '#30a46c';
}

function renderBars(bars) {
  if (!bars || bars.length === 0) {
    return '<p class="muted">No usage bars parsed yet.</p>';
  }
  return bars.map((bar) => `
    <div class="bar-row">
      <div class="bar-label">
        <span>${escapeHtml(bar.label)}</span>
        <span>${bar.pctUsed}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${bar.pctUsed}%;background:${barColor(bar.pctUsed)}"></div>
      </div>
      ${bar.resetsText ? `<div class="muted small">${escapeHtml(bar.resetsText)}</div>` : ''}
    </div>
  `).join('');
}

function renderSession(session) {
  if (!session || (session.totalCostUsd == null && !session.apiDuration && !session.wallDuration)) {
    return '';
  }
  const cost = session.totalCostUsd != null ? `$${session.totalCostUsd.toFixed(4)}` : '—';
  return `
    <div class="section">
      <h2>This session</h2>
      <div class="stat-row"><span>Cost</span><span>${escapeHtml(cost)}</span></div>
      <div class="stat-row"><span>API duration</span><span>${escapeHtml(session.apiDuration ?? '—')}</span></div>
      <div class="stat-row"><span>Wall duration</span><span>${escapeHtml(session.wallDuration ?? '—')}</span></div>
    </div>
  `;
}

function renderCharacteristics(characteristics) {
  if (!characteristics || characteristics.length === 0) return '';
  return `
    <div class="section">
      <h2>What's contributing to your limits usage?</h2>
      ${characteristics.map((c) => `
        <div class="characteristic">
          <strong>${c.pct}%</strong> ${escapeHtml(c.summary)}
          <p class="muted small">${escapeHtml(c.detail)}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function renderPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 2rem 1rem;
    background: #f6f7f9;
    color: #1a1d21;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaed; }
    .card { background: #1e2126 !important; border-color: #2c3036 !important; }
    input, button { background: #2c3036 !important; color: #e8eaed !important; border-color: #3a3f47 !important; }
  }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 1.75rem 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.75rem; }
  .header-row { display: flex; align-items: center; justify-content: space-between; }
  .muted { color: #6b7280; }
  .small { font-size: 0.8rem; }
  .bars { margin-top: 1rem; }
  .bar-row { margin-bottom: 1.1rem; }
  .bar-label { display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 0.3rem; }
  .bar-track { background: #e9eaec; border-radius: 999px; height: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.3s ease; }
  .section { border-top: 1px solid #e3e5e8; padding-top: 0.75rem; }
  .stat-row { display: flex; justify-content: space-between; font-size: 0.9rem; padding: 0.2rem 0; }
  .characteristic { margin-bottom: 0.75rem; }
  .banner { border-radius: 8px; padding: 0.6rem 0.9rem; font-size: 0.85rem; margin: 0.75rem 0; }
  .banner-error { background: #fde8e8; color: #9b1c1c; }
  .banner-warn { background: #fef3c7; color: #92400e; }
  button, input { font: inherit; border-radius: 8px; border: 1px solid #d1d5db; padding: 0.5rem 0.9rem; }
  button { background: #1a1d21; color: #fff; border: none; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  form { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  input { flex: 1; }
  a { color: #2563eb; word-break: break-all; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function renderDashboard(state) {
  const { data, lastUpdatedAt, stale, error } = state;

  if (!data) {
    return renderPage('Claude Usage', `
      <div class="card">
        <h1>Claude Usage</h1>
        <p class="muted">Waiting for the first scrape to complete…</p>
        ${error ? `<div class="banner banner-error">${escapeHtml(error)}</div>` : ''}
      </div>
      <script>setTimeout(() => location.reload(), 3000);</script>
    `);
  }

  const updated = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : 'never';

  return renderPage('Claude Usage', `
    <div class="card">
      <div class="header-row">
        <h1>Claude Usage</h1>
        <button id="refresh-btn" onclick="refresh()">Refresh now</button>
      </div>
      ${stale ? `<div class="banner banner-warn">Showing last known data — most recent refresh failed: ${escapeHtml(error)}</div>` : ''}
      <div class="bars">${renderBars(data.bars)}</div>
      ${renderSession(data.session)}
      ${renderCharacteristics(data.characteristics)}
      <p class="muted small">Last updated ${escapeHtml(updated)}</p>
    </div>
    <script>
      async function refresh() {
        const btn = document.getElementById('refresh-btn');
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        await fetch('/api/refresh', { method: 'POST' });
        location.reload();
      }
    </script>
  `);
}

export function renderLoginPage(loginState = { status: 'idle' }) {
  const { status, loginUrl, error } = loginState;

  let body;
  if (status === 'idle' || status === 'starting') {
    body = `
      <h1>Connect Claude Code</h1>
      <p class="muted">No credentials found yet. Start the login flow to authorize this container.</p>
      <button onclick="startLogin()" ${status === 'starting' ? 'disabled' : ''}>
        ${status === 'starting' ? 'Starting…' : 'Start login'}
      </button>
    `;
  } else if (status === 'awaiting-code' || status === 'submitting') {
    body = `
      <h1>Connect Claude Code</h1>
      <p>1. Visit this URL and authorize the app:</p>
      <p><a href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener">${escapeHtml(loginUrl)}</a></p>
      <p>2. Paste the code it gives you back here:</p>
      <form onsubmit="return submitCode(event)">
        <input id="code" name="code" autocomplete="off" placeholder="paste code" ${status === 'submitting' ? 'disabled' : ''} />
        <button type="submit" ${status === 'submitting' ? 'disabled' : ''}>
          ${status === 'submitting' ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    `;
  } else if (status === 'error') {
    body = `
      <h1>Connect Claude Code</h1>
      <div class="banner banner-error">${escapeHtml(error)}</div>
      <button onclick="startLogin()">Try again</button>
    `;
  } else {
    body = `<h1>Connect Claude Code</h1><p class="muted">Unexpected state.</p>`;
  }

  return renderPage('Claude Usage — Login', `
    <div class="card">${body}</div>
    <script>
      async function startLogin() {
        await fetch('/api/login/start', { method: 'POST' });
        location.reload();
      }
      async function submitCode(evt) {
        evt.preventDefault();
        const code = document.getElementById('code').value;
        const res = await fetch('/api/login/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const state = await res.json();
        if (state.status === 'success') {
          location.href = '/';
        } else {
          location.reload();
        }
        return false;
      }
      ${status === 'awaiting-code' ? 'setTimeout(() => location.reload(), 15000);' : ''}
    </script>
  `);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/htmlView.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/htmlView.js test/htmlView.test.js
git commit -m "feat: add server-rendered dashboard and login page views"
```

---

### Task 5: `src/server.js` — HTTP server wiring it all together

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `hasCredentials` (Task 1), `createUsageCache` (Task 2), `startLogin`/`submitLoginCode` (Task 3), `renderDashboard`/`renderLoginPage` (Task 4), `PtySession` (`src/ptySession.js`), `scrapeUsage` (`src/usageDriver.js`), `preseed` (`src/preseed.js`).
- Produces: `createServer({ configDir, workDir, intervalMs?, spawnSession?, scrapeOptions?, loginOptions? }): http.Server` — an unstarted `http.Server` (caller calls `.listen(port)`). Task 6's `bin/claude-usage-server.js` is the only other consumer.

- [ ] **Step 1: Write the failing tests**

Create `test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

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

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const FAST_SCRAPE_OPTIONS = { readyQuietMs: 20, readyTimeoutMs: 500, stableQuietMs: 20, stableTimeoutMs: 500 };
const FAST_LOGIN_OPTIONS = { readyQuietMs: 20, readyTimeoutMs: 500, urlQuietMs: 20, urlTimeoutMs: 500, resultQuietMs: 20, resultTimeoutMs: 500 };

test('GET /api/usage returns 503 before authentication', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/api/usage`);
      assert.equal(res.status, 503);
    },
  );
});

test('GET / renders the login page before authentication', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/`);
      const html = await res.text();
      assert.match(html, /Start login/);
    },
  );
});

test('GET /api/usage returns cached usage once authenticated', async () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  const sessions = [];
  await withServer(
    {
      configDir,
      workDir: '/tmp',
      intervalMs: 60000,
      scrapeOptions: FAST_SCRAPE_OPTIONS,
      spawnSession: () => {
        const s = new ScriptedSession();
        sessions.push(s);
        return s;
      },
    },
    async (base) => {
      await waitUntil(() => sessions.length >= 1);
      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/usage\r'));
      sessions[0].emit('Current session\n50% used\nResets 1pm\n');

      let pctUsed;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/usage`);
        const body = await res.json();
        pctUsed = body.bars?.[0]?.pctUsed;
        if (pctUsed === 50) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(pctUsed, 50);
    },
  );
});

test('login flow: start returns a URL, submitting a valid code authenticates', async () => {
  const configDir = makeTmpConfigDir();
  const sessions = [];
  await withServer(
    {
      configDir,
      workDir: '/tmp',
      intervalMs: 60000,
      scrapeOptions: FAST_SCRAPE_OPTIONS,
      loginOptions: FAST_LOGIN_OPTIONS,
      spawnSession: () => {
        const s = new ScriptedSession();
        sessions.push(s);
        return s;
      },
    },
    async (base) => {
      const startPromise = fetch(`${base}/api/login/start`, { method: 'POST' });
      await waitUntil(() => sessions.length >= 1);
      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/login\r'));
      sessions[0].emit('Visit https://example.com/device to authorize\r\n');

      const startRes = await startPromise;
      const startBody = await startRes.json();
      assert.equal(startBody.status, 'awaiting-code');
      assert.equal(startBody.loginUrl, 'https://example.com/device');

      fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');

      const codePromise = fetch(`${base}/api/login/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      });
      await waitUntil(() => sessions[0].writes.includes('123456\r'));
      sessions[0].emit('Login successful\r\n');

      const codeRes = await codePromise;
      const codeBody = await codeRes.json();
      assert.equal(codeBody.status, 'success');

      const usageRes = await fetch(`${base}/api/usage`);
      assert.equal(usageRes.status, 200);
    },
  );
});

test('POST /api/login/code without a code returns 400', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/api/login/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: Write the implementation**

Create `src/server.js`:

```js
import http from 'node:http';
import { hasCredentials } from './credentials.js';
import { createUsageCache } from './usageCache.js';
import { startLogin, submitLoginCode } from './loginDriver.js';
import { renderDashboard, renderLoginPage } from './htmlView.js';
import { PtySession } from './ptySession.js';
import { scrapeUsage as scrapeUsagePanel } from './usageDriver.js';
import { preseed } from './preseed.js';

const LOGIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
} = {}) {
  preseed(configDir, workDir);

  let authenticated = hasCredentials(configDir);
  let pendingLogin = null;

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
  });

  if (authenticated) cache.start();

  function clearPendingLogin() {
    if (pendingLogin?.idleTimer) clearTimeout(pendingLogin.idleTimer);
    pendingLogin = null;
  }

  function armIdleTimer() {
    return setTimeout(() => {
      pendingLogin?.session.close({ exitCommand: '/exit\r' }).catch(() => {});
      clearPendingLogin();
    }, LOGIN_IDLE_TIMEOUT_MS);
  }

  async function handleLoginStart() {
    if (pendingLogin?.session) {
      await pendingLogin.session.close({ exitCommand: '/exit\r' }).catch(() => {});
    }
    clearPendingLogin();

    const session = spawnSession();
    try {
      const { term, loginUrl } = await startLogin(session, loginOptions);
      pendingLogin = { session, term, loginUrl, status: 'awaiting-code', error: null };
      pendingLogin.idleTimer = armIdleTimer();
    } catch (err) {
      await session.close().catch(() => {});
      pendingLogin = { status: 'error', error: err.message };
    }
  }

  async function handleLoginCode(code) {
    if (!pendingLogin?.session || pendingLogin.status !== 'awaiting-code') {
      return { status: pendingLogin?.status ?? 'idle', error: pendingLogin?.error ?? null };
    }
    if (pendingLogin.idleTimer) clearTimeout(pendingLogin.idleTimer);
    pendingLogin.status = 'submitting';

    const result = await submitLoginCode(pendingLogin.session, pendingLogin.term, code, loginOptions);

    if (result.success) {
      await pendingLogin.session.close({ exitCommand: '/exit\r' }).catch(() => {});
      clearPendingLogin();
      authenticated = hasCredentials(configDir);
      if (authenticated) cache.start();
      return authenticated
        ? { status: 'success' }
        : { status: 'error', error: 'Login reported success but no credentials were written' };
    }

    pendingLogin.status = 'awaiting-code';
    pendingLogin.error = result.message;
    pendingLogin.idleTimer = armIdleTimer();
    return { status: 'awaiting-code', error: result.message, loginUrl: pendingLogin.loginUrl };
  }

  function loginState() {
    if (!pendingLogin) return { status: 'idle' };
    return { status: pendingLogin.status, loginUrl: pendingLogin.loginUrl, error: pendingLogin.error };
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = authenticated ? renderDashboard(cache.getState()) : renderLoginPage(loginState());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === '/api/usage') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }

      if (req.method === 'POST' && req.url === '/api/refresh') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        await cache.refresh();
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }

      if (req.method === 'GET' && req.url === '/api/login/state') {
        return sendJson(res, 200, { authenticated, ...loginState() });
      }

      if (req.method === 'POST' && req.url === '/api/login/start') {
        await handleLoginStart();
        return sendJson(res, 200, loginState());
      }

      if (req.method === 'POST' && req.url === '/api/login/code') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (!body.code) return sendJson(res, 400, { error: 'code is required' });
        const result = await handleLoginCode(body.code);
        return sendJson(res, 200, result);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return server;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS (5 tests)

If the usage-caching test is flaky, double-check the `FAST_SCRAPE_OPTIONS` values are actually threaded through — `scrapeOptions` must reach `scrapeUsagePanel(session, scrapeOptions)` inside `cache`'s injected `scrapeUsage`.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS (all suites, including the untouched `usageParser.test.js`, `ptySession.test.js`, `terminalBuffer.test.js`, `format.test.js`, `index.test.js`, `preseed.test.js`)

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: add HTTP server wiring usage cache, login flow, and views"
```

---

### Task 6: `bin/claude-usage-server.js` — container entrypoint script

**Files:**
- Create: `bin/claude-usage-server.js`
- Modify: `package.json` (add a `start` script)

**Interfaces:**
- Consumes: `createServer` from `src/server.js` (Task 5).
- Produces: an executable that Task 7's `docker/entrypoint.sh` execs directly.

- [ ] **Step 1: Write the script**

Create `bin/claude-usage-server.js`:

```js
#!/usr/bin/env node
import { createServer } from '../src/server.js';

if (!process.env.CLAUDE_CONFIG_DIR) {
  process.stderr.write('claude-usage-server: CLAUDE_CONFIG_DIR is not set\n');
  process.exit(1);
}

const port = Number(process.env.PORT) || 8080;
const server = createServer({
  configDir: process.env.CLAUDE_CONFIG_DIR,
  workDir: process.env.CLAUDE_USAGE_WORKDIR || process.cwd(),
  intervalMs: Number(process.env.USAGE_REFRESH_INTERVAL_MS) || 300000,
});

server.listen(port, () => {
  process.stdout.write(`claude-usage-server: listening on port ${port}\n`);
});
```

Make it executable:

```bash
chmod +x bin/claude-usage-server.js
```

- [ ] **Step 2: Add a `start` script to `package.json`**

Edit `package.json` — add `"start"` alongside the existing `"test"` script:

```json
  "scripts": {
    "test": "node --test",
    "start": "node bin/claude-usage-server.js"
  },
```

- [ ] **Step 3: Smoke-test it locally**

Run (from the repo root, with a scratch config dir so it doesn't touch a real session):

```bash
CLAUDE_CONFIG_DIR=/tmp/claude-usage-server-smoketest CLAUDE_USAGE_WORKDIR=$(pwd) PORT=8091 npm start &
sleep 1
curl -s http://127.0.0.1:8091/api/usage
kill %1
```

Expected: the `curl` returns `{"error":"not authenticated"}` with HTTP 503 (no real credentials in the scratch dir), and the server logs `claude-usage-server: listening on port 8091` before that.

- [ ] **Step 4: Commit**

```bash
git add bin/claude-usage-server.js package.json
git commit -m "feat: add container entrypoint script for the web server"
```

---

### Task 7: Docker wiring — single service, simplified entrypoint

**Files:**
- Modify: `Dockerfile`
- Modify: `docker/entrypoint.sh`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `bin/claude-usage-server.js` (Task 6).
- Produces: a single buildable/runnable container image and a one-service `docker-compose.yml`.

- [ ] **Step 1: Simplify `docker/entrypoint.sh`**

Replace the full contents of `docker/entrypoint.sh` with:

```sh
#!/bin/sh
set -eu

: "${CLAUDE_CONFIG_DIR:=/data}"
: "${CLAUDE_USAGE_WORKDIR:=/home/node/workspace}"
export CLAUDE_CONFIG_DIR CLAUDE_USAGE_WORKDIR

mkdir -p "$CLAUDE_CONFIG_DIR"

# Named volumes are created root:root on first use; hand off to the
# non-root user once ownership is fixed so nothing runs as root.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$CLAUDE_CONFIG_DIR"
  exec gosu node "$0" "$@"
fi

exec node /app/bin/claude-usage-server.js
```

(`preseed()` and the login/credentials branching both moved into `src/server.js` in Task 5 — this script's only remaining job is directory/ownership setup before handing off to the server.)

- [ ] **Step 2: Update `Dockerfile`**

Edit `Dockerfile` — change the `chmod` line to include the new script, and add `EXPOSE`:

```dockerfile
RUN chmod +x ./docker/entrypoint.sh ./bin/claude-usage.js ./bin/claude-usage-server.js
```

Add, right after the existing `VOLUME /data` line:

```dockerfile
EXPOSE 8080
```

- [ ] **Step 3: Replace `docker-compose.yml`**

Replace the full contents of `docker-compose.yml` with:

```yaml
# Convenience wrapper around `docker run` for the web dashboard container.
#
# Usage:
#   docker compose up --build
#
# First run: visit http://localhost:8080 and follow the on-page login flow
# — no docker exec or -it needed. Credentials persist in the named volume,
# so subsequent restarts skip straight to the dashboard.
#
# Copy .env.example to .env if you'd rather inject CLAUDE_CODE_OAUTH_TOKEN or
# ANTHROPIC_API_KEY instead of using the web login flow — .env is entirely
# optional otherwise.

services:
  app:
    build: .
    ports:
      - "${PORT:-8080}:8080"
    volumes:
      - claude-usage-data:/data
    environment:
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - USAGE_REFRESH_INTERVAL_MS=${USAGE_REFRESH_INTERVAL_MS:-300000}

volumes:
  claude-usage-data:
```

- [ ] **Step 4: Build the image to verify it still builds**

Run: `docker compose build`
Expected: build completes successfully (no errors from the Dockerfile/entrypoint changes).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker/entrypoint.sh docker-compose.yml
git commit -m "feat: collapse docker-compose to a single always-on web service"
```

---

### Task 8: Update docs (`.env.example`, `README.md`)

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Replace `.env.example`**

Replace the full contents of `.env.example` with:

```
# Copy this file to .env to customize the container, or to authenticate via
# a portable token or API key instead of the web login flow. Entirely
# optional — `docker compose up` works with just the default web login.

# Long-lived token from `claude setup-token` run elsewhere. Alternative to
# completing the web login flow inside this container.
CLAUDE_CODE_OAUTH_TOKEN=

# Alternative: direct Anthropic API key auth. Note the usage panel shows
# cost estimates rather than plan-percentage bars for API-key accounts.
ANTHROPIC_API_KEY=

# Host port to publish (the container always listens on 8080 internally).
PORT=8080

# How often (ms) the background scrape refreshes cached usage data.
USAGE_REFRESH_INTERVAL_MS=300000

# Rarely needed — these already default correctly inside the image.
# CLAUDE_CONFIG_DIR=/data
# CLAUDE_USAGE_WORKDIR=/home/node/workspace
```

- [ ] **Step 2: Replace `README.md`**

Replace the full contents of `README.md` with:

```markdown
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
| `/api/usage` | GET | Cached `UsageInfo` as JSON (see [Data model](#data-model)) plus `lastUpdatedAt`/`stale`/`error`. Returns `503` before authentication. This is the endpoint other tools/runners should poll. |
| `/api/refresh` | POST | Force an immediate re-scrape; returns the same shape as `/api/usage` |
| `/api/login/state` | GET | `{ authenticated, status, loginUrl?, error? }` |
| `/api/login/start` | POST | Begin the web-driven login flow |
| `/api/login/code` | POST | `{ "code": "..." }` — submit the pasted-back login code |

Usage data refreshes in the background every `USAGE_REFRESH_INTERVAL_MS`
(default 5 minutes); `/api/usage` and the dashboard always serve the cached
result instantly rather than triggering a scrape per request. Use the
dashboard's "Refresh now" button, or `POST /api/refresh`, to force an
immediate update.

If a background refresh fails (timeout, unrecognized panel), the cache
keeps the last good data and marks it `stale: true` with an `error` field,
rather than discarding known-good data.

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
| `PORT` | `8080` | Port the web server listens on inside the container |
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

### `src/htmlView.js`

```ts
renderDashboard(state: { data: UsageInfo | null, lastUpdatedAt: Date | null, stale: boolean, error: string | null }): string
renderLoginPage(loginState: { status: string, loginUrl?: string, error?: string }): string
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
and `test/fixtures/login-success-screen.txt` are real captured screens
(hand-captured, PII redacted) used to test the parsers/drivers without
needing a live login. If a future Claude Code release changes either
screen's rendered text, capture a fresh one the same way and update the
relevant fixture/regex.

Bumping the pinned `@anthropic-ai/claude-code` version in the Dockerfile:
update the version in both the `npm install -g` line and re-verify the
fixtures/parsers still match the new release's rendered output.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: update README and .env.example for the single-container dashboard"
```

---

### Task 9: Manual end-to-end verification

Not automated — a final checklist confirming the whole system works together against a real Claude Code login, since no automated test drives a real `claude` process.

- [ ] **Step 1: Fresh volume build and start**

```bash
docker volume rm claude-usage-data 2>/dev/null || true
docker compose up --build
```

Expected: container starts, logs `claude-usage-server: listening on port 8080`, no crash.

- [ ] **Step 2: Login walkthrough in a browser**

Visit `http://localhost:8080`. Expected: login page with a "Start login" button (not a dashboard).

Click "Start login". Expected: within a few seconds, a clickable authorization URL and a code-paste form appear.

Visit the URL, complete the OAuth authorization, copy the resulting code, paste it into the form, submit. Expected: the page redirects to the dashboard.

- [ ] **Step 3: Dashboard sanity check**

Expected on the dashboard: usage bars with plausible percentages, a "Last updated" timestamp, no stale-data warning banner. Click "Refresh now" — expected: the button shows "Refreshing…" then the page reloads with an updated timestamp.

- [ ] **Step 4: JSON endpoint check**

```bash
curl -s http://localhost:8080/api/usage | jq .
```

Expected: valid JSON matching the `UsageInfo` + cache-metadata shape documented in the README, `stale: false`, `error: null`.

- [ ] **Step 5: Restart persistence check**

```bash
docker compose restart
```

Wait for it to come back up, then visit `http://localhost:8080` again. Expected: dashboard loads directly — no login page, since credentials persisted in the named volume.

- [ ] **Step 6: Report results**

Note any deviations from the expected results above back to the user before considering this plan complete. If the login screen's real text didn't match the fixtures/regexes captured in Task 3, fix `src/loginDriver.js`'s regex constants and recapture the fixtures now that the real behavior is known firsthand.
