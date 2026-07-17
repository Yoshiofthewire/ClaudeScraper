import { TerminalBuffer } from './terminalBuffer.js';
import { pollUntil } from './pollUntil.js';

export async function sendHelloPrompt(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  responseQuietMs = 2000,
  responseTimeoutMs = 30000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('Hello\r');

  await pollUntil(term, () => true, { quietMs: responseQuietMs, timeoutMs: responseTimeoutMs });
}
