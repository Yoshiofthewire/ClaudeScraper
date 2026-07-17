export function detectReset(previousBars, newBars) {
  if (!previousBars) return false;
  const previousByLabel = new Map(previousBars.map((bar) => [bar.label, bar.pctUsed]));
  return newBars.some((bar) => {
    const prevPct = previousByLabel.get(bar.label);
    return prevPct != null && bar.pctUsed < prevPct;
  });
}
