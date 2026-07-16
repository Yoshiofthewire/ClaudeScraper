import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeUsage } from '../src/usageDriver.js';

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

test('waits for the ready prompt, sends /usage, and returns the parsed panel', async () => {
  const session = new ScriptedSession();
  const resultPromise = scrapeUsage(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    stableQuietMs: 30,
    stableTimeoutMs: 500,
  });

  session.emit('❯ ready prompt\r\n');
  await waitUntil(() => session.writes.includes('/usage\r'));

  session.emit('Current session\n50% used\nResets 1pm\n');

  const result = await resultPromise;
  assert.equal(result.bars[0].pctUsed, 50);
});

test('does not mistake a promo banner mentioning "%" and "weekly" for the usage panel', async () => {
  const session = new ScriptedSession();
  const resultPromise = scrapeUsage(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    stableQuietMs: 30,
    stableTimeoutMs: 300,
  });

  // banner text is already on screen and stays put after /usage is sent
  session.emit(
    "We're keeping Claude Code's weekly rate limits 50% higher through July 19.\r\n",
  );
  await waitUntil(() => session.writes.includes('/usage\r'));

  await assert.rejects(resultPromise);
});

test('rejects if the usage panel never renders before the timeout', async () => {
  const session = new ScriptedSession();
  const promise = scrapeUsage(session, {
    readyQuietMs: 20,
    readyTimeoutMs: 200,
    stableQuietMs: 20,
    stableTimeoutMs: 150,
  });

  session.emit('❯ ready\r\n');

  await assert.rejects(promise);
});
