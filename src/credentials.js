import fs from 'node:fs';
import path from 'node:path';

export function hasCredentials(configDir) {
  return (
    fs.existsSync(path.join(configDir, '.credentials.json')) ||
    Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) ||
    Boolean(process.env.ANTHROPIC_API_KEY)
  );
}
