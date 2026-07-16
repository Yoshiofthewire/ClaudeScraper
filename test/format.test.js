import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHuman } from '../src/format.js';

test('formats a bar with its percentage and reset time', () => {
  const text = formatHuman({
    bars: [{ label: 'Current session', pctUsed: 36, resetsText: 'Resets 12:29pm (America/New_York)' }],
    characteristics: [],
  });
  assert.match(text, /Current session:\s*36% used\s*\(Resets 12:29pm \(America\/New_York\)\)/);
});

test('omits the reset time for a bar with no reset text', () => {
  const text = formatHuman({
    bars: [{ label: 'Current week (Fable)', pctUsed: 0, resetsText: null }],
    characteristics: [],
  });
  assert.match(text, /Current week \(Fable\):\s*0% used\s*$/m);
});

test('lists characteristics with their percentage and summary', () => {
  const text = formatHuman({
    bars: [],
    characteristics: [
      { pct: 84, summary: 'your usage came from subagent-heavy sessions', detail: 'ignored in summary line' },
    ],
  });
  assert.match(text, /84% your usage came from subagent-heavy sessions/);
});
