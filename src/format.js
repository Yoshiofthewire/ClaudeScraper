export function formatHuman(usage) {
  const lines = [];

  for (const bar of usage.bars) {
    const reset = bar.resetsText ? ` (${bar.resetsText})` : '';
    lines.push(`${bar.label}: ${bar.pctUsed}% used${reset}`);
  }

  if (usage.characteristics.length > 0) {
    lines.push('');
    lines.push("What's contributing to your limits usage?");
    for (const c of usage.characteristics) {
      lines.push(`  ${c.pct}% ${c.summary}`);
    }
  }

  return lines.join('\n');
}

export function formatJson(usage) {
  return JSON.stringify(usage, null, 2);
}
