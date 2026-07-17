import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendHelloPrompt } from '../src/helloPromptDriver.js';

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

test('waits for the ready prompt, sends Hello, and resolves once the response goes quiet', async () => {
  const session = new ScriptedSession();
  const resultPromise = sendHelloPrompt(session, {
    readyQuietMs: 30,
    readyTimeoutMs: 500,
    responseQuietMs: 30,
    responseTimeoutMs: 500,
  });

  session.emit('❯ ready prompt\r\n');
  await waitUntil(() => session.writes.includes('Hello\r'));

  session.emit('Hello! How can I help you today?\r\n');

  await resultPromise;
  assert.equal(session.writes.includes('Hello\r'), true);
});

test('rejects if the ready prompt never settles before the timeout', async () => {
  const session = new ScriptedSession();
  const promise = sendHelloPrompt(session, {
    readyQuietMs: 20,
    readyTimeoutMs: 100,
    responseQuietMs: 20,
    responseTimeoutMs: 100,
  });

  // Keep writing so the terminal's quiet period is never satisfied.
  const interval = setInterval(() => session.emit('.'), 5);
  try {
    await assert.rejects(promise);
  } finally {
    clearInterval(interval);
  }
});

test('rejects if the response never settles before the timeout', async () => {
  const session = new ScriptedSession();
  const promise = sendHelloPrompt(session, {
    readyQuietMs: 20,
    readyTimeoutMs: 500,
    responseQuietMs: 80,
    responseTimeoutMs: 200,
  });

  session.emit('❯ ready\r\n');
  await waitUntil(() => session.writes.includes('Hello\r'));

  const interval = setInterval(() => session.emit('.'), 5);
  try {
    await assert.rejects(promise);
  } finally {
    clearInterval(interval);
  }
});
