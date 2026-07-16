import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/index.js';

test('defaults to human output with the default timeout', () => {
  const opts = parseCliArgs([]);
  assert.equal(opts.json, false);
  assert.equal(opts.raw, false);
  assert.equal(opts.timeoutMs, 20000);
  assert.equal(opts.help, false);
  assert.equal(opts.version, false);
});

test('parses --json', () => {
  assert.equal(parseCliArgs(['--json']).json, true);
});

test('parses --raw', () => {
  assert.equal(parseCliArgs(['--raw']).raw, true);
});

test('parses --timeout as a number of milliseconds', () => {
  assert.equal(parseCliArgs(['--timeout', '5000']).timeoutMs, 5000);
});

test('parses -h/--help and -v/--version', () => {
  assert.equal(parseCliArgs(['-h']).help, true);
  assert.equal(parseCliArgs(['--help']).help, true);
  assert.equal(parseCliArgs(['-v']).version, true);
  assert.equal(parseCliArgs(['--version']).version, true);
});
