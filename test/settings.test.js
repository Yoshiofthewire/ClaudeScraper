import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, saveSettings } from '../src/settings.js';

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
}

test('loadSettings returns defaults when no file exists', () => {
  const configDir = makeTmpConfigDir();
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});

test('saveSettings persists a plan and helloPromptOnReset, loadSettings reads them back', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Max', helloPromptOnReset: true });
  assert.deepEqual(loadSettings(configDir), { plan: 'Max', helloPromptOnReset: true });
});

test('saveSettings merges a partial patch onto existing settings', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Pro' });
  saveSettings(configDir, { helloPromptOnReset: true });
  assert.deepEqual(loadSettings(configDir), { plan: 'Pro', helloPromptOnReset: true });
});

test('loadSettings falls back to defaults when settings.json is corrupt', () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(path.join(configDir, 'settings.json'), '{not valid json');
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});

test('saveSettings rejects an invalid plan value and leaves stored settings untouched', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Pro' });
  assert.throws(() => saveSettings(configDir, { plan: 'Ultra' }), /invalid plan/);
  assert.deepEqual(loadSettings(configDir), { plan: 'Pro', helloPromptOnReset: false });
});

test('saveSettings accepts plan: null to clear a previously set plan', () => {
  const configDir = makeTmpConfigDir();
  saveSettings(configDir, { plan: 'Max x20' });
  saveSettings(configDir, { plan: null });
  assert.deepEqual(loadSettings(configDir), { plan: null, helloPromptOnReset: false });
});
