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
