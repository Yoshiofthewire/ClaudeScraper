import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preseed } from '../src/preseed.js';

function makeTmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preseed-test-'));
}

test('creates .claude.json with onboarding/trust flags when none exists', () => {
  const configDir = makeTmpConfigDir();
  preseed(configDir, '/work/dir');

  const written = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  assert.equal(written.hasCompletedOnboarding, true);
  assert.equal(written.autoUpdates, false);
  assert.equal(written.bypassPermissionsModeAccepted, false);
  assert.equal(written.projects['/work/dir'].hasTrustDialogAccepted, true);
});

test('preserves unrelated existing keys when merging', () => {
  const configDir = makeTmpConfigDir();
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ someUnrelatedSetting: 'keep-me' }),
  );

  preseed(configDir, '/work/dir');

  const written = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  assert.equal(written.someUnrelatedSetting, 'keep-me');
  assert.equal(written.hasCompletedOnboarding, true);
});

test('is idempotent across repeated calls', () => {
  const configDir = makeTmpConfigDir();
  preseed(configDir, '/work/dir');
  preseed(configDir, '/work/dir');

  const written = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  assert.equal(Object.keys(written.projects).length, 1);
  assert.equal(written.projects['/work/dir'].hasTrustDialogAccepted, true);
});
