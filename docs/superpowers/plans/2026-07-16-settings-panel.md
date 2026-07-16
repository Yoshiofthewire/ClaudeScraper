# Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings panel, reachable only after authentication, with a persisted plan selector (Pro/Max/Max x20) surfaced via the API, a persisted "Hello prompt on reset" preference toggle, and a static mobile-pairing QR placeholder.

**Architecture:** A new `src/settings.js` module reads/writes `settings.json` in `configDir` (same directory as `.credentials.json`), following the existing filesystem-read pattern from `src/credentials.js`. `src/htmlView.js` gains a `renderSettings()` pure-render function alongside the existing `renderDashboard`/`renderLoginPage`. `src/server.js` wires three new routes (`GET /settings`, `GET /api/settings`, `POST /api/settings`) and merges a `plan` field into the existing `/api/usage` and `/api/refresh` responses.

**Tech Stack:** Node.js (ESM, `"type": "module"`), Node's built-in `http` module (no framework), Node's built-in test runner (`node --test`) with `node:assert/strict`, server-rendered HTML with inline vanilla JS (no build step, no client framework).

## Global Constraints

- No new dependencies — Node stdlib only, consistent with the project's existing "no new web framework" constraint.
- ESM syntax throughout (`import`/`export`), matching every existing file in `src/`.
- All dynamic text interpolated into HTML must go through `htmlView.js`'s existing `escapeHtml()` helper.
- Settings persist as `settings.json` in `configDir`, mirroring how `.credentials.json` already persists there.
- Valid `plan` values are exactly `null`, `"Pro"`, `"Max"`, `"Max x20"` — anything else is rejected.
- A missing or corrupt `settings.json` must read back as defaults (`{ plan: null, helloPromptOnReset: false }`), never throw.
- Tests use the existing patterns: `fs.mkdtempSync(path.join(os.tmpdir(), '<name>-test-'))` for tmp config dirs (`credentials.test.js`), and `withServer`/`ScriptedSession`/`waitUntil` helpers already defined in `test/server.test.js` for server tests.

---

### Task 1: `src/settings.js` — load/save settings

**Files:**
- Create: `src/settings.js`
- Test: `test/settings.test.js`

**Interfaces:**
- Produces: `loadSettings(configDir: string): { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }`
- Produces: `saveSettings(configDir: string, patch: { plan?: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset?: boolean }): { plan, helloPromptOnReset }` — throws `Error('invalid plan: <value>')` if `patch.plan` is present, non-null, and not one of `'Pro' | 'Max' | 'Max x20'`. Does not write to disk when it throws.

- [ ] **Step 1: Write the failing tests**

Create `test/settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings } from '../src/settings.js';

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
}

test('loadSettings returns defaults when no file exists', () => {
  const configDir = makeTmpConfigDir();
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});

test('saveSettings persists a plan and helloPromptOnReset, loadSettings reads them back', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Max', helloPromptOnReset: true });
  assert.deepEqual(loadSettings(configDir), { plan: 'Max', helloPromptOnReset: true });
});

test('saveSettings merges a partial patch onto existing settings', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Pro' });
  saveSettings(configDir, { helloPromptOnReset: true });
  assert.deepEqual(loadSettings(configDir), { plan: 'Pro', helloPromptOnReset: true });
});

test('loadSettings falls back to defaults when settings.json is corrupt', () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{not valid json');
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});

test('saveSettings rejects an invalid plan value and leaves stored settings untouched', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Pro' });
  assert.throws(() => saveSettings(configDir, { plan: 'Ultra' }), /invalid plan/);
  assert.deepEqual(loadSettings(configDir), { plan: 'Pro', helloPromptOnReset: false });
});

test('saveSettings accepts plan: null to clear a previously set plan', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Max x20' });
  saveSettings(configDir, { plan: null });
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/settings.test.js`
Expected: FAIL — `Cannot find module '../src/settings.js'`

- [ ] **Step 3: Write the implementation**

Create `src/settings.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

const VALID_PLANS = ['Pro', 'Max', 'Max x20'];
const DEFAULT_SETTINGS = { plan: null, helloPromptOnReset: false };

function settingsPath(configDir) {
  return path.join(configDir, 'settings.json');
}

export function loadSettings(configDir) {
  try {
    const raw = fs.readFileSync(settingsPath(configDir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      plan: VALID_PLANS.includes(parsed.plan) ? parsed.plan : null,
      helloPromptOnReset: Boolean(parsed.helloPromptOnReset),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(configDir, patch) {
  if ('plan' in patch && patch.plan !== null && !VALID_PLANS.includes(patch.plan)) {
    throw new Error(`invalid plan: ${patch.plan}`);
  }
  const current = loadSettings(configDir);
  const next = { ...current, ...patch };
  fs.writeFileSync(settingsPath(configDir), JSON.stringify(next));
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/settings.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/settings.js test/settings.test.js
git commit -m "feat: add settings load/save module"
```

---

### Task 2: `renderSettings` view + Settings link on the dashboard

**Files:**
- Modify: `src/htmlView.js`
- Test: `test/htmlView.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 (pure render function, takes a plain settings object).
- Produces: `renderSettings(settings: { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }): string`

- [ ] **Step 1: Write the failing tests**

Add to `test/htmlView.test.js` (new import plus new tests — append to the existing file, extend the import line):

```js
import { renderDashboard, renderLoginPage, renderSettings } from '../src/htmlView.js';
```

Append these tests at the end of the file:

```js
test('renderSettings shows plan options with the current plan checked', () => {
  const html = renderSettings({ plan: 'Max', helloPromptOnReset: false });
  assert.match(html, /value="Pro"/);
  assert.match(html, /value="Max x20"/);
  assert.match(html, /value="Max"[^>]*checked/);
});

test('renderSettings shows the hello-prompt toggle checked when enabled', () => {
  const html = renderSettings({ plan: null, helloPromptOnReset: true });
  assert.match(html, /id="hello-prompt-toggle"[^>]*checked/);
});

test('renderSettings shows the hello-prompt toggle unchecked when disabled', () => {
  const html = renderSettings({ plan: null, helloPromptOnReset: false });
  assert.doesNotMatch(html, /id="hello-prompt-toggle"[^>]*checked/);
});

test('renderSettings shows the mobile pairing QR placeholder', () => {
  const html = renderSettings({ plan: null, helloPromptOnReset: false });
  assert.match(html, /QR code coming soon/);
});

test('renderSettings has a link back to the dashboard', () => {
  const html = renderSettings({ plan: null, helloPromptOnReset: false });
  assert.match(html, /href="\/"/);
});

test('renderDashboard includes a Settings link before the first scrape', () => {
  const html = renderDashboard({ data: null, lastUpdatedAt: null, stale: false, error: null });
  assert.match(html, /href="\/settings"/);
});

test('renderDashboard includes a Settings link once data is present', () => {
  const html = renderDashboard({
    data: { bars: [], session: {}, characteristics: [], raw: '' },
    lastUpdatedAt: new Date(),
    stale: false,
    error: null,
  });
  assert.match(html, /href="\/settings"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/htmlView.test.js`
Expected: FAIL — `renderSettings is not a function`, plus the two new dashboard assertions fail (no `/settings` link yet)

- [ ] **Step 3: Write the implementation**

In `src/htmlView.js`, add CSS rules inside the existing `<style>` block in `renderPage` (insert right after the `a { color: #2563eb; word-break: break-all; }` line):

```css
  .header-actions { display: flex; align-items: center; gap: 0.75rem; }
  .plan-options { display: flex; gap: 1rem; margin-top: 0.5rem; }
  .plan-option { display: flex; align-items: center; gap: 0.35rem; font-size: 0.9rem; }
  .qr-placeholder { border: 1px dashed #d1d5db; border-radius: 8px; padding: 2rem; text-align: center; color: #6b7280; font-size: 0.85rem; margin-top: 0.5rem; }
```

Update `renderDashboard`'s no-data branch to add a header row with a Settings link:

```js
  if (!data) {
    return renderPage('Claude Usage', `
      <div class="card">
        <div class="header-row">
          <h1>Claude Usage</h1>
          <a href="/settings">Settings</a>
        </div>
        <p class="muted">Waiting for the first scrape to complete…</p>
        ${error ? `<div class="banner banner-error">${escapeHtml(error)}</div>` : ''}
      </div>
      <script>setTimeout(() => location.reload(), 3000);</script>
    `);
  }
```

Update `renderDashboard`'s main header row to add the Settings link next to "Refresh now":

```js
      <div class="header-row">
        <h1>Claude Usage</h1>
        <div class="header-actions">
          <a href="/settings">Settings</a>
          <button id="refresh-btn" onclick="refresh()">Refresh now</button>
        </div>
      </div>
```

Add the new `renderSettings` export at the end of `src/htmlView.js`:

```js
const PLAN_OPTIONS = ['Pro', 'Max', 'Max x20'];

export function renderSettings(settings) {
  const { plan, helloPromptOnReset } = settings;

  const planRadios = PLAN_OPTIONS.map((p) => `
    <label class="plan-option">
      <input type="radio" name="plan" value="${escapeHtml(p)}" ${plan === p ? 'checked' : ''} onchange="setPlan('${escapeHtml(p)}')" />
      ${escapeHtml(p)}
    </label>
  `).join('');

  return renderPage('Claude Usage — Settings', `
    <div class="card">
      <div class="header-row">
        <h1>Settings</h1>
        <a href="/">Back to dashboard</a>
      </div>

      <div class="section">
        <h2>Plan</h2>
        <div class="plan-options">${planRadios}</div>
      </div>

      <div class="section">
        <h2>Hello prompt on reset</h2>
        <label>
          <input type="checkbox" id="hello-prompt-toggle" ${helloPromptOnReset ? 'checked' : ''} onchange="setHelloPrompt(this.checked)" />
          Send a "Hello" prompt after every usage-window reset
        </label>
        <p class="muted small">Saves your preference — automatic sending isn't wired up yet.</p>
      </div>

      <div class="section">
        <h2>Pair a mobile app</h2>
        <div class="qr-placeholder">QR code coming soon</div>
      </div>
    </div>
    <script>
      async function setPlan(plan) {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        });
      }
      async function setHelloPrompt(helloPromptOnReset) {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ helloPromptOnReset }),
        });
      }
    </script>
  `);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/htmlView.test.js`
Expected: PASS (all tests, including the new ones)

- [ ] **Step 5: Commit**

```bash
git add src/htmlView.js test/htmlView.test.js
git commit -m "feat: add settings page view and dashboard Settings link"
```

---

### Task 3: Wire settings routes into `src/server.js`

**Files:**
- Modify: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `loadSettings`, `saveSettings` from `src/settings.js` (Task 1); `renderSettings` from `src/htmlView.js` (Task 2).
- Produces: `GET /settings` (302 to `/` if unauthenticated, else 200 HTML), `GET /api/settings` (200 JSON), `POST /api/settings` (200 JSON on success, 400 JSON on invalid plan); `plan` field added to `GET /api/usage` and `POST /api/refresh` response bodies.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js` (append at the end of the file, after the existing last test):

```js
test('GET /settings redirects to / when not authenticated', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/settings`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
    },
  );
});

test('GET /settings renders the settings page when authenticated', async () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, scrapeOptions: FAST_SCRAPE_OPTIONS, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/settings`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /QR code coming soon/);
    },
  );
});

test('GET /api/settings returns defaults when nothing saved yet', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/api/settings`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { plan: null, helloPromptOnReset: false });
    },
  );
});

test('POST /api/settings persists a plan, GET /api/settings reflects it', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const postRes = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'Max', helloPromptOnReset: true }),
      });
      assert.equal(postRes.status, 200);
      assert.deepEqual(await postRes.json(), { plan: 'Max', helloPromptOnReset: true });

      const getRes = await fetch(`${base}/api/settings`);
      assert.deepEqual(await getRes.json(), { plan: 'Max', helloPromptOnReset: true });
    },
  );
});

test('POST /api/settings rejects an invalid plan with 400', async () => {
  const configDir = makeTmpConfigDir();
  await withServer(
    { configDir, workDir: '/tmp', intervalMs: 60000, spawnSession: () => new ScriptedSession() },
    async (base) => {
      const res = await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'Ultra' }),
      });
      assert.equal(res.status, 400);
    },
  );
});

test('GET /api/usage includes the plan field from settings', async () => {
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
      await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'Pro' }),
      });

      await waitUntil(() => sessions.length >= 1);
      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/usage\r'));
      sessions[0].emit('Current session\n50% used\nResets 1pm\n');

      let plan;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const res = await fetch(`${base}/api/usage`);
        const body = await res.json();
        plan = body.plan;
        if (body.bars?.[0]?.pctUsed === 50) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(plan, 'Pro');
    },
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `/settings`/`/api/settings` return 404, and the `plan` field is `undefined` in the `/api/usage` test

- [ ] **Step 3: Write the implementation**

In `src/server.js`, add the new imports at the top (alongside the existing `import { renderDashboard, renderLoginPage } from './htmlView.js';` line, extend it, and add a new import line):

```js
import { renderDashboard, renderLoginPage, renderSettings } from './htmlView.js';
import { loadSettings, saveSettings } from './settings.js';
```

Modify the `GET /api/usage` handler to merge in `plan`:

```js
      if (req.method === 'GET' && req.url === '/api/usage') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, plan: loadSettings(configDir).plan, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }
```

Modify the `POST /api/refresh` handler the same way:

```js
      if (req.method === 'POST' && req.url === '/api/refresh') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        await cache.refresh();
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, plan: loadSettings(configDir).plan, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }
```

Add the three new routes right after the existing `POST /api/login/code` block and before the `404` fallback:

```js
      if (req.method === 'GET' && req.url === '/settings') {
        if (!authenticated) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        const html = renderSettings(loadSettings(configDir));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === '/api/settings') {
        return sendJson(res, 200, loadSettings(configDir));
      }

      if (req.method === 'POST' && req.url === '/api/settings') {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const updated = saveSettings(configDir, body);
          return sendJson(res, 200, updated);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/server.test.js`
Expected: PASS (all tests, including the new ones)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all test files, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: wire settings routes into the server, merge plan into /api/usage"
```

---

### Task 4: Update docs

**Files:**
- Modify: `README.md`
- Modify: `docs/API.md`

**Interfaces:**
- Consumes: the final route/response shapes from Task 3 (no code interfaces — this task only changes documentation).

- [ ] **Step 1: Update `README.md`'s routes table**

In the "Web dashboard & JSON endpoint" section, replace the existing table:

```markdown
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
```

- [ ] **Step 2: Add a Settings section to `README.md`**

Insert a new section right after the "Web dashboard & JSON endpoint" section (before "## One-shot CLI (still available)"):

```markdown
## Settings

Visit **`/settings`** (linked from the dashboard header) once authenticated to
manage:

- **Plan** — which Claude subscription tier the account is on (`Pro`, `Max`,
  or `Max x20`). Claude Code doesn't expose this itself, so it's recorded
  here and merged into `/api/usage`'s response as a `plan` field, for
  consumers that want it as context alongside the usage bars.
- **Hello prompt on reset** — a toggle to record a preference for sending a
  "Hello" prompt after every usage-window reset. Currently a stored
  preference only — the automatic sending isn't wired up yet.
- **Pair a mobile app** — a placeholder for a future mobile pairing QR code.

Settings persist in `settings.json` in the same `CLAUDE_CONFIG_DIR`-mounted
volume as credentials, so they survive container restarts.
```

- [ ] **Step 3: Update `README.md`'s Module API section**

In the `### src/htmlView.js` block, update the code fence to add `renderSettings`:

```ts
renderDashboard(state: { data: UsageInfo | null, lastUpdatedAt: Date | null, stale: boolean, error: string | null }): string
renderLoginPage(loginState: { status: string, loginUrl?: string, error?: string }): string
renderSettings(settings: { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }): string
```

Add a new subsection right after `### src/credentials.js` and before `### src/htmlView.js`:

```markdown
### `src/settings.js`

```ts
loadSettings(configDir: string): { plan: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset: boolean }
saveSettings(configDir: string, patch: { plan?: 'Pro' | 'Max' | 'Max x20' | null, helloPromptOnReset?: boolean }): same shape, throws if `patch.plan` isn't a valid plan value
```
Reads/writes `settings.json` in `configDir`, the same directory
`.credentials.json` lives in. A missing or corrupt file reads back as
defaults (`{ plan: null, helloPromptOnReset: false }`).
```

- [ ] **Step 4: Update `docs/API.md`**

Update the `GET /api/usage` **200 response body** example to add `"plan"`:

```jsonc
{
  "plan": "Max",
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

Add a row to the field table right before the `bars` row:

```markdown
| `plan` | string \| null | The account's plan tier as recorded in `/settings` (`"Pro"`, `"Max"`, `"Max x20"`), or `null` if never set. Not scraped — user-recorded metadata. |
```

Add two new sections after `## POST /api/login/code` and before `## GET /`:

```markdown
## GET /api/settings

Returns the currently saved settings.

```jsonc
{ "plan": "Max", "helloPromptOnReset": false }
```

```sh
curl http://localhost:8080/api/settings
```

## POST /api/settings

Updates one or both settings fields. Partial bodies are merged onto the
existing saved settings.

**Request body**

```json
{ "plan": "Max", "helloPromptOnReset": true }
```

**Status codes**

| Status | Meaning |
|--------|---------|
| `200` | Updated settings, same shape as `GET /api/settings` |
| `400` | `plan` present and not one of `null`, `"Pro"`, `"Max"`, `"Max x20"` |

```sh
curl -X POST http://localhost:8080/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"plan":"Max"}'
```
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/API.md
git commit -m "docs: document the settings panel and plan field"
```
