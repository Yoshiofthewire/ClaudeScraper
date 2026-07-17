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

test('a synchronously-throwing onReset does not corrupt data/stale/error state', async () => {
  let call = 0;
  const scrapes = [
    { bars: [{ label: 'Current session', pctUsed: 80, resetsText: null }], session: {}, characteristics: [], raw: '' },
    { bars: [{ label: 'Current session', pctUsed: 5, resetsText: null }], session: {}, characteristics: [], raw: '' },
  ];
  const cache = createUsageCache({
    scrapeUsage: async () => scrapes[call++],
    intervalMs: 10000,
    onReset: () => { throw new Error('sync boom'); },
  });

  await cache.refresh();
  await cache.refresh();

  // Give the deferred onReset()'s rejection a tick to be (safely) swallowed.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const state = cache.getState();
  assert.equal(state.data.bars[0].pctUsed, 5);
  assert.equal(state.stale, false);
  assert.equal(state.error, null);
});
