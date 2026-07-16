import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUsage } from '../src/usageParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subscriptionFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures/usage-subscription.txt'),
  'utf8',
);

test('parses the "Current session" bar percentage and reset text', () => {
  const result = parseUsage(subscriptionFixture);
  const session = result.bars.find((b) => b.label === 'Current session');
  assert.equal(session.pctUsed, 33);
  assert.equal(session.resetsText, 'Resets 12:30pm (America/New_York)');
});

test('parses the weekly all-models bar', () => {
  const result = parseUsage(subscriptionFixture);
  const week = result.bars.find((b) => b.label === 'Current week (all models)');
  assert.equal(week.pctUsed, 6);
  assert.equal(week.resetsText, 'Resets Jul 21, 9am (America/New_York)');
});

test('parses a per-model bar with no reset line as null resetsText', () => {
  const result = parseUsage(subscriptionFixture);
  const fable = result.bars.find((b) => b.label === 'Current week (Fable)');
  assert.equal(fable.pctUsed, 0);
  assert.equal(fable.resetsText, null);
});

test('parses the session cost/duration block', () => {
  const result = parseUsage(subscriptionFixture);
  assert.equal(result.session.totalCostUsd, 0);
  assert.equal(result.session.apiDuration, '0s');
  assert.equal(result.session.wallDuration, '1s');
});

test('parses "contributing to your limits" characteristics', () => {
  const result = parseUsage(subscriptionFixture);
  assert.equal(result.characteristics.length, 3);
  assert.equal(result.characteristics[0].pct, 84);
  assert.equal(
    result.characteristics[0].summary,
    'your usage came from subagent-heavy sessions',
  );
});

test('tolerates unrecognized text without throwing', () => {
  const result = parseUsage('some future Claude Code UI we have never seen');
  assert.deepEqual(result.bars, []);
  assert.deepEqual(result.characteristics, []);
  assert.equal(result.raw, 'some future Claude Code UI we have never seen');
});
