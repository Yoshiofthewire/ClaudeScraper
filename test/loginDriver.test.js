import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLogin, submitLoginCode, URL_RE, SUCCESS_RE, METHOD_MENU_RE } from '../src/loginDriver.js';
import { TerminalBuffer } from '../src/terminalBuffer.js';

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

test('startLogin extracts the full URL from the OSC 8 hyperlink target when the visible label is hard-wrapped (real Claude Code behavior)', async () => {
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

  const fullUrl = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=ctt62gR9UAwl8J_jcVyF5TtPb9LY23hgjQaHE7lRGsc';
  // Real Claude Code prints the OAuth URL as an OSC 8 hyperlink whose visible
  // label it manually word-wraps to the terminal width itself -- inserting a
  // real \r\n and re-opening the hyperlink span on each line -- rather than
  // relying on the terminal's own auto-wrap (confirmed against a live pty
  // capture: no isWrapped soft-wrap is involved at all). The rendered label
  // below is deliberately cut off mid-parameter, exactly as observed live,
  // but the hyperlink target (`\x1b]8;id=...;<URI>\x07`) always carries the
  // complete URL, which is what startLogin must recover.
  const visibleFirstLine = fullUrl.slice(0, 60);
  const visibleSecondLine = fullUrl.slice(60, 90);
  session.emit(
    `\x1b]8;id=abc123;${fullUrl}\x07${visibleFirstLine}\x1b[39m\x1b]8;;\x07\r\r\n`
    + `\x1b]8;id=abc123;${fullUrl}\x07${visibleSecondLine}\x1b[39m\x1b]8;;\x07\r\r\n`,
  );

  const result = await resultPromise;
  assert.equal(result.loginUrl, fullUrl);
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

test('startLogin extracts the full, non-truncated URL from a real terminal-wrapped OAuth screen', async () => {
  // This fixture is a real captured 120-column screen (Task 9 manual E2E
  // testing) where the OAuth URL was long enough that the pty soft-wrapped
  // it across 4 screen rows. It's a plain screen dump (one row per line),
  // which loses xterm's isWrapped flag on capture, so to exercise the real
  // fix we replay it through an actual TerminalBuffer at the same 120 cols
  // startLogin uses and let xterm re-derive the wrapping itself: every row
  // boundary is written as a real line break (\r\n), except the OAuth URL's
  // own continuation rows, which are the only rows in this screen that are
  // both part of a "https://" run AND exactly fill the 120-column width —
  // those are joined with no separator so xterm performs a genuine soft
  // wrap on them, exactly as the real pty did.
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/login-url-wrapped-screen.txt'), 'utf8');
  const cols = 120;
  const rows = raw.split('\n');

  let payload = rows[0];
  let prevIsUrlFragment = /^https:\/\//.test(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i];
    const merge = prevIsUrlFragment && rows[i - 1].length === cols;
    payload += merge ? cur : `\r\n${cur}`;
    prevIsUrlFragment = merge || /^https:\/\//.test(cur);
  }

  const term = new TerminalBuffer({ cols, rows: 40 });
  await term.write(payload);

  // Sanity check: the fixture's own wrapped rows really are truncated
  // mid-parameter when read the old (getText()) way, reproducing the bug.
  const truncatedMatch = term.getText().match(URL_RE);
  assert.ok(truncatedMatch, 'expected a URL match even in the truncated getText() output');
  assert.ok(
    !truncatedMatch[1].includes('redirect_uri='),
    'expected the getText()-based match to be truncated before redirect_uri, reproducing the original bug',
  );

  const match = term.getUnwrappedText().match(URL_RE);
  assert.ok(match, 'expected getUnwrappedText() output to contain a matchable https:// URL');
  assert.ok(match[1].includes('redirect_uri='), 'expected the full URL to include the redirect_uri parameter');
  assert.ok(
    match[1].endsWith('state=ctt62gR9UAwl8J_jcVyF5TtPb9LY23hgjQaHE7lRGsc'),
    `expected the extracted URL to end with the full, non-truncated state parameter, got: ${match[1]}`,
  );
});
