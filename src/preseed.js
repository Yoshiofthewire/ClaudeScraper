import fs from 'node:fs';
import path from 'node:path';

export function preseed(configDir, workDir) {
  const configPath = path.join(configDir, '.claude.json');

  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  config.hasCompletedOnboarding = true;
  config.autoUpdates = false;
  config.bypassPermissionsModeAccepted = false;

  config.projects ??= {};
  config.projects[workDir] = {
    ...config.projects[workDir],
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    allowedTools: config.projects[workDir]?.allowedTools ?? [],
    disabledMcpjsonServers: config.projects[workDir]?.disabledMcpjsonServers ?? [],
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
