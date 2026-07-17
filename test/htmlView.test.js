import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, renderLoginPage, renderSettings } from '../src/htmlView.js';

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
