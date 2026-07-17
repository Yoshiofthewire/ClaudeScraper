import http from 'node:http';
import { hasCredentials } from './credentials.js';
import { createUsageCache } from './usageCache.js';
import { startLogin, submitLoginCode } from './loginDriver.js';
import { renderDashboard, renderLoginPage, renderSettings } from './htmlView.js';
import { PtySession } from './ptySession.js';
import { scrapeUsage as scrapeUsagePanel } from './usageDriver.js';
import { preseed } from './preseed.js';
import { loadSettings, saveSettings } from './settings.js';

const LOGIN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function createServer({
  configDir,
  workDir,
  intervalMs = 300000,
  spawnSession = () => new PtySession('claude', [], {
    cwd: workDir,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  }),
  scrapeOptions = {},
  loginOptions = {},
} = {}) {
  preseed(configDir, workDir);

  let authenticated = hasCredentials(configDir);
  let pendingLogin = null;
  let loginStartInFlight = null;

  const cache = createUsageCache({
    intervalMs,
    scrapeUsage: async () => {
      const session = spawnSession();
      try {
        return await scrapeUsagePanel(session, scrapeOptions);
      } finally {
        await session.close({ exitCommand: '/exit\r' });
      }
    },
  });

  if (authenticated) cache.start();

  function clearPendingLogin() {
    if (pendingLogin?.idleTimer) clearTimeout(pendingLogin.idleTimer);
    pendingLogin = null;
  }

  function armIdleTimer() {
    return setTimeout(() => {
      pendingLogin?.session.close({ exitCommand: '/exit\r' }).catch(() => {});
      clearPendingLogin();
    }, LOGIN_IDLE_TIMEOUT_MS);
  }

  // Concurrent POST /api/login/start calls must share a single in-flight
  // attempt rather than each spawning their own pty (see usageCache.js's
  // refresh() for the same inFlight-promise dedup pattern). Without this,
  // two overlapping calls could each spawn a session, and whichever
  // resolves first would have its `pendingLogin` assignment silently
  // overwritten by the second — leaking a pty and orphaning its idle timer.
  async function doLoginStart() {
    if (pendingLogin?.session) {
      await pendingLogin.session.close({ exitCommand: '/exit\r' }).catch(() => {});
    }
    clearPendingLogin();

    const session = spawnSession();
    try {
      const { term, loginUrl } = await startLogin(session, loginOptions);
      pendingLogin = { session, term, loginUrl, status: 'awaiting-code', error: null };
      pendingLogin.idleTimer = armIdleTimer();
    } catch (err) {
      await session.close().catch(() => {});
      pendingLogin = { status: 'error', error: err.message };
    }
  }

  async function handleLoginStart() {
    if (loginStartInFlight) return loginStartInFlight;
    loginStartInFlight = doLoginStart().finally(() => {
      loginStartInFlight = null;
    });
    return loginStartInFlight;
  }

  async function handleLoginCode(code) {
    // Capture the specific pending-login record we're operating on. A
    // concurrent /api/login/start can supersede `pendingLogin` while we're
    // awaiting submitLoginCode below, so every reference after that await
    // must go through `current`, not the mutable module-level variable.
    const current = pendingLogin;
    if (!current?.session || current.status !== 'awaiting-code') {
      return { status: current?.status ?? 'idle', error: current?.error ?? null };
    }
    if (current.idleTimer) clearTimeout(current.idleTimer);
    current.status = 'submitting';

    let result;
    try {
      result = await submitLoginCode(current.session, current.term, code, loginOptions);
    } catch (err) {
      if (pendingLogin !== current) {
        // A newer login attempt has already superseded this one; don't
        // mutate the (now newer) pendingLogin.
        return loginState();
      }
      // submitLoginCode rejected (e.g. it timed out waiting for a
      // recognized success/error pattern on screen) rather than resolving
      // with a success/failure outcome. The pty session and its terminal
      // are still alive and valid — this was a transient failure to detect
      // an outcome, not proof the code was wrong — so recover back to
      // awaiting-code and let the user retry instead of getting stuck on
      // 'submitting' forever.
      current.status = 'awaiting-code';
      current.error = `Failed to detect login result: ${err.message}`;
      current.idleTimer = armIdleTimer();
      return { status: 'awaiting-code', error: current.error, loginUrl: current.loginUrl };
    }

    if (pendingLogin !== current) {
      // A newer login attempt has already superseded this one and, as part
      // of superseding it, already closed `current.session`. Don't close
      // anything again and don't mutate the (now newer) pendingLogin.
      return loginState();
    }

    if (result.success) {
      await current.session.close({ exitCommand: '/exit\r' }).catch(() => {});
      clearPendingLogin();
      authenticated = hasCredentials(configDir);
      if (authenticated) cache.start();
      return authenticated
        ? { status: 'success' }
        : { status: 'error', error: 'Login reported success but no credentials were written' };
    }

    current.status = 'awaiting-code';
    current.error = result.message;
    current.idleTimer = armIdleTimer();
    return { status: 'awaiting-code', error: result.message, loginUrl: current.loginUrl };
  }

  function loginState() {
    if (!pendingLogin) return { status: 'idle' };
    return { status: pendingLogin.status, loginUrl: pendingLogin.loginUrl, error: pendingLogin.error };
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = authenticated ? renderDashboard(cache.getState()) : renderLoginPage(loginState());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === '/api/usage') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, plan: loadSettings(configDir).plan, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }

      if (req.method === 'POST' && req.url === '/api/refresh') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        await cache.refresh();
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, plan: loadSettings(configDir).plan, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }

      if (req.method === 'GET' && req.url === '/api/login/state') {
        return sendJson(res, 200, { authenticated, ...loginState() });
      }

      if (req.method === 'POST' && req.url === '/api/login/start') {
        await handleLoginStart();
        return sendJson(res, 200, loginState());
      }

      if (req.method === 'POST' && req.url === '/api/login/code') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (!body.code) return sendJson(res, 400, { error: 'code is required' });
        const result = await handleLoginCode(body.code);
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && req.url === '/settings') {
        if (!authenticated) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        const html = renderSettings(loadSettings(configDir));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && req.url === '/api/settings') {
        return sendJson(res, 200, loadSettings(configDir));
      }

      if (req.method === 'POST' && req.url === '/api/settings') {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const updated = saveSettings(configDir, body);
          return sendJson(res, 200, updated);
        } catch (err) {
          if (err.message.startsWith('invalid plan')) {
            return sendJson(res, 400, { error: err.message });
          }
          throw err;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return server;
}
