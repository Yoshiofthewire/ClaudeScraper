import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/ptySession.js';

test('spawns a command, writes to it, and receives its output', async () => {
  const session = new PtySession('sh', ['-c', 'read line; echo "got:$line"']);
  let received = '';
  session.onData((chunk) => {
    received += chunk;
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  session.write('hello\r');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(received.includes('got:hello'), `expected "got:hello" in: ${received}`);
  await session.close();
});

test('close() ensures the child process is no longer running', async () => {
  const session = new PtySession('sh', ['-c', 'sleep 30']);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const pid = session.pid;
  await session.close({ timeoutMs: 500 });

  assert.throws(() => process.kill(pid, 0));
});
