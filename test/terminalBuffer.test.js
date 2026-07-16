import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalBuffer } from '../src/terminalBuffer.js';

test('getText() returns written plain text', async () => {
  const buf = new TerminalBuffer({ cols: 40, rows: 5 });
  await buf.write('hello world\r\n');
  assert.ok(buf.getText().includes('hello world'));
});

test('waitQuiet() resolves only after the quiet period has elapsed since the last write', async () => {
  const buf = new TerminalBuffer({ cols: 40, rows: 5 });
  await buf.write('a');
  const start = Date.now();
  await buf.waitQuiet(50, 1000);
  assert.ok(Date.now() - start >= 50);
});

test('msSinceLastWrite() reflects elapsed time since the last write', async () => {
  const buf = new TerminalBuffer({ cols: 40, rows: 5 });
  await buf.write('a');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(buf.msSinceLastWrite() >= 60);
});

test('waitQuiet() rejects if writes never stop before the overall timeout', async () => {
  const buf = new TerminalBuffer({ cols: 40, rows: 5 });
  const iv = setInterval(() => buf.write('x'), 10);
  try {
    await assert.rejects(() => buf.waitQuiet(50, 150));
  } finally {
    clearInterval(iv);
  }
});
