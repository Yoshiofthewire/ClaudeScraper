export function createUsageCache({ scrapeUsage, intervalMs }) {
  let data = null;
  let lastUpdatedAt = null;
  let error = null;
  let timer = null;
  let inFlight = null;

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = scrapeUsage()
      .then((result) => {
        data = result;
        lastUpdatedAt = new Date();
        error = null;
      })
      .catch((err) => {
        error = err.message;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getState() {
    return {
      data,
      lastUpdatedAt,
      stale: Boolean(error) && data !== null,
      error,
    };
  }

  return { start, stop, refresh, getState };
}
