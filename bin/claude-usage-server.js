#!/usr/bin/env node
import { createServer } from '../src/server.js';

if (!process.env.CLAUDE_CONFIG_DIR) {
  process.stderr.write('claude-usage-server: CLAUDE_CONFIG_DIR is not set\n');
  process.exit(1);
}

const port = Number(process.env.PORT) || 8080;
const server = createServer({
  configDir: process.env.CLAUDE_CONFIG_DIR,
  workDir: process.env.CLAUDE_USAGE_WORKDIR || process.cwd(),
  intervalMs: Number(process.env.USAGE_REFRESH_INTERVAL_MS) || 300000,
});

server.listen(port, () => {
  process.stdout.write(`claude-usage-server: listening on port ${port}\n`);
});
