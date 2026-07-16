import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLogin, submitLoginCode, URL_RE, SUCCESS_RE, METHOD_MENU_RE } from '../src/loginDriver.js';

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

const METHOD_MENU_SCREEN = [
  '  Login',
  '',
  '  Select login method:',
  '',
  '  ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
  '    2. Anthropic Console account · API usage billing',
  '',
].join('\r\n');

test('startLogin waits for the ready prompt, sends /login, confirms the method menu, and extracts the URL', async () => {
  const session = new ScriptedSession();
  const resultPromise = startLogin(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    methodMenuQuietMs: 30,
    methodMenuTimeoutMs: 500,
    urlQuietMs: 30,
    urlTimeoutMs: 500,
  });

  session.emit('❯ ready prompt\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));

  session.emit(METHOD_MENU_SCREEN);
  await waitUntil(() => session.writes.filter((w) => w === '\r').length === 1);

  session.emit('Visit https://example.com/device?code=abc123 to authorize\r\n');

  const result = await resultPromise;
  assert.equal(result.loginUrl, 'https://example.com/device?code=abc123');
  assert.deepEqual(session.writes, ['/login\r', '\r']);
});

test('submitLoginCode: full flow from URL to a successful code', async () => {
  const session = new ScriptedSession();
  const startPromise = startLogin(session, {
    readyQuietMs: 20, readyTimeoutMs: 500,
    methodMenuQuietMs: 20, methodMenuTimeoutMs: 500,
    urlQuietMs: 20, urlTimeoutMs: 500,
  });
  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));
  session.emit(METHOD_MENU_SCREEN);
  await waitUntil(() => session.writes.filter((w) => w === '\r').length === 1);
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
    readyQuietMs: 20, readyTimeoutMs: 500,
    methodMenuQuietMs: 20, methodMenuTimeoutMs: 500,
    urlQuietMs: 20, urlTimeoutMs: 500,
  });
  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('/login\r'));
  session.emit(METHOD_MENU_SCREEN);
  await waitUntil(() => session.writes.filter((w) => w === '\r').length === 1);
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
  const match = text.match(URL_RE);
  assert.ok(match, 'expected the real login fixture to contain a matchable https:// URL');
});

test('submitLoginCode recognizes success in the real captured fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/login-success-screen.txt'), 'utf8');
  assert.match(text, SUCCESS_RE);
});

test('startLogin recognizes the login method menu in the real captured fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/login-method-menu-screen.txt'), 'utf8');
  assert.match(text, METHOD_MENU_RE);
});
