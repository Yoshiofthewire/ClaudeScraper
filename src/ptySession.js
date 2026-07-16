import pty from 'node-pty';

export class PtySession {
  #pty;
  #exited = false;
  #exitPromise;

  constructor(command, args = [], { cols = 120, rows = 40, cwd = process.cwd(), env = process.env } = {}) {
    this.#pty = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    this.#exitPromise = new Promise((resolve) => {
      this.#pty.onExit(() => {
        this.#exited = true;
        resolve();
      });
    });
  }

  get pid() {
    return this.#pty.pid;
  }

  onData(callback) {
    this.#pty.onData(callback);
  }

  write(data) {
    this.#pty.write(data);
  }

  async close({ exitCommand = null, timeoutMs = 2000 } = {}) {
    if (this.#exited) return;

    if (exitCommand) {
      this.write(exitCommand);
    }

    const exitedNaturally = await this.#waitExit(timeoutMs / 2);
    if (exitedNaturally) return;

    this.#pty.kill('SIGTERM');
    const exitedAfterTerm = await this.#waitExit(timeoutMs / 2);
    if (exitedAfterTerm) return;

    this.#pty.kill('SIGKILL');
  }

  #waitExit(timeoutMs) {
    if (this.#exited) return Promise.resolve(true);
    return Promise.race([
      this.#exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
}
