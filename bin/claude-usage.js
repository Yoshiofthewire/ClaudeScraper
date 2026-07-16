#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseCliArgs, run } from '../src/index.js';

const HELP = `Usage: claude-usage [options]

Scrapes Claude Code's interactive /usage panel and prints current usage.

Options:
  --json          Print structured JSON instead of a human-readable table
  --raw           Print the raw extracted panel text verbatim
  --timeout <ms>  Override the scrape timeout in milliseconds (default: 20000)
  -h, --help      Show this help
  -v, --version   Show the version number

Exit codes:
  0  success
  1  unexpected/internal error
  2  not logged in
  3  scrape timed out
`;

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (opts.version) {
    const require = createRequire(import.meta.url);
    process.stdout.write(require('../package.json').version + '\n');
    return 0;
  }

  if (!process.env.CLAUDE_CONFIG_DIR) {
    process.stderr.write('claude-usage: CLAUDE_CONFIG_DIR is not set\n');
    return 1;
  }

  return run(opts);
}

process.exitCode = await main();
