// ---------------------------------------------------------------------------
// Live dashboard — served by the HTTP server as a fallback when
// dashboard/dist/index.html does not exist (e.g. source checkouts pre-build).
// In packaged releases the Preact build always takes precedence.
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained live HTML dashboard.
 * Data is fetched in-browser from the HTTP API (/v1/*).
 * All DOM manipulation uses textContent / createElement — no innerHTML with user data.
 */
export function generateLiveDashboardHtml(): string {
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --bg-primary: #09090b;
      --bg-secondary: #111113;
      --bg-card: rgba(17,17,19,0.8);
      --bg-hover: rgba(39,39,42,0.5);
      --border: rgba(39,39,42,0.8);
      --border-subtle: rgba(39,39,42,0.4);
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --accent: #3b82f6;
      --accent-glow: rgba(59,130,246,0.15);
      --accent-hover: #60a5fa;
      --danger: #ef4444;
      --success: #22c55e;
      --warning: #f59e0b;
      --radius: 12px;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.5);
      --shadow-glow: 0 0 20px var(--accent-glow);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-sans);
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* Light mode overrides */
    body.light {
      --bg-primary: #fafafa;
      --bg-secondary: #ffffff;
      --bg-card: rgba(255,255,255,0.9);
      --bg-hover: rgba(0,0,0,0.04);
      --border: rgba(0,0,0,0.08);
      --border-subtle: rgba(0,0,0,0.04);
      --text-primary: #09090b;
      --text-secondary: #52525b;
      --text-muted: #a1a1aa;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 32px rgba(0,0,0,0.12);
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .subtitle {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 400;
      letter-spacing: 0.02em;
    }
    .version {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg-hover);
      padding: 2px 8px;
      border-radius: var(--radius-xs);
    }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .header .meta { display: flex; align-items: center; gap: 12px; }

    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      display: inline-block; margin-right: 6px;
      background: var(--text-muted);
    }
    .dot.connected { background: var(--success); box-shadow: 0 0 6px rgba(34,197,94,0.4); }
    .dot.error { background: var(--danger); }

    /* Navigation */
    .nav {
      display: flex;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      gap: 2px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav button {
      padding: 12px 16px;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
      transition: all 0.2s ease;
      white-space: nowrap;
      font-family: var(--font-sans);
    }
    .nav button:hover { color: var(--text-secondary); background: var(--bg-hover); }
    .nav button.active { color: var(--text-primary); border-bottom-color: var(--accent); }

    /* Content */
    .content { max-width: 1280px; margin: 0 auto; padding: 24px; }

    /* Tab panels */
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 16px;
      backdrop-filter: blur(8px);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover { border-color: rgba(59,130,246,0.2); box-shadow: var(--shadow-glow); }
    .card h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); letter-spacing: -0.01em; }

    /* Forms */
    input, button, textarea { font-family: var(--font-sans); font-size: 14px; }
    .search-row { display: flex; gap: 8px; margin-bottom: 20px; }
    .search-input {
      flex: 1;
      padding: 10px 14px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 14px;
      font-family: var(--font-sans);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    .search-input::placeholder { color: var(--text-muted); }

    /* Buttons */
    .btn {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font-sans);
      transition: all 0.15s ease;
      background: var(--bg-secondary);
      color: var(--text-primary);
    }
    .btn:hover { background: var(--bg-hover); border-color: var(--text-muted); }
    .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn-secondary { background: var(--bg-secondary); color: var(--text-secondary); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
    .btn-danger { border-color: var(--danger); color: var(--danger); background: transparent; }
    .btn-danger:hover { background: rgba(239,68,68,0.1); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }

    /* Tables */
    .table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; min-width: 500px; table-layout: auto; }
    th {
      text-align: left;
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
      color: var(--text-secondary);
      word-break: break-word;
    }
    tbody tr { transition: background 0.15s ease; }
    tbody tr:hover { background: var(--bg-hover); }
    tbody tr:last-child td { border-bottom: none; }

    /* Badges */
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; }
    .badge-active { background: rgba(34,197,94,0.12); color: #4ade80; }
    .badge-archived { background: rgba(239,68,68,0.12); color: #f87171; }
    .badge-type { background: var(--accent-glow); color: var(--accent-hover); }

    /* Entity name */
    .entity-name { font-weight: 500; color: var(--text-primary); }
    .entity-obs { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

    /* Tag pills */
    .tag-pill {
      display: inline-block; padding: 2px 8px; margin: 2px;
      border-radius: 999px; font-size: 11px;
      font-family: var(--font-mono);
      background: var(--bg-hover);
      color: var(--text-secondary);
      border: 1px solid var(--border-subtle);
      cursor: default;
    }

    /* Placeholder */
    .placeholder { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 14px; }
    .placeholder .icon { font-size: 32px; margin-bottom: 12px; display: block; }

    /* Result / error box */
    .result-box { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; margin-top: 12px; font-size: 13px; font-family: var(--font-mono); white-space: pre-wrap; max-height: 400px; overflow: auto; color: var(--text-secondary); }
    .result-box.error { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.2); color: #f87171; }

    /* Loading spinner */
    .loading { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Settings */
    .settings-section { margin-bottom: 28px; }
    .settings-section h3 { font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.05em; }
    .form-group { margin-bottom: 14px; }
    .form-label { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 5px; }
    .form-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .cap-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .cap-item { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12px; }
    .cap-item .cap-label { color: var(--text-muted); margin-bottom: 2px; }
    .cap-item .cap-value { font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); }
    .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
    .status-dot.ok { background: var(--success); box-shadow: 0 0 5px rgba(34,197,94,0.4); }
    .status-dot.warn { background: var(--warning); }

    /* Welcome wizard modal */
    .wizard-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(4px); }
    .wizard-overlay.hidden { display: none; }
    .wizard-modal { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px; max-width: 520px; width: 90%; box-shadow: var(--shadow-lg); }
    .wizard-modal h2 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: var(--text-primary); letter-spacing: -0.02em; }
    .wizard-modal .subtitle { color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
    .wizard-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }

    /* Analytics */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; text-align: center; backdrop-filter: blur(8px); }
    .stat-card .stat-value { font-size: 32px; font-weight: 700; color: var(--accent); font-family: var(--font-mono); line-height: 1.2; }
    .stat-card .stat-label { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .bar-chart { margin-bottom: 20px; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
    .bar-label { width: 140px; flex-shrink: 0; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { flex: 1; background: var(--bg-hover); border-radius: 4px; height: 8px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s ease; opacity: 0.8; }
    .bar-count { width: 36px; text-align: right; color: var(--text-muted); flex-shrink: 0; font-family: var(--font-mono); font-size: 12px; }
    .tag-cloud { display: flex; flex-wrap: wrap; gap: 8px; }

    /* Manage */
    .manage-action-cell { display: flex; gap: 6px; flex-wrap: wrap; }

    /* Feedback widget */
    #feedback-btn {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--accent); color: white;
      border: none; padding: 10px 16px;
      border-radius: 999px; cursor: pointer;
      font-size: 13px; font-weight: 500;
      box-shadow: var(--shadow-md), var(--shadow-glow);
      transition: all 0.2s ease; z-index: 50;
      font-family: var(--font-sans);
    }
    #feedback-btn:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg), 0 0 30px var(--accent-glow); }
    #feedback-panel {
      position: fixed; bottom: 72px; right: 24px;
      width: 340px; background: var(--bg-secondary);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 20px; box-shadow: var(--shadow-lg);
      z-index: 51; backdrop-filter: blur(16px); display: none;
    }
    #feedback-panel.open { display: block; }
    #feedback-panel h3 { font-size: 14px; font-weight: 600; margin-bottom: 14px; color: var(--text-primary); }
    .fb-radio-group { display: flex; gap: 8px; margin-bottom: 12px; }
    .fb-radio { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); cursor: pointer; font-size: 12px; color: var(--text-secondary); }
    .fb-radio.selected { border-color: var(--accent); background: var(--accent-glow); color: var(--accent-hover); }
    .fb-radio input { accent-color: var(--accent); }
    #fb-desc { width: 100%; height: 80px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-xs); font-size: 13px; resize: vertical; outline: none; margin-bottom: 10px; background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-sans); }
    #fb-desc:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    .fb-sys-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }

    /* Highlight */
    mark { background: rgba(59,130,246,0.2); color: inherit; padding: 1px 3px; border-radius: 3px; }

    /* Hidden */
    .hidden { display: none !important; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    /* Responsive */
    @media (max-width: 768px) {
      .content { padding: 16px; }
      .nav button { padding: 10px 12px; font-size: 12px; }
      .header h1 { font-size: 15px; }
      .search-row { flex-direction: column; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      #feedback-panel { width: calc(100vw - 48px); }
      #feedback-btn { bottom: 16px; right: 16px; }
    }
    @media (max-width: 480px) {
      .nav { gap: 0; }
      .nav button { flex: 1; font-size: 11px; padding: 10px 6px; }
      .stats-grid { grid-template-columns: 1fr; }
      .header { padding: 12px 16px; }
    }
  `.trim();

  // The inline script uses only createElement / textContent for all user data.
  // No dynamic HTML concatenation with unsanitised strings.
  const SCRIPT = `
(function () {
  'use strict';

  var _currentVersion = '';
  // ---- API ----
  async function apiCall(method, path, body) {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);
    try {
      var opts = { method: method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
      if (body !== undefined) opts.body = JSON.stringify(body);
      var res = await fetch(path, opts);
      clearTimeout(timeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Request timed out (10s)');
      throw err;
    }
  }

  function successData(response, label) {
    if (!response || response.success !== true) {
      throw new Error((response && response.error) || ('Failed to load ' + label));
    }
    return response.data;
  }

  function entityList(value, label) {
    if (!Array.isArray(value)) throw new Error('Invalid ' + label + ' response');
    return value;
  }

  function configData(response) {
    var value = successData(response, 'config');
    if (!value || typeof value !== 'object' || !value.config
        || typeof value.config !== 'object' || Array.isArray(value.config)) {
      throw new Error('Invalid config response');
    }
    return value.config;
  }

  // ---- Theme (dark default, light class toggles light mode) ----
  (function initTheme() {
    var saved = localStorage.getItem('memesh-theme');
    if (saved === 'light') { document.body.classList.add('light'); }
    var themeBtn = document.getElementById('theme-btn');
    if (themeBtn) {
      themeBtn.textContent = document.body.classList.contains('light') ? '\\ud83c\\udf19' : '\\u2600\\ufe0f';
      themeBtn.addEventListener('click', function () {
        document.body.classList.toggle('light');
        var isLight = document.body.classList.contains('light');
        themeBtn.textContent = isLight ? '\\ud83c\\udf19' : '\\u2600\\ufe0f';
        localStorage.setItem('memesh-theme', isLight ? 'light' : 'dark');
        // Theme is persisted client-side in localStorage only. An earlier
        // POST /v1/config { theme } wrote a config.theme that nothing ever
        // read back; removed with that dead field.
      });
    }
  })();

  // ---- Tab switching ----
  document.getElementById('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    var tab = btn.dataset.tab;
    document.querySelectorAll('.nav button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'browse') loadBrowse();
    if (tab === 'analytics') loadAnalytics();
    if (tab === 'manage') loadManage();
    if (tab === 'settings') loadSettings();
  });

  // ---- Health check ----
  async function checkHealth() {
    var indicator = document.getElementById('health-indicator');
    var versionLabel = document.getElementById('version-label');
    try {
      var data = await apiCall('GET', '/v1/health');
      if (!data.success) throw new Error(data.error || 'API error');
      _currentVersion = data.data.version || '';
      var dot = document.createElement('span');
      dot.className = 'dot';
      indicator.textContent = '';
      indicator.appendChild(dot);
      indicator.appendChild(document.createTextNode('Connected'));
      versionLabel.textContent = 'v' + data.data.version + '  \u00b7  ' + data.data.entity_count + ' entities';
    } catch (_err) {
      var dot2 = document.createElement('span');
      dot2.className = 'dot error';
      indicator.textContent = '';
      indicator.appendChild(dot2);
      indicator.appendChild(document.createTextNode('Disconnected'));
    }
  }

  // ---- Shared: build entity table from array using only DOM APIs ----
  // Redesigned: shows Time (locale) | Memory Preview | Source/Type | Status | Tags
  // Entity name is secondary — first observation preview is the primary content
  function buildEntityTable(entities, highlightTerm) {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    ['Time', 'Memory', 'Type', 'Status', 'Tags'].forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      if (h === 'Memory') th.style.width = '45%';
      if (h === 'Time') th.style.width = '140px';
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    entities.forEach(function (e) {
      var status = e.archived ? 'archived' : (e.status || 'active');
      var tr = document.createElement('tr');
      if (status === 'archived') tr.style.opacity = '0.5';

      // Time column — locale-formatted timestamp
      var tdTime = document.createElement('td');
      tdTime.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:nowrap;';
      try {
        var d = new Date(e.created_at);
        tdTime.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        tdTime.textContent = e.created_at || '—';
      }
      tdTime.title = e.created_at || '';
      tr.appendChild(tdTime);

      // Memory column — first observation as preview, entity name as secondary
      var tdMemory = document.createElement('td');
      var memoryContent = document.createElement('div');

      // Primary: first observation (the actual useful content)
      var preview = document.createElement('div');
      preview.style.cssText = 'font-size:13px;line-height:1.5;margin-bottom:2px;';
      var firstObs = (e.observations && e.observations.length > 0) ? e.observations[0] : '(no observations)';
      var previewText = firstObs.length > 120 ? firstObs.slice(0, 120) + '\\u2026' : firstObs;
      if (highlightTerm) {
        highlightText(preview, previewText, highlightTerm);
      } else {
        preview.textContent = previewText;
      }
      memoryContent.appendChild(preview);

      // Secondary: entity name (technical identifier) + observation count
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);';
      var obsCount = e.observations ? e.observations.length : 0;
      meta.textContent = e.name + (obsCount > 1 ? ' \\u00b7 ' + obsCount + ' observations' : '');
      memoryContent.appendChild(meta);

      tdMemory.appendChild(memoryContent);
      tr.appendChild(tdMemory);

      // Type badge
      var tdType = document.createElement('td');
      var typeBadge = document.createElement('span');
      typeBadge.className = 'badge badge-type';
      typeBadge.textContent = e.type;
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      // Status badge
      var tdStatus = document.createElement('td');
      var statusBadge = document.createElement('span');
      statusBadge.className = 'badge badge-' + (status === 'archived' ? 'archived' : 'active');
      statusBadge.textContent = status;
      tdStatus.appendChild(statusBadge);
      tr.appendChild(tdStatus);

      // Tags
      var tdTags = document.createElement('td');
      if (e.tags && e.tags.length > 0) {
        e.tags.slice(0, 3).forEach(function (t) {
          var pill = document.createElement('span');
          pill.className = 'tag-pill';
          pill.textContent = t;
          tdTags.appendChild(pill);
        });
        if (e.tags.length > 3) {
          var more = document.createElement('span');
          more.className = 'tag-pill';
          more.style.opacity = '0.6';
          more.textContent = '+' + (e.tags.length - 3);
          tdTags.appendChild(more);
        }
      }
      tr.appendChild(tdTags);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.appendChild(table);
    return wrap;
  }

  function showError(container, msg) {
    container.textContent = '';
    var box = document.createElement('div');
    box.className = 'result-box error';
    box.textContent = msg;
    container.appendChild(box);
  }

  function showPlaceholder(container, text) {
    container.textContent = '';
    var ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = text;
    container.appendChild(ph);
  }

  function showSpinner(container) {
    container.textContent = '';
    var wrap = document.createElement('div');
    wrap.className = 'placeholder';
    var sp = document.createElement('div');
    sp.className = 'loading';
    wrap.appendChild(sp);
    container.appendChild(wrap);
  }

  // ---- Search term highlighting (XSS-safe via createElement/textContent) ----
  function highlightText(container, text, term) {
    if (!term) { container.textContent = text; return; }
    var lower = text.toLowerCase();
    var lowerTerm = term.toLowerCase();
    var termLen = lowerTerm.length;
    if (termLen === 0) { container.textContent = text; return; }
    var pos = 0;
    while (pos < text.length) {
      var idx = lower.indexOf(lowerTerm, pos);
      if (idx === -1) {
        container.appendChild(document.createTextNode(text.slice(pos)));
        break;
      }
      if (idx > pos) {
        container.appendChild(document.createTextNode(text.slice(pos, idx)));
      }
      var mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + termLen);
      container.appendChild(mark);
      pos = idx + termLen;
    }
  }

  // ---- Search tab ----
  var searchInput = document.getElementById('search-query');
  var searchBtn = document.getElementById('search-btn');
  var searchResults = document.getElementById('search-results');

  async function doSearch() {
    var q = searchInput.value.trim();
    if (!q) return;
    showSpinner(searchResults);
    try {
      var data = await apiCall('POST', '/v1/recall', { query: q, limit: 20 });
      searchResults.textContent = '';
      var result = successData(data, 'search results');
      var entities = Array.isArray(result)
        ? result
        : entityList(result && result.entities, 'search results');
      if (entities.length === 0) { showPlaceholder(searchResults, 'No results for "' + q + '"'); return; }
      searchResults.appendChild(buildEntityTable(entities, q));
    } catch (err) {
      showError(searchResults, err.message);
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  // ---- Browse tab ----
  var allEntities = [];
  var browseFilter = document.getElementById('browse-filter');
  var browseWrap = document.getElementById('browse-table-wrap');

  async function loadBrowse() {
    showSpinner(browseWrap);
    try {
      var data = await apiCall('GET', '/v1/entities?limit=200');
      allEntities = entityList(successData(data, 'entities'), 'entities');
      renderBrowseTable(browseFilter.value);
    } catch (err) {
      showError(browseWrap, err.message);
    }
  }

  function renderBrowseTable(filter) {
    var f = (filter || '').toLowerCase();
    var rows = allEntities.filter(function (e) {
      return !f || e.name.toLowerCase().includes(f) || e.type.toLowerCase().includes(f);
    });
    browseWrap.textContent = '';
    if (rows.length === 0) { showPlaceholder(browseWrap, 'No entities found'); return; }
    browseWrap.appendChild(buildEntityTable(rows, filter || ''));
  }

  browseFilter.addEventListener('input', function () { renderBrowseTable(this.value); });
  document.getElementById('browse-refresh').addEventListener('click', loadBrowse);

  // ---- Analytics tab ----
  var analyticsLoaded = false;

  async function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;
    var container = document.getElementById('analytics-body');
    showSpinner(container);
    try {
      var statsRes = await apiCall('GET', '/v1/stats');
      if (!statsRes.success) throw new Error(statsRes.error || 'Failed to load stats');
      // Also fetch entities for actionable insight calculations
      var entitiesRes = await apiCall('GET', '/v1/entities?limit=500&status=all');
      var allEntitiesForAnalytics = (entitiesRes.success && entitiesRes.data) ? entitiesRes.data : [];
      renderAnalytics(statsRes.data, allEntitiesForAnalytics, container);
    } catch (err) {
      showError(container, err.message);
      analyticsLoaded = false;
    }
  }

  function renderAnalytics(stats, entities, container) {
    container.textContent = '';

    // Stats grid
    var grid = document.createElement('div');
    grid.className = 'stats-grid';
    [
      { label: 'Total Memories', value: stats.totalEntities },
      { label: 'Knowledge Facts', value: stats.totalObservations },
      { label: 'Connections', value: stats.totalRelations },
      { label: 'Topics', value: stats.totalTags },
    ].forEach(function (c) {
      var card = document.createElement('div');
      card.className = 'stat-card';
      var val = document.createElement('div');
      val.className = 'stat-value';
      val.textContent = String(c.value);
      var lbl = document.createElement('div');
      lbl.className = 'stat-label';
      lbl.textContent = c.label;
      card.appendChild(val);
      card.appendChild(lbl);
      grid.appendChild(card);
    });
    container.appendChild(grid);

    // Status distribution
    if (stats.statusDistribution && stats.statusDistribution.length > 0) {
      var statusTitle = document.createElement('h3');
      statusTitle.style.cssText = 'font-size:11px;font-weight:600;margin-bottom:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      statusTitle.textContent = 'Status Distribution';
      container.appendChild(statusTitle);
      var statusGrid = document.createElement('div');
      statusGrid.className = 'stats-grid';
      stats.statusDistribution.forEach(function (s) {
        var card = document.createElement('div');
        card.className = 'stat-card';
        var val = document.createElement('div');
        val.className = 'stat-value';
        val.textContent = String(s.count);
        var lbl = document.createElement('div');
        lbl.className = 'stat-label';
        lbl.textContent = s.status || 'active';
        card.appendChild(val);
        card.appendChild(lbl);
        statusGrid.appendChild(card);
      });
      container.appendChild(statusGrid);
    }

    // Actionable insights section
    if (entities && entities.length > 0) {
      var insightsTitle = document.createElement('h3');
      insightsTitle.style.cssText = 'font-size:11px;font-weight:600;margin:16px 0 10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      insightsTitle.textContent = 'Recent Activity';
      container.appendChild(insightsTitle);

      var now = Date.now();
      var sevenDays = 7 * 24 * 60 * 60 * 1000;
      var thirtyDays = 30 * 24 * 60 * 60 * 1000;

      // Count this week
      var thisWeek = entities.filter(function (e) {
        try { return (now - new Date(e.created_at).getTime()) < sevenDays; } catch (_) { return false; }
      }).length;

      // Stale: not accessed in 30+ days (or never accessed)
      var stale = entities.filter(function (e) {
        if (!e.last_accessed_at) return true;
        try { return (now - new Date(e.last_accessed_at).getTime()) > thirtyDays; } catch (_) { return true; }
      }).length;

      // Archived count
      var archived = entities.filter(function (e) {
        return e.status === 'archived' || e.archived === true;
      }).length;

      // Most recalled (top 1)
      var topRecalled = entities
        .filter(function (e) { return e.access_count && e.access_count > 0; })
        .sort(function (a, b) { return (b.access_count || 0) - (a.access_count || 0); })
        .slice(0, 1);

      var insightCards = [
        { icon: '\ud83d\udcdd', label: 'This Week', value: thisWeek + ' new memories' },
        { icon: '\ud83d\udca4', label: 'Stale Memories', value: stale + ' not accessed in 30+ days' },
        { icon: '\ud83d\udce6', label: 'Archived', value: archived + ' memories' },
      ];
      if (topRecalled.length > 0) {
        var tr = topRecalled[0];
        var trPreview = (tr.observations && tr.observations[0])
          ? (tr.observations[0].length > 40 ? tr.observations[0].slice(0, 40) + '\u2026' : tr.observations[0])
          : tr.name;
        insightCards.unshift({ icon: '\ud83d\udd25', label: 'Most Recalled', value: '\u201c' + trPreview + '\u201d (' + tr.access_count + 'x)' });
      }

      var insightGrid = document.createElement('div');
      insightGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:20px;';
      insightCards.forEach(function (ic) {
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px 16px;font-size:13px;';
        var iconRow = document.createElement('div');
        iconRow.style.cssText = 'font-size:18px;margin-bottom:6px;';
        iconRow.textContent = ic.icon;
        var labelEl = document.createElement('div');
        labelEl.style.cssText = 'font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;';
        labelEl.textContent = ic.label;
        var valueEl = document.createElement('div');
        valueEl.style.cssText = 'color:var(--text-primary);font-weight:500;font-size:13px;';
        valueEl.textContent = ic.value;
        card.appendChild(iconRow);
        card.appendChild(labelEl);
        card.appendChild(valueEl);
        insightGrid.appendChild(card);
      });
      container.appendChild(insightGrid);
    }

    // Type distribution bar chart
    if (stats.typeDistribution && stats.typeDistribution.length > 0) {
      var typeTitle = document.createElement('h3');
      typeTitle.style.cssText = 'font-size:11px;font-weight:600;margin:16px 0 10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      typeTitle.textContent = 'Memory Types';
      container.appendChild(typeTitle);

      var maxCount = stats.typeDistribution[0].count || 1;
      var barChart = document.createElement('div');
      barChart.className = 'bar-chart';
      stats.typeDistribution.forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'bar-row';
        var lbl = document.createElement('div');
        lbl.className = 'bar-label';
        lbl.textContent = t.type;
        lbl.title = t.type;
        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.width = Math.round((t.count / maxCount) * 100) + '%';
        track.appendChild(fill);
        var cnt = document.createElement('div');
        cnt.className = 'bar-count';
        cnt.textContent = String(t.count);
        row.appendChild(lbl);
        row.appendChild(track);
        row.appendChild(cnt);
        barChart.appendChild(row);
      });
      container.appendChild(barChart);
    }

    // Tag cloud
    if (stats.tagDistribution && stats.tagDistribution.length > 0) {
      var tagTitle = document.createElement('h3');
      tagTitle.style.cssText = 'font-size:11px;font-weight:600;margin:16px 0 10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;';
      tagTitle.textContent = 'Topics';
      container.appendChild(tagTitle);

      var maxTagCount = stats.tagDistribution[0].count || 1;
      var tagCloud = document.createElement('div');
      tagCloud.className = 'tag-cloud';
      stats.tagDistribution.forEach(function (t) {
        var pill = document.createElement('span');
        pill.className = 'tag-pill';
        var scale = 0.8 + (t.count / maxTagCount) * 0.9;
        pill.style.fontSize = Math.round(scale * 13) + 'px';
        pill.title = t.count + ' entities';
        pill.textContent = t.tag;
        tagCloud.appendChild(pill);
      });
      container.appendChild(tagCloud);
    }

    if (!stats.typeDistribution || stats.typeDistribution.length === 0) {
      showPlaceholder(container, 'No data yet. Start adding entities.');
    }
  }

  // ---- Manage tab ----
  var allManageEntities = [];
  var manageFilter = '';

  async function loadManage() {
    var tableWrap = document.getElementById('manage-table-wrap');
    if (!tableWrap) return;
    showSpinner(tableWrap);
    try {
      var data = await apiCall('GET', '/v1/entities?limit=500&status=all');
      allManageEntities = entityList(successData(data, 'entities'), 'entities');
      renderManageTable();
    } catch (err) {
      showError(tableWrap, err.message);
    }
  }

  function renderManageTable() {
    var filterInput = document.getElementById('manage-filter');
    var f = (filterInput ? filterInput.value : manageFilter).toLowerCase();
    var rows = allManageEntities.filter(function (e) {
      return !f || e.name.toLowerCase().includes(f) || e.type.toLowerCase().includes(f);
    });

    var tableWrap = document.getElementById('manage-table-wrap');
    if (!tableWrap) return;
    tableWrap.textContent = '';

    if (rows.length === 0) {
      showPlaceholder(tableWrap, 'No entities found');
      return;
    }

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var hrow = document.createElement('tr');
    [['Time', '140px'], ['Memory', '40%'], ['Type', ''], ['Status', ''], ['Tags', ''], ['Actions', '']].forEach(function (hDef) {
      var th = document.createElement('th');
      th.textContent = hDef[0];
      if (hDef[1]) th.style.width = hDef[1];
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (e) {
      var status = e.status || 'active';
      var tr = document.createElement('tr');
      if (status === 'archived') tr.style.opacity = '0.6';

      // Time column
      var tdTime = document.createElement('td');
      tdTime.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:nowrap;';
      try {
        var d = new Date(e.created_at);
        tdTime.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        tdTime.textContent = e.created_at || '\u2014';
      }
      tdTime.title = e.created_at || '';
      tr.appendChild(tdTime);

      // Memory column — first observation as primary, entity name as metadata
      var tdMemory = document.createElement('td');
      var memContent = document.createElement('div');
      var preview = document.createElement('div');
      preview.style.cssText = 'font-size:13px;line-height:1.5;margin-bottom:2px;';
      var firstObs = (e.observations && e.observations.length > 0) ? e.observations[0] : '(no observations)';
      preview.textContent = firstObs.length > 100 ? firstObs.slice(0, 100) + '\u2026' : firstObs;
      memContent.appendChild(preview);
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);';
      var obsCount = e.observations ? e.observations.length : 0;
      meta.textContent = e.name + (obsCount > 1 ? ' \u00b7 ' + obsCount + ' observations' : '');
      memContent.appendChild(meta);
      tdMemory.appendChild(memContent);
      tr.appendChild(tdMemory);

      var tdType = document.createElement('td');
      var typeBadge = document.createElement('span');
      typeBadge.className = 'badge badge-type';
      typeBadge.textContent = e.type;
      tdType.appendChild(typeBadge);
      tr.appendChild(tdType);

      var tdStatus = document.createElement('td');
      var sb = document.createElement('span');
      sb.className = 'badge badge-' + (status === 'archived' ? 'archived' : 'active');
      sb.textContent = status;
      tdStatus.appendChild(sb);
      tr.appendChild(tdStatus);

      var tdTags = document.createElement('td');
      if (e.tags && e.tags.length > 0) {
        e.tags.slice(0, 3).forEach(function (t) {
          var pill = document.createElement('span');
          pill.className = 'tag-pill';
          pill.textContent = t;
          tdTags.appendChild(pill);
        });
        if (e.tags.length > 3) {
          var moreTag = document.createElement('span');
          moreTag.className = 'tag-pill';
          moreTag.style.opacity = '0.6';
          moreTag.textContent = '+' + (e.tags.length - 3);
          tdTags.appendChild(moreTag);
        }
      }
      tr.appendChild(tdTags);

      var tdActions = document.createElement('td');
      var actCell = document.createElement('div');
      actCell.className = 'manage-action-cell';

      if (status === 'archived') {
        var restoreBtn = document.createElement('button');
        restoreBtn.className = 'btn btn-sm btn-secondary';
        restoreBtn.textContent = 'Restore';
        restoreBtn.addEventListener('click', function () {
          restoreBtn.disabled = true;
          restoreBtn.textContent = '...';
          apiCall('POST', '/v1/remember', { name: e.name, type: e.type, observations: [], tags: [] })
            .then(function () { loadManage(); })
            .catch(function (err) {
              restoreBtn.disabled = false;
              restoreBtn.textContent = 'Restore';
              var errEl = document.createElement('div');
              errEl.style.cssText = 'color:var(--danger);padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-xs);margin-top:8px;font-size:13px;';
              errEl.textContent = 'Error: ' + err.message;
              actCell.appendChild(errEl);
              setTimeout(function() { errEl.remove(); }, 5000);
            });
        });
        actCell.appendChild(restoreBtn);
      } else {
        var archiveBtn = document.createElement('button');
        archiveBtn.className = 'btn btn-sm btn-danger';
        archiveBtn.textContent = 'Archive';
        archiveBtn.addEventListener('click', function () {
          if (!confirm('Archive entity "' + e.name + '"? It will be hidden but not deleted.')) return;
          archiveBtn.disabled = true;
          archiveBtn.textContent = '...';
          apiCall('POST', '/v1/forget', { name: e.name })
            .then(function () { loadManage(); })
            .catch(function (err) {
              archiveBtn.disabled = false;
              archiveBtn.textContent = 'Archive';
              var errEl = document.createElement('div');
              errEl.style.cssText = 'color:var(--danger);padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:var(--radius-xs);margin-top:8px;font-size:13px;';
              errEl.textContent = 'Error: ' + err.message;
              actCell.appendChild(errEl);
              setTimeout(function() { errEl.remove(); }, 5000);
            });
        });
        actCell.appendChild(archiveBtn);
      }

      // Remove observation button (only if entity has observations)
      if (e.observations && e.observations.length > 0) {
        var rmObsBtn = document.createElement('button');
        rmObsBtn.className = 'btn btn-sm btn-secondary';
        rmObsBtn.textContent = 'Remove obs';
        rmObsBtn.addEventListener('click', function () {
          var modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000;backdrop-filter:blur(4px);';
          var box = document.createElement('div');
          box.className = 'card';
          box.style.cssText = 'max-width:500px;width:90%;max-height:80vh;overflow-y:auto;';
          var title = document.createElement('h3');
          title.textContent = 'Remove Observation';
          title.style.cssText = 'margin-bottom:12px;font-size:14px;font-weight:600;color:var(--text-primary);';
          box.appendChild(title);
          e.observations.forEach(function(obsText) {
            var label = document.createElement('label');
            label.style.cssText = 'display:block;padding:8px 10px;margin:4px 0;border:1px solid var(--border);border-radius:var(--radius-xs);cursor:pointer;font-size:13px;color:var(--text-secondary);transition:border-color 0.15s;';
            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'obs-select-' + e.name;
            radio.value = obsText;
            radio.style.marginRight = '8px';
            radio.style.accentColor = 'var(--accent)';
            label.appendChild(radio);
            label.appendChild(document.createTextNode(obsText.length > 120 ? obsText.slice(0, 120) + '...' : obsText));
            box.appendChild(label);
          });
          var modalErrEl = document.createElement('div');
          modalErrEl.style.cssText = 'color:var(--danger);font-size:13px;min-height:18px;margin-top:8px;';
          box.appendChild(modalErrEl);
          var btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;justify-content:flex-end;';
          var cancelBtn = document.createElement('button');
          cancelBtn.className = 'btn btn-secondary';
          cancelBtn.textContent = 'Cancel';
          cancelBtn.addEventListener('click', function() { modal.remove(); });
          btnRow.appendChild(cancelBtn);
          var removeBtn = document.createElement('button');
          removeBtn.className = 'btn btn-danger';
          removeBtn.textContent = 'Remove Selected';
          removeBtn.addEventListener('click', function() {
            var selected = box.querySelector('input[name="obs-select-' + e.name + '"]:checked');
            if (!selected) { modalErrEl.textContent = 'Select an observation first.'; return; }
            removeBtn.disabled = true;
            removeBtn.textContent = '...';
            apiCall('POST', '/v1/forget', { name: e.name, observation: selected.value })
              .then(function() { modal.remove(); loadManage(); })
              .catch(function(err) {
                removeBtn.disabled = false;
                removeBtn.textContent = 'Remove Selected';
                modalErrEl.textContent = 'Error: ' + err.message;
              });
          });
          btnRow.appendChild(removeBtn);
          box.appendChild(btnRow);
          modal.appendChild(box);
          modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.remove(); });
          document.body.appendChild(modal);
        });
        actCell.appendChild(rmObsBtn);
      }

      tdActions.appendChild(actCell);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    var manageTableOuter = document.createElement('div');
    manageTableOuter.className = 'table-wrap';
    manageTableOuter.appendChild(table);
    tableWrap.appendChild(manageTableOuter);
  }

  document.getElementById('manage-filter').addEventListener('input', function () { renderManageTable(); });
  document.getElementById('manage-refresh').addEventListener('click', loadManage);

  // ---- Feedback widget ----
  (function initFeedback() {
    var btn = document.getElementById('feedback-btn');
    var panel = document.getElementById('feedback-panel');
    if (!btn || !panel) return;

    var fbType = 'bug';

    btn.addEventListener('click', function () {
      panel.classList.toggle('open');
    });

    // Radio group selection
    panel.querySelectorAll('.fb-radio input').forEach(function (radio) {
      radio.addEventListener('change', function () {
        panel.querySelectorAll('.fb-radio').forEach(function (el) { el.classList.remove('selected'); });
        radio.parentElement.classList.add('selected');
        fbType = radio.value;
      });
    });

    var submitBtn = document.getElementById('fb-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var desc = document.getElementById('fb-desc').value.trim();
        if (!desc) { document.getElementById('fb-desc').focus(); return; }
        var includeSys = document.getElementById('fb-sys').checked;
        var labels = 'feedback,from-dashboard,' + fbType;
        var title = encodeURIComponent('[' + fbType + '] ' + desc.slice(0, 50));
        var bodyText = '## Description\\n' + desc;
        if (includeSys) {
          bodyText += '\\n\\n## System Info\\nVersion: ' + _currentVersion;
        }
        var body = encodeURIComponent(bodyText);
        window.open('https://github.com/PCIRCLE-AI/memesh/issues/new?title=' + title + '&body=' + body + '&labels=' + labels, '_blank');
        panel.classList.remove('open');
        document.getElementById('fb-desc').value = '';
      });
    }

    // Close panel on outside click
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('open');
      }
    });
  })();

  // ---- Settings tab ----
  async function loadSettings() {
    var body = document.getElementById('settings-body');
    body.textContent = '';

    var configRes;
    try {
      configRes = await apiCall('GET', '/v1/config');
    } catch (err) {
      showError(body, 'Failed to load config: ' + err.message);
      return;
    }

    var currentConfig;
    try {
      currentConfig = configData(configRes);
    } catch (err) {
      showError(body, 'Failed to load config: ' + err.message);
      return;
    }

    // --- Status ---
    var capSection = document.createElement('div');
    capSection.className = 'settings-section';
    var capH3 = document.createElement('h3');
    capH3.textContent = 'Status';
    capSection.appendChild(capH3);

    var capGrid = document.createElement('div');
    capGrid.className = 'cap-grid';

    function addCap(label, value, good) {
      var item = document.createElement('div');
      item.className = 'cap-item';
      var lbl = document.createElement('div');
      lbl.className = 'cap-label';
      lbl.textContent = label;
      var val = document.createElement('div');
      val.className = 'cap-value';
      if (good !== undefined) {
        var dot = document.createElement('span');
        dot.className = 'status-dot ' + (good ? 'ok' : 'warn');
        val.appendChild(dot);
      }
      val.appendChild(document.createTextNode(String(value)));
      item.appendChild(lbl);
      item.appendChild(val);
      capGrid.appendChild(item);
    }

    addCap('Memory engine', 'Local FTS5', true);
    addCap('Initial setup', currentConfig.setupCompleted ? 'Complete' : 'Not complete', currentConfig.setupCompleted === true);

    capSection.appendChild(capGrid);
    body.appendChild(capSection);

    // --- General settings section ---
    var genSection = document.createElement('div');
    genSection.className = 'settings-section';
    var genH3 = document.createElement('h3');
    genH3.textContent = 'General';
    genSection.appendChild(genH3);

    // Auto-capture toggle
    var autoGroup = document.createElement('div');
    autoGroup.className = 'form-group';
    autoGroup.style.display = 'flex';
    autoGroup.style.alignItems = 'center';
    autoGroup.style.gap = '10px';

    var autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox';
    autoCheck.id = 'auto-capture';
    autoCheck.style.accentColor = 'var(--accent)';
    autoCheck.checked = currentConfig.autoCapture !== false;

    var autoLabel = document.createElement('label');
    autoLabel.htmlFor = 'auto-capture';
    autoLabel.style.fontSize = '13px';
    autoLabel.style.fontWeight = '600';
    autoLabel.style.cursor = 'pointer';
    autoLabel.textContent = 'Auto-capture';

    autoGroup.appendChild(autoCheck);
    autoGroup.appendChild(autoLabel);
    genSection.appendChild(autoGroup);

    var autoHint = document.createElement('div');
    autoHint.className = 'form-hint';
    autoHint.style.marginLeft = '28px';
    autoHint.textContent = 'Automatically load project memories when a supported agent session starts.';
    genSection.appendChild(autoHint);

    // Auto-update policy
    var updateGroup = document.createElement('div');
    updateGroup.className = 'form-group';
    var updateLabel = document.createElement('label');
    updateLabel.className = 'form-label';
    updateLabel.htmlFor = 'auto-update';
    updateLabel.textContent = 'Automatic updates';
    updateGroup.appendChild(updateLabel);

    var autoUpdateSelect = document.createElement('select');
    autoUpdateSelect.id = 'auto-update';
    autoUpdateSelect.className = 'search-input';
    autoUpdateSelect.style.width = '100%';
    [
      ['off', 'Off'],
      ['patch', 'Patch releases'],
      ['minor', 'Minor releases'],
      ['major', 'All releases'],
    ].forEach(function (option) {
      var el = document.createElement('option');
      el.value = option[0];
      el.textContent = option[1];
      autoUpdateSelect.appendChild(el);
    });
    autoUpdateSelect.value = currentConfig.autoUpdate || 'off';
    updateGroup.appendChild(autoUpdateSelect);
    genSection.appendChild(updateGroup);

    // Session memory limit
    var limitGroup = document.createElement('div');
    limitGroup.className = 'form-group';
    var limitLabel = document.createElement('label');
    limitLabel.className = 'form-label';
    limitLabel.htmlFor = 'session-limit';
    limitLabel.textContent = 'Session memory limit';
    limitGroup.appendChild(limitLabel);

    var limitInput = document.createElement('input');
    limitInput.id = 'session-limit';
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = '100';
    limitInput.step = '1';
    limitInput.className = 'search-input';
    limitInput.style.width = '100%';
    limitInput.value = String(currentConfig.sessionLimit || 10);
    limitGroup.appendChild(limitInput);

    var limitHint = document.createElement('div');
    limitHint.className = 'form-hint';
    limitHint.textContent = 'Number of recent memories loaded for session context (1\u2013100).';
    limitGroup.appendChild(limitHint);
    genSection.appendChild(limitGroup);

    var genSaveRow = document.createElement('div');
    genSaveRow.style.marginTop = '12px';

    var genSaveBtn = document.createElement('button');
    genSaveBtn.className = 'btn btn-primary btn-sm';
    genSaveBtn.textContent = 'Save';

    var genMsg = document.createElement('span');
    genMsg.id = 'general-settings-message';
    genMsg.style.fontSize = '13px';
    genMsg.style.marginLeft = '10px';
    genMsg.style.color = 'var(--success)';
    genMsg.setAttribute('role', 'status');
    limitInput.setAttribute('aria-describedby', genMsg.id);

    genSaveBtn.addEventListener('click', async function () {
      var sessionLimit = Number(limitInput.value);
      if (!Number.isInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 100) {
        genMsg.style.color = 'var(--danger)';
        genMsg.setAttribute('role', 'alert');
        genMsg.textContent = 'Session memory limit must be a whole number from 1 to 100.';
        limitInput.setAttribute('aria-invalid', 'true');
        return;
      }
      limitInput.removeAttribute('aria-invalid');
      genSaveBtn.disabled = true;
      genSaveBtn.textContent = 'Saving\u2026';
      try {
        var res = await apiCall('POST', '/v1/config', {
          autoCapture: autoCheck.checked,
          autoUpdate: autoUpdateSelect.value,
          sessionLimit: sessionLimit,
        });
        if (!res.success) throw new Error(res.error || 'Save failed');
        genMsg.style.color = 'var(--success)';
        genMsg.setAttribute('role', 'status');
        genMsg.textContent = 'Saved!';
        setTimeout(function () { genMsg.textContent = ''; }, 3000);
      } catch (err) {
        genMsg.style.color = 'var(--danger)';
        genMsg.setAttribute('role', 'alert');
        genMsg.textContent = 'Error: ' + err.message;
      } finally {
        genSaveBtn.disabled = false;
        genSaveBtn.textContent = 'Save';
      }
    });

    genSaveRow.appendChild(genSaveBtn);
    genSaveRow.appendChild(genMsg);
    genSection.appendChild(genSaveRow);
    body.appendChild(genSection);
  }

  // ---- Welcome ----
  function showWelcomeWizard() {
    var content = document.getElementById('wizard-content');
    var actions = document.getElementById('wizard-actions');
    content.textContent = '';
    actions.textContent = '';

    var title = document.createElement('h2');
    title.textContent = 'Welcome to MeMesh';
    content.appendChild(title);

    var sub = document.createElement('p');
    sub.className = 'subtitle';
    sub.textContent = 'MeMesh keeps shared agent memory on this machine with local FTS5 search and deterministic rules. No external service configuration is needed.';
    content.appendChild(sub);

    var capList = document.createElement('ul');
    capList.style.margin = '0 0 8px 20px';
    [
      'Remember and recall work across supported agent hosts.',
      'Auto-capture can load project memories when a supported agent session starts.',
      'Ask an already-running agent to use work_package when a digest or visible-transcript package would help. The Dashboard reviews staged proposals; it does not run or wake agents.',
    ].forEach(function (item) {
      var li = document.createElement('li');
      li.style.cssText = 'padding:6px 0;font-size:14px;color:var(--text-secondary);';
      li.textContent = item;
      capList.appendChild(li);
    });
    content.appendChild(capList);

    var doneBtn = document.createElement('button');
    doneBtn.className = 'btn btn-primary';
    doneBtn.textContent = 'Open Dashboard';
    doneBtn.addEventListener('click', closeWizard);
    actions.appendChild(doneBtn);

    document.getElementById('wizard-overlay').classList.remove('hidden');
  }

  function closeWizard() {
    document.getElementById('wizard-overlay').classList.add('hidden');
    // Mark setup completed so wizard doesn't reappear
    apiCall('POST', '/v1/config', { setupCompleted: true });
  }

  // Overlay click does not close onboarding, preventing accidental dismissal.
  document.getElementById('wizard-overlay').addEventListener('click', function (e) {
    if (e.target === this) {
      // Intentionally do nothing — prevent accidental dismissal
    }
  });

  // ---- Init ----
  checkHealth();
  loadBrowse();

  // Check if first-run wizard should appear
  (async function checkFirstRun() {
    try {
      var res = await apiCall('GET', '/v1/config');
      if (res.success && res.data && res.data.config && !res.data.config.setupCompleted) {
        showWelcomeWizard();
      }
    } catch (_err) {
      // Silently ignore — wizard is optional
    }
  })();
})();
  `.trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MeMesh — Dashboard</title>
  <style>${CSS}</style>
</head>
<body>

<div class="header">
  <div>
    <h1 style="margin:0;line-height:1.2">MeMesh</h1>
    <span class="subtitle">powered by pcircle.com</span>
  </div>
  <div class="header-right">
    <div class="meta">
      <span id="health-indicator"><span class="dot"></span>Connecting\u2026</span>
      <span id="version-label" class="version"></span>
    </div>
    <button id="theme-btn" title="Toggle theme" style="background:none;border:1px solid var(--border);border-radius:var(--radius-xs);padding:6px 10px;cursor:pointer;color:var(--text-secondary);font-size:14px;transition:border-color 0.2s ease;">\u2600\ufe0f</button>
  </div>
</div>

<nav class="nav" id="nav">
  <button class="active" data-tab="search">Search</button>
  <button data-tab="browse">Browse</button>
  <button data-tab="analytics">Analytics</button>
  <button data-tab="manage">Manage</button>
  <button data-tab="settings">Settings</button>
</nav>

<div class="content">

  <div class="tab-content active" id="tab-search">
    <div class="card">
      <h2>Search Knowledge</h2>
      <div class="search-row">
        <input class="search-input" id="search-query" type="text" placeholder="Search your memories\u2026 (e.g., \u201cauth\u201d, \u201cdatabase\u201d, \u201cbug fix\u201d)" />
        <button class="btn btn-primary" id="search-btn">Search</button>
      </div>
      <div id="search-results"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-browse">
    <div class="card">
      <h2>All Memories</h2>
      <div class="search-row">
        <input class="search-input" id="browse-filter" type="text" placeholder="Filter by name or type\u2026" />
        <button class="btn btn-secondary" id="browse-refresh">Refresh</button>
      </div>
      <div id="browse-table-wrap"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-analytics">
    <div class="card">
      <h2>Analytics</h2>
      <div id="analytics-body"></div>
    </div>
  </div>

  <div class="tab-content" id="tab-manage">
    <div class="card">
      <h2>Manage Memories</h2>
      <div class="search-row">
        <input class="search-input" id="manage-filter" type="text" placeholder="Filter by name or type\u2026" />
        <button class="btn btn-secondary" id="manage-refresh">Refresh</button>
      </div>
      <div id="manage-body">
        <div id="manage-table-wrap"></div>
      </div>
    </div>
  </div>

  <div class="tab-content" id="tab-settings">
    <div class="card" id="settings-card">
      <h2>Settings</h2>
      <div id="settings-body"></div>
    </div>
  </div>

</div>

<!-- Welcome Wizard Modal -->
<div class="wizard-overlay hidden" id="wizard-overlay">
  <div class="wizard-modal">
    <div id="wizard-content"></div>
    <div class="wizard-actions" id="wizard-actions"></div>
  </div>
</div>

<!-- Feedback widget -->
<button id="feedback-btn">&#x1f4ac; Feedback</button>
<div id="feedback-panel">
  <h3>Send Feedback</h3>
  <div class="fb-radio-group">
    <label class="fb-radio selected"><input type="radio" name="fb-type" value="bug" checked /> Bug</label>
    <label class="fb-radio"><input type="radio" name="fb-type" value="feature" /> Feature</label>
    <label class="fb-radio"><input type="radio" name="fb-type" value="question" /> Question</label>
  </div>
  <textarea id="fb-desc" placeholder="Describe your feedback\u2026"></textarea>
  <div class="fb-sys-row">
    <input type="checkbox" id="fb-sys" checked style="accent-color:var(--accent);" />
    <label for="fb-sys">Include system info</label>
  </div>
  <button class="btn btn-primary" id="fb-submit" style="width:100%;">Open GitHub Issue</button>
</div>

<script>${SCRIPT}</script>
</body>
</html>`;
}
