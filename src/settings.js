import fs from 'node:fs';
import path from 'node:path';

const VALID_PLANS = ['Pro', 'Max', 'Max x20'];
const DEFAULT_SETTINGS = { plan: null, helloPromptOnReset: false };

function settingsPath(configDir) {
  return path.join(configDir, 'settings.json');
}

export function loadSettings(configDir) {
  try {
    const raw = fs.readFileSync(settingsPath(configDir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      plan: VALID_PLANS.includes(parsed.plan) ? parsed.plan : null,
      helloPromptOnReset: Boolean(parsed.helloPromptOnReset),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(configDir, patch) {
  if ('plan' in patch && patch.plan !== null && !VALID_PLANS.includes(patch.plan)) {
    throw new Error(`invalid plan: ${patch.plan}`);
  }
  const current = loadSettings(configDir);
  const next = { ...current, ...patch };
  fs.writeFileSync(settingsPath(configDir), JSON.stringify(next));
  return next;
}
