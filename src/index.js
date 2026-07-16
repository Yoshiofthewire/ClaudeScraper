import { parseArgs } from 'node:util';
import { preseed } from './preseed.js';
import { PtySession } from './ptySession.js';
import { scrapeUsage } from './usageDriver.js';
import { formatHuman, formatJson } from './format.js';

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      raw: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '20000' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  return {
    json: values.json,
    raw: values.raw,
    timeoutMs: Number(values.timeout),
    help: values.help,
    version: values.version,
  };
}

export async function run({
  timeoutMs,
  json,
  raw,
  workDir = process.env.CLAUDE_USAGE_WORKDIR || process.cwd(),
  configDir = process.env.CLAUDE_CONFIG_DIR,
} = {}) {
  preseed(configDir, workDir);

  const session = new PtySession('claude', [], {
    cwd: workDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });

  try {
    const usage = await scrapeUsage(session, { stableTimeoutMs: timeoutMs });
    const output = raw ? usage.raw : json ? formatJson(usage) : formatHuman(usage);
    process.stdout.write(output + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`claude-usage: ${err.message}\n`);
    return 3;
  } finally {
    await session.close({ exitCommand: '/exit\r' });
  }
}
