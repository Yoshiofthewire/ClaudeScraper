import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectReset } from '../src/resetDetector.js';

test('returns false when there is no previous data', () => {
  assert.equal(
    detectReset(null, [{ label: 'Current session', pctUsed: 10, resetsText: null }]),
    false,
  );
});

test('returns false when no bar decreased', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 20, resetsText: null }];
  assert.equal(detectReset(previous, next), false);
});

test('returns false when a bar stays the same', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  assert.equal(detectReset(previous, next), false);
});

test('returns true when a bar decreased', () => {
  const previous = [{ label: 'Current session', pctUsed: 80, resetsText: null }];
  const next = [{ label: 'Current session', pctUsed: 5, resetsText: null }];
  assert.equal(detectReset(previous, next), true);
});

test('does not treat a newly-appearing label as a reset', () => {
  const previous = [{ label: 'Current session', pctUsed: 10, resetsText: null }];
  const next = [
    { label: 'Current session', pctUsed: 20, resetsText: null },
    { label: 'Current week (Fable)', pctUsed: 3, resetsText: null },
  ];
  assert.equal(detectReset(previous, next), false);
});

test('returns true when only one of several bars decreased', () => {
  const previous = [
    { label: 'Current session', pctUsed: 40, resetsText: null },
    { label: 'Current week (all models)', pctUsed: 60, resetsText: null },
  ];
  const next = [
    { label: 'Current session', pctUsed: 45, resetsText: null },
    { label: 'Current week (all models)', pctUsed: 2, resetsText: null },
  ];
  assert.equal(detectReset(previous, next), true);
});
