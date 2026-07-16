import { TerminalBuffer } from './terminalBuffer.js';
import { parseUsage } from './usageParser.js';

function looksLikeUsagePanel(text) {
  return /%\s*used/i.test(text);
}

function pollUntil(term, predicate, { quietMs, timeoutMs, intervalMs = 20 }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (term.msSinceLastWrite() >= quietMs && predicate(term.getText())) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for expected terminal state'));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

export async function scrapeUsage(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  stableQuietMs = 500,
  stableTimeoutMs = 20000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('/usage\r');

  await pollUntil(term, looksLikeUsagePanel, {
    quietMs: stableQuietMs,
    timeoutMs: stableTimeoutMs,
  });

  return parseUsage(term.getText());
}
