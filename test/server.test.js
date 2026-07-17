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
const FAST_LOGIN_OPTIONS = { readyQuietMs: 20, readyTimeoutMs: 500, methodMenuQuietMs: 20, methodMenuTimeoutMs: 500, urlQuietMs: 20, urlTimeoutMs: 500, resultQuietMs: 20, resultTimeoutMs: 500 };
const FAST_HELLO_OPTIONS = { readyQuietMs: 20, readyTimeoutMs: 500, responseQuietMs: 20, responseTimeoutMs: 500 };
const METHOD_MENU_SCREEN = '  Select login method:\r\n\r\n  ❯ 1. Claude account with subscription\r\n';

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
      sessions[0].emit(METHOD_MENU_SCREEN);
      await waitUntil(() => sessions[0].writes.filter((w) => w === '\r').length === 1);
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
      await waitUntil(() => sessions[0].writes.includes('\x1b[200~123456\x1b[201~'));
      sessions[0].emit('Login successful\r\n');

      const codeRes = await codePromise;
      const codeBody = await codeRes.json();
      assert.equal(codeBody.status, 'success');

      const usageRes = await fetch(`${base}/api/usage`);
      assert.equal(usageRes.status, 200);
    },
  );
});

test('concurrent POST /api/login/start calls share one in-flight session', async () => {
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
      const p1 = fetch(`${base}/api/login/start`, { method: 'POST' });
      const p2 = fetch(`${base}/api/login/start`, { method: 'POST' });

      await waitUntil(() => sessions.length >= 1);
      // Give the second request a chance to be processed before we let the
      // first attempt resolve. If handleLoginStart weren't serialized, this
      // window is exactly where a second pty would get spawned.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sessions.length, 1, 'a second concurrent call must not spawn its own pty');

      sessions[0].emit('❯ ready\r\n');
      await waitUntil(() => sessions[0].writes.includes('/login\r'));
      sessions[0].emit(METHOD_MENU_SCREEN);
      await waitUntil(() => sessions[0].writes.filter((w) => w === '\r').length === 1);
      sessions[0].emit('Visit https://example.com/device to authorize\r\n');

      const [res1, res2] = await Promise.all([p1, p2]);
      const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

      assert.equal(sessions.length, 1, 'only one pty session should ever have been spawned');
      assert.equal(body1.status, 'awaiting-code');
      assert.equal(body2.status, 'awaiting-code');
      assert.equal(body1.loginUrl, 'https://example.com/device');
      assert.equal(body2.loginUrl, 'https://example.com/device');

      // Clean up the in-progress login so its idle timer doesn't keep the
      // process (and this test run) alive after the assertions are done.
      fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
      const codePromise = fetch(`${base}/api/login/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      });
      await waitUntil(() => sessions[0].writes.includes('\x1b[200~123456\x1b[201~'));
      sessions[0].emit('Login successful\r\n');
      const codeRes = await codePromise;
      const codeBody = await codeRes.json();
      assert.equal(codeBody.status, 'success');
    },
  );
});

test('login flow: a rejected submitLoginCode recovers to awaiting-code instead of getting stuck', async () => {
  const configDir = makeTmpConfigDir();
  const sessions = [];
  // Deliberately give submitLoginCode a very short timeout so the poll
  // genuinely times out (and rejects) when no recognized success/error
  // pattern is ever emitted after the code is written, exercising the real
  // rejection path instead of mocking it.
  const TIMEOUT_LOGIN_OPTIONS = { ...FAST_LOGIN_OPTIONS, resultQuietMs: 20, resultTimeoutMs: 100 };
  await withServer(
    {
      configDir,
      workDir: '/tmp',
      intervalMs: 60000,
      scrapeOptions: FAST_SCRAPE_OPTIONS,
      loginOptions: TIMEOUT_LOGIN_OPTIONS,
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
      sessions[0].emit(METHOD_MENU_SCREEN);
      await waitUntil(() => sessions[0].writes.filter((w) => w === '\r').length === 1);
      sessions[0].emit('Visit https://example.com/device to authorize\r\n');

      const startRes = await startPromise;
      const startBody = await startRes.json();
      assert.equal(startBody.status, 'awaiting-code');

      // Submit a code but never emit a recognized success/error pattern, so
      // submitLoginCode's internal pollUntil genuinely times out and rejects.
      const codeRes = await fetch(`${base}/api/login/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '111111' }),
      });
      await waitUntil(() => sessions[0].writes.includes('\x1b[200~111111\x1b[201~'));

      assert.equal(codeRes.status, 200, 'a rejected submitLoginCode must not surface as a 500');
      const codeBody = await codeRes.json();
      assert.equal(codeBody.status, 'awaiting-code');
      assert.ok(codeBody.error, 'error message should explain the failed detection');

      const stateRes = await fetch(`${base}/api/login/state`);
      const stateBody = await stateRes.json();
      assert.equal(stateBody.status, 'awaiting-code', 'server state must not be stuck at submitting');
      assert.ok(stateBody.error);

      // Bonus: the pty/session survived the failed attempt, so a second
      // submission on the same session still works.
      fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
      const retryPromise = fetch(`${base}/api/login/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '222222' }),
      });
      await waitUntil(() => sessions[0].writes.includes('\x1b[200~222222\x1b[201~'));
      sessions[0].emit('Login successful\r\n');
      const retryRes = await retryPromise;
      const retryBody = await retryRes.json();
      assert.equal(retryBody.status, 'success');
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

test('POST /api/refresh includes the plan field from settings', async () => {
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

      // Let the server's automatic background scrape (session index 0) complete
      // first, so /api/refresh below is guaranteed to force a fresh scrape
      // (session index 1) rather than piggyback on the still-in-flight one.
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

      const refreshPromise = fetch(`${base}/api/refresh`, { method: 'POST' });
      await waitUntil(() => sessions.length >= 2);
      sessions[1].emit('❯ ready\r\n');
      await waitUntil(() => sessions[1].writes.includes('/usage\r'));
      sessions[1].emit('Current session\n75% used\nResets 2pm\n');

      const res = await refreshPromise;
      const body = await res.json();
      assert.equal(body.plan, 'Pro');
      assert.equal(body.bars?.[0]?.pctUsed, 75);
    },
  );
});

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
