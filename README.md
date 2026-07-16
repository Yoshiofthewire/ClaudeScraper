# claude-usage

Scrapes Claude Code's interactive `/usage` panel and prints current usage as
a one-shot CLI. There's no scriptable API for this data (`claude auth status`
only reports login state, and `claude -p --output-format json` reports the
cost of the single query just run, not account-wide plan usage) — this drives
the real interactive TUI in a pty and reads the rendered screen.

## Usage

```sh
docker build -t claude-usage .
docker volume create claude-usage-data

# One-time interactive login. Drops you into the real Claude Code TUI —
# once it's ready, type /login and follow the prompts. It's a manual
# paste-URL flow (visit the printed URL in any browser, paste the code
# back) — no port publishing needed.
docker run --rm -it -v claude-usage-data:/data claude-usage login

# Fallback if you'd rather use a portable long-lived token instead:
docker run --rm -it -v claude-usage-data:/data claude-usage login --token

# Subsequent one-shot scrapes
docker run --rm -v claude-usage-data:/data claude-usage
docker run --rm -v claude-usage-data:/data claude-usage --json | jq .
docker run --rm -v claude-usage-data:/data claude-usage --raw
```

### Flags

- `--json` — structured JSON instead of a human-readable table
- `--raw` — the raw extracted panel text verbatim (escape hatch if parsing gets out of sync with a future Claude Code UI change)
- `--timeout <ms>` — override the scrape timeout (default 20000)
- `-h/--help`, `-v/--version`

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | unexpected/internal error |
| 2 | not logged in — run `... login` |
| 3 | scrape timed out (panel never rendered — rate-limited, network issue, or unrecognized UI state; try `--raw` to see what was captured) |

## Development

```sh
npm install
npm test
```

`test/fixtures/usage-subscription.txt` is a real captured `/usage` screen
(hand-captured, PII redacted) used to test `usageParser.js` without needing
a live login. If Claude Code changes the panel's rendered text in a future
release, capture a fresh one the same way and update the parser/fixture.

Bumping the pinned `@anthropic-ai/claude-code` version in the Dockerfile:
update the version in both the `npm install -g` line and re-verify the
fixture/parser still match the new release's rendered output.
