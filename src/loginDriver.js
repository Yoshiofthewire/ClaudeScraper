import { TerminalBuffer } from './terminalBuffer.js';
import { pollUntil } from './pollUntil.js';

export const URL_RE = /(https:\/\/\S+)/;
export const SUCCESS_RE = /(login successful|logged in|authentication successful)/i;
const ERROR_RE = /(invalid code|expired|login failed|try again)/i;

function hasUrl(text) {
  return URL_RE.test(text);
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
  urlQuietMs = 500,
  urlTimeoutMs = 20000,
} = {}) {
  const term = new TerminalBuffer({ cols: 120, rows: 40 });
  session.onData((chunk) => term.write(chunk));

  await pollUntil(term, () => true, { quietMs: readyQuietMs, timeoutMs: readyTimeoutMs });

  session.write('/login\r');

  await pollUntil(term, hasUrl, { quietMs: urlQuietMs, timeoutMs: urlTimeoutMs });

  const match = term.getText().match(URL_RE);
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
