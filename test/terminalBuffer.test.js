import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalBuffer } from '../src/terminalBuffer.js';

test('getText() returns written plain text', async () => {
  const buf = new TerminalBuffer({ cols: 40, rows: 5 });
  await buf.write('hello world\r\n');
  assert.ok(buf.getText().includes('hello world'));
});

test('getUnwrappedText() reconstructs a single long line that the terminal soft-wrapped, while getText() still shows it split', async () => {
  const buf = new TerminalBuffer({ cols: 20, rows: 10 });
  // No spaces, so this is genuinely one continuous run of text that exceeds
  // the 20-column width and forces the terminal's own line-wrapping (as
  // opposed to a real line break, which would use \r\n).
  const longLine = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234567890';
  await buf.write(longLine);

  const wrapped = buf.getText();
  assert.ok(wrapped.includes('\n'), 'expected getText() to split the wrapped line across rows');
  assert.ok(!wrapped.includes(longLine), 'expected getText() to NOT contain the unbroken original string');

  const unwrapped = buf.getUnwrappedText();
  assert.ok(unwrapped.includes(longLine), 'expected getUnwrappedText() to reconstruct the original unbroken string');
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
