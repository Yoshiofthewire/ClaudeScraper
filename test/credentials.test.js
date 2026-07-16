import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasCredentials } from '../src/credentials.js';

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-test-'));
}

test('false when no credentials file and no env vars', () => {
  const configDir = makeTmpConfigDir();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(hasCredentials(configDir), false);
});

test('true when .credentials.json exists', () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{}');
  assert.equal(hasCredentials(configDir), true);
});

test('true when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
  const configDir = makeTmpConfigDir();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-value';
  assert.equal(hasCredentials(configDir), true);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

test('true when ANTHROPIC_API_KEY is set', () => {
  const configDir = makeTmpConfigDir();
  process.env.ANTHROPIC_API_KEY = 'key-value';
  assert.equal(hasCredentials(configDir), true);
  delete process.env.ANTHROPIC_API_KEY;
});
