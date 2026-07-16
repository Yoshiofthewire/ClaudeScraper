export function pollUntil(term, predicate, { quietMs, timeoutMs, intervalMs = 20 }) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (term.msSinceLastWrite() >= quietMs && predicate(term.getText())) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for expected terminal state'));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}
