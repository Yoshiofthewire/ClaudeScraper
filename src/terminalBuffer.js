import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

const POLL_INTERVAL_MS = 10;

export class TerminalBuffer {
  #terminal;
  #pending = Promise.resolve();
  #lastWriteAt = Date.now();

  constructor({ cols = 120, rows = 40 } = {}) {
    this.#terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  write(data) {
    this.#lastWriteAt = Date.now();
    this.#pending = this.#pending.then(
      () => new Promise((resolve) => this.#terminal.write(data, resolve)),
    );
    return this.#pending;
  }

  msSinceLastWrite() {
    return Date.now() - this.#lastWriteAt;
  }

  waitQuiet(quietMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.msSinceLastWrite() >= quietMs) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error(`waitQuiet timed out after ${timeoutMs}ms`));
        } else {
          setTimeout(check, POLL_INTERVAL_MS);
        }
      };
      check();
    });
  }

  getText() {
    const buffer = this.#terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  }
}
