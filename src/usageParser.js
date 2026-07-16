const BAR_LABEL_RE = /^(Current session|Current week \(.+\))$/;
const PCT_RE = /(\d+)% used/;
const CHARACTERISTIC_RE = /^(\d+)% of (.+)$/;
const COST_RE = /^Total cost:\s+\$([\d.]+)/;
const API_DURATION_RE = /^Total duration \(API\):\s+(.+)$/;
const WALL_DURATION_RE = /^Total duration \(wall\):\s+(.+)$/;

function parseSession(lines) {
  const session = { totalCostUsd: null, apiDuration: null, wallDuration: null };
  for (const line of lines) {
    const cost = line.match(COST_RE);
    if (cost) session.totalCostUsd = Number(cost[1]);
    const api = line.match(API_DURATION_RE);
    if (api) session.apiDuration = api[1];
    const wall = line.match(WALL_DURATION_RE);
    if (wall) session.wallDuration = wall[1];
  }
  return session;
}

function parseCharacteristics(lines) {
  const characteristics = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHARACTERISTIC_RE);
    if (!match) continue;

    const detailParts = [];
    for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) {
      detailParts.push(lines[j]);
    }

    characteristics.push({
      pct: Number(match[1]),
      summary: match[2],
      detail: detailParts.join(' '),
    });
  }
  return characteristics;
}

function parseBars(lines) {
  const bars = [];
  for (let i = 0; i < lines.length; i++) {
    const labelMatch = lines[i].match(BAR_LABEL_RE);
    if (!labelMatch) continue;

    const label = labelMatch[1];
    const pctLine = lines[i + 1] ?? '';
    const pctMatch = pctLine.match(PCT_RE);
    if (!pctMatch) continue;

    const resetsLine = lines[i + 2] ?? '';
    const resetsText = resetsLine.startsWith('Resets') ? resetsLine : null;

    bars.push({
      label,
      pctUsed: Number(pctMatch[1]),
      resetsText,
    });
  }
  return bars;
}

export function parseUsage(text) {
  const lines = text.split('\n').map((l) => l.trim());

  return {
    bars: parseBars(lines),
    session: parseSession(lines),
    characteristics: parseCharacteristics(lines),
    raw: text,
  };
}
