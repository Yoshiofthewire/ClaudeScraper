function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function barColor(pct) {
  if (pct >= 85) return '#e5484d';
  if (pct >= 60) return '#f5a623';
  return '#30a46c';
}

function renderBars(bars) {
  if (!bars || bars.length === 0) {
    return '<p class="muted">No usage bars parsed yet.</p>';
  }
  return bars.map((bar) => `
    <div class="bar-row">
      <div class="bar-label">
        <span>${escapeHtml(bar.label)}</span>
        <span>${bar.pctUsed}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${bar.pctUsed}%;background:${barColor(bar.pctUsed)}"></div>
      </div>
      ${bar.resetsText ? `<div class="muted small">${escapeHtml(bar.resetsText)}</div>` : ''}
    </div>
  `).join('');
}

function renderSession(session) {
  if (!session || (session.totalCostUsd == null && !session.apiDuration && !session.wallDuration)) {
    return '';
  }
  const cost = session.totalCostUsd != null ? `$${session.totalCostUsd.toFixed(4)}` : '—';
  return `
    <div class="section">
      <h2>This session</h2>
      <div class="stat-row"><span>Cost</span><span>${escapeHtml(cost)}</span></div>
      <div class="stat-row"><span>API duration</span><span>${escapeHtml(session.apiDuration ?? '—')}</span></div>
      <div class="stat-row"><span>Wall duration</span><span>${escapeHtml(session.wallDuration ?? '—')}</span></div>
    </div>
  `;
}

function renderCharacteristics(characteristics) {
  if (!characteristics || characteristics.length === 0) return '';
  return `
    <div class="section">
      <h2>What's contributing to your limits usage?</h2>
      ${characteristics.map((c) => `
        <div class="characteristic">
          <strong>${c.pct}%</strong> ${escapeHtml(c.summary)}
          <p class="muted small">${escapeHtml(c.detail)}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function renderPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 2rem 1rem;
    background: #f6f7f9;
    color: #1a1d21;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaed; }
    .card { background: #1e2126 !important; border-color: #2c3036 !important; }
    input, button { background: #2c3036 !important; color: #e8eaed !important; border-color: #3a3f47 !important; }
  }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 1.75rem 2rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.75rem; }
  .header-row { display: flex; align-items: center; justify-content: space-between; }
  .muted { color: #6b7280; }
  .small { font-size: 0.8rem; }
  .bars { margin-top: 1rem; }
  .bar-row { margin-bottom: 1.1rem; }
  .bar-label { display: flex; justify-content: space-between; font-size: 0.9rem; margin-bottom: 0.3rem; }
  .bar-track { background: #e9eaec; border-radius: 999px; height: 8px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.3s ease; }
  .section { border-top: 1px solid #e3e5e8; padding-top: 0.75rem; }
  .stat-row { display: flex; justify-content: space-between; font-size: 0.9rem; padding: 0.2rem 0; }
  .characteristic { margin-bottom: 0.75rem; }
  .banner { border-radius: 8px; padding: 0.6rem 0.9rem; font-size: 0.85rem; margin: 0.75rem 0; }
  .banner-error { background: #fde8e8; color: #9b1c1c; }
  .banner-warn { background: #fef3c7; color: #92400e; }
  button, input { font: inherit; border-radius: 8px; border: 1px solid #d1d5db; padding: 0.5rem 0.9rem; }
  button { background: #1a1d21; color: #fff; border: none; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  form { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  input { flex: 1; }
  a { color: #2563eb; word-break: break-all; }
  .header-actions { display: flex; align-items: center; gap: 0.75rem; }
  .plan-options { display: flex; gap: 1rem; margin-top: 0.5rem; }
  .plan-option { display: flex; align-items: center; gap: 0.35rem; font-size: 0.9rem; }
  .qr-placeholder { border: 1px dashed #d1d5db; border-radius: 8px; padding: 2rem; text-align: center; color: #6b7280; font-size: 0.85rem; margin-top: 0.5rem; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function renderDashboard(state) {
  const { data, lastUpdatedAt, stale, error } = state;

  if (!data) {
    return renderPage('Claude Usage', `
      <div class="card">
        <div class="header-row">
          <h1>Claude Usage</h1>
          <a href="/settings">Settings</a>
        </div>
        <p class="muted">Waiting for the first scrape to complete…</p>
        ${error ? `<div class="banner banner-error">${escapeHtml(error)}</div>` : ''}
      </div>
      <script>setTimeout(() => location.reload(), 3000);</script>
    `);
  }

  const updated = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : 'never';

  return renderPage('Claude Usage', `
    <div class="card">
      <div class="header-row">
        <h1>Claude Usage</h1>
        <div class="header-actions">
          <a href="/settings">Settings</a>
          <button id="refresh-btn" onclick="refresh()">Refresh now</button>
        </div>
      </div>
      ${stale ? `<div class="banner banner-warn">Showing last known data — most recent refresh failed: ${escapeHtml(error)}</div>` : ''}
      <div class="bars">${renderBars(data.bars)}</div>
      ${renderSession(data.session)}
      ${renderCharacteristics(data.characteristics)}
      <p class="muted small">Last updated ${escapeHtml(updated)}</p>
    </div>
    <script>
      async function refresh() {
        const btn = document.getElementById('refresh-btn');
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        await fetch('/api/refresh', { method: 'POST' });
        location.reload();
      }
    </script>
  `);
}

export function renderLoginPage(loginState = { status: 'idle' }) {
  const { status, loginUrl, error } = loginState;

  let body;
  if (status === 'idle' || status === 'starting') {
    body = `
      <h1>Connect Claude Code</h1>
      <p class="muted">No credentials found yet. Start the login flow to authorize this container.</p>
      <button onclick="startLogin()" ${status === 'starting' ? 'disabled' : ''}>
        ${status === 'starting' ? 'Starting…' : 'Start login'}
      </button>
    `;
  } else if (status === 'awaiting-code' || status === 'submitting') {
    body = `
      <h1>Connect Claude Code</h1>
      <p>1. Visit this URL and authorize the app:</p>
      <p><a href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener">${escapeHtml(loginUrl)}</a></p>
      <p>2. Paste the code it gives you back here:</p>
      <form onsubmit="return submitCode(event)">
        <input id="code" name="code" autocomplete="off" placeholder="paste code" ${status === 'submitting' ? 'disabled' : ''} />
        <button type="submit" ${status === 'submitting' ? 'disabled' : ''}>
          ${status === 'submitting' ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    `;
  } else if (status === 'error') {
    body = `
      <h1>Connect Claude Code</h1>
      <div class="banner banner-error">${escapeHtml(error)}</div>
      <button onclick="startLogin()">Try again</button>
    `;
  } else {
    body = `<h1>Connect Claude Code</h1><p class="muted">Unexpected state.</p>`;
  }

  return renderPage('Claude Usage — Login', `
    <div class="card">${body}</div>
    <script>
      async function startLogin() {
        await fetch('/api/login/start', { method: 'POST' });
        location.reload();
      }
      async function submitCode(evt) {
        evt.preventDefault();
        const code = document.getElementById('code').value;
        const res = await fetch('/api/login/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const state = await res.json();
        if (state.status === 'success') {
          location.href = '/';
        } else {
          location.reload();
        }
        return false;
      }
      ${status === 'awaiting-code' ? 'setTimeout(() => location.reload(), 15000);' : ''}
    </script>
  `);
}

const PLAN_OPTIONS = ['Pro', 'Max', 'Max x20'];

export function renderSettings(settings) {
  const { plan, helloPromptOnReset } = settings;

  const planRadios = PLAN_OPTIONS.map((p) => `
    <label class="plan-option">
      <input type="radio" name="plan" value="${escapeHtml(p)}" ${plan === p ? 'checked' : ''} onchange="setPlan('${escapeHtml(p)}')" />
      ${escapeHtml(p)}
    </label>
  `).join('');

  return renderPage('Claude Usage — Settings', `
    <div class="card">
      <div class="header-row">
        <h1>Settings</h1>
        <a href="/">Back to dashboard</a>
      </div>

      <div class="section">
        <h2>Plan</h2>
        <div class="plan-options">${planRadios}</div>
      </div>

      <div class="section">
        <h2>Hello prompt on reset</h2>
        <label>
          <input type="checkbox" id="hello-prompt-toggle" ${helloPromptOnReset ? 'checked' : ''} onchange="setHelloPrompt()" />
          Send a "Hello" prompt after every usage-window reset
        </label>
        <p class="muted small">Saves your preference — automatic sending isn't wired up yet.</p>
      </div>

      <div class="section">
        <h2>Pair a mobile app</h2>
        <div class="qr-placeholder">QR code coming soon</div>
      </div>
    </div>
    <script>
      async function setPlan(plan) {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        });
      }
      async function setHelloPrompt() {
        const input = document.getElementById('hello-prompt-toggle');
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ helloPromptOnReset: input.checked }),
        });
      }
    </script>
  `);
}
