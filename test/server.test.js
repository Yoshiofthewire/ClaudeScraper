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
      await waitUntil(() => sessions[0].writes.includes('123456\r'));
      sessions[0].emit('Login successful\r\n');
      const codeRes = await codePromise;
      const codeBody = await codeRes.json();
      assert.equal(codeBody.status, 'success');
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
