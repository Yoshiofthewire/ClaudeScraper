import { TerminalBuffer } from './terminalBuffer.js';
import { pollUntil } from './pollUntil.js';

export const URL_RE = /(https:\/\/\S+)/;
export const SUCCESS_RE = /(login successful|logged in|authentication successful)/i;
export const METHOD_MENU_RE = /select login method/i;
const ERROR_RE = /(invalid code|expired|login failed|try again)/i;

// Real Claude Code renders the OAuth URL as an OSC 8 terminal hyperlink
// (`ESC ] 8 ; params ; URI BEL`) and, independently, prints a *visible*
// label for it that it manually word-wraps to the terminal width itself
// (inserting real \r\n between segments and re-opening the hyperlink span
// on each line) rather than relying on the terminal's own auto-wrap. That
// means the visible label is genuinely split across hard line breaks, not
// terminal soft-wraps, so even TerminalBuffer#getUnwrappedText() (which
// only reconstructs xterm's own soft-wraps) can't recover it from the
// rendered screen alone. The hyperlink's URI parameter, however, always
// carries the complete, untruncated URL, so it's the reliable source of
// truth when present.
const OSC8_URL_RE = /\x1b\]8;[^;\x07]*;(https:\/\/[^\x07\x1b]*)\x07/;

function hasUrl(text) {
  return URL_RE.test(text);
}

function hasLoginMethodMenu(text) {
  return METHOD_MENU_RE.test(text);
}

function hasOutcome(text) {
  return SUCCESS_RE.test(text) || ERROR_RE.test(text);
}

function extractErrorLine(text) {
  const line = text.split('\n').find((l) => ERROR_RE.test(l));
  return line ? line.trim() : 'Login failed';
}

export async function startLogin(session, {
  readyQuietMs = 800,
  readyTimeoutMs = 15000,
  methodMenuQuietMs = 500,
  methodMenuTimeoutMs = 10000,
  urlQuietMs = 500,
  urlTimeoutMs = 20000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  let rawOutput = '';
  session.onData((chunk) => {
    rawOutput += chunk;
    term.write(chunk);
  });

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('/login\r');

  // Real Claude Code shows an intermediate "Select login method" menu with
  // option 1 ("Claude account with subscription") pre-selected. Confirm it
  // with Enter before the OAuth URL screen appears.
  await pollUntil(term, hasLoginMethodMenu, { quietMs: methodMenuQuietMs, timeoutMs: methodMenuTimeoutMs });

  session.write('\r');

  await pollUntil(term, hasUrl, { quietMs: urlQuietMs, timeoutMs: urlTimeoutMs });

  // Prefer the OSC 8 hyperlink target, which is never wrapped or truncated
  // (see OSC8_URL_RE above). Fall back to the rendered screen text for
  // terminals/output that don't carry a hyperlink escape sequence at all.
  const hyperlinkMatch = rawOutput.match(OSC8_URL_RE);
  if (hyperlinkMatch) {
    return { term, loginUrl: hyperlinkMatch[1] };
  }

  const match = term.getUnwrappedText().match(URL_RE);
  return { term, loginUrl: match[1] };
}

export async function submitLoginCode(session, term, code, {
  resultQuietMs = 500,
  resultTimeoutMs = 15000,
} = {}) {
  session.write(`${code}\r`);

  await pollUntil(term, hasOutcome, { quietMs: resultQuietMs, timeoutMs: resultTimeoutMs });

  const text = term.getText();
  if (SUCCESS_RE.test(text)) {
    return { success: true };
  }
  return { success: false, message: extractErrorLine(text) };
}
