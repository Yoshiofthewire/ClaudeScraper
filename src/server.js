import http from 'node:http';
import { hasCredentials } from './credentials.js';
import { createUsageCache } from './usageCache.js';
import { startLogin, submitLoginCode } from './loginDriver.js';
import { renderDashboard, renderLoginPage } from './htmlView.js';
import { PtySession } from './ptySession.js';
import { scrapeUsage as scrapeUsagePanel } from './usageDriver.js';
import { preseed } from './preseed.js';

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

  async function handleLoginStart() {
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

  async function handleLoginCode(code) {
    if (!pendingLogin?.session || pendingLogin.status !== 'awaiting-code') {
      return { status: pendingLogin?.status ?? 'idle', error: pendingLogin?.error ?? null };
    }
    if (pendingLogin.idleTimer) clearTimeout(pendingLogin.idleTimer);
    pendingLogin.status = 'submitting';

    const result = await submitLoginCode(pendingLogin.session, pendingLogin.term, code, loginOptions);

    if (result.success) {
      await pendingLogin.session.close({ exitCommand: '/exit\r' }).catch(() => {});
      clearPendingLogin();
      authenticated = hasCredentials(configDir);
      if (authenticated) cache.start();
      return authenticated
        ? { status: 'success' }
        : { status: 'error', error: 'Login reported success but no credentials were written' };
    }

    pendingLogin.status = 'awaiting-code';
    pendingLogin.error = result.message;
    pendingLogin.idleTimer = armIdleTimer();
    return { status: 'awaiting-code', error: result.message, loginUrl: pendingLogin.loginUrl };
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
        return sendJson(res, 200, { ...state.data, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
      }

      if (req.method === 'POST' && req.url === '/api/refresh') {
        if (!authenticated) return sendJson(res, 503, { error: 'not authenticated' });
        await cache.refresh();
        const state = cache.getState();
        return sendJson(res, 200, { ...state.data, lastUpdatedAt: state.lastUpdatedAt, stale: state.stale, error: state.error });
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

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return server;
}
