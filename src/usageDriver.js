import { TerminalBuffer } from './terminalBuffer.js';
import { parseUsage } from './usageParser.js';
import { pollUntil } from './pollUntil.js';

function looksLikeUsagePanel(text) {
  return /%\s*used/i.test(text);
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
