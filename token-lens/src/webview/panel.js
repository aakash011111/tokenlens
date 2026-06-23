'use strict';

const vscode = acquireVsCodeApi();

// ── State ────────────────────────────────────────────────────

let currentState = null;
let activeTab = 'project';

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-project').classList.toggle('active', tab === 'project');
  document.getElementById('tab-global').classList.toggle('active', tab === 'global');
  if (currentState) renderAll(currentState);
  vscode.postMessage({ type: 'switchTab', tab });
}

function renderAll(state) {
  const s = state[state.activeTab] || state[activeTab] || state.project;
  renderHero(s);
  renderQuickWins(s.advice);
  renderBreakdown(s.breakdown);
  renderTools(s.features);
  renderFeed(s.lastEvent);
}

// ── Helpers ──────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  return Math.floor(m / 60) + 'h ago';
}

function effClass(eff) {
  if (eff >= 60) return 'eff-good';
  if (eff >= 30) return 'eff-warn';
  return 'eff-bad';
}

function effLabel(eff, hasTurns) {
  if (!hasTurns) return 'Waiting for session…';
  if (eff >= 60) return 'Efficient session';
  if (eff >= 30) return 'Room to improve';
  return 'High token waste';
}

// ── Hero ─────────────────────────────────────────────────────

function renderHero(s) {
  const eff     = Math.min(100, Math.max(0, s.efficiency || 0));
  const hasTurns = s.paidCostFmt !== '$0.000' || s.savedCostFmt !== '$0.000';
  const cls     = effClass(eff);

  const card = el('hero-card');
  card.className = 'hero-card ' + (hasTurns ? cls : '');

  el('status-label').textContent  = effLabel(eff, hasTurns);
  el('hero-eff').textContent      = hasTurns ? eff + '%' : '–';
  el('hero-bar-fill').style.width = eff + '%';
  el('paid-cost').textContent     = s.paidCostFmt;
  el('saved-cost').textContent    = s.savedCostFmt;

  if (s.sessionFile) {
    el('session-file').textContent = 'Session: ' + s.sessionFile;
  }
}

// ── Quick Wins ────────────────────────────────────────────────

const SEV_ICON = { good: '✓', warn: '⚠', tip: '→' };

function renderQuickWins(advice) {
  const body = el('quickwins-body');
  if (!advice || advice.length === 0) {
    body.innerHTML = '<div class="no-wins">Collecting data…</div>';
    return;
  }

  body.innerHTML = advice.map(function(a) {
    var icon = SEV_ICON[a.severity] || '→';
    return '<div class="win-item sev-' + escHtml(a.severity) + '">' +
      '<span class="win-icon">' + icon + '</span>' +
      '<div class="win-body">' +
        '<div class="win-title">' + escHtml(a.message) + '</div>' +
        (a.subtext ? '<div class="win-action">' + escHtml(a.subtext) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Where Money Goes ─────────────────────────────────────────

function renderBreakdown(breakdown) {
  const body = el('breakdown-body');
  if (!breakdown || breakdown.total === 0) {
    body.innerHTML = '<div class="no-breakdown">Collecting data…</div>';
    return;
  }

  const total = breakdown.total;
  function pct(v) { return total > 0 ? Math.round((v / total) * 100) : 0; }

  const rows = [
    { label: "Claude's replies",    hint: '5× more expensive than input — ask for shorter answers when possible', color: 'bar-output', value: breakdown.output,    fmt: breakdown.outputFmt },
    { label: 'Fresh context reads', hint: 'Tokens read at full price — gets cheaper as more goes into cache',     color: 'bar-input',  value: breakdown.input,     fmt: breakdown.inputFmt },
    { label: 'From memory (cached)',hint: 'Already cached — only 10% of full price',                             color: 'bar-cache',  value: breakdown.cacheRead, fmt: breakdown.cacheReadFmt },
  ].filter(function(r) { return r.value > 0; });

  var html = rows.map(function(r) {
    var p = pct(r.value);
    return '<div class="breakdown-row" title="' + escHtml(r.hint) + '">' +
      '<div class="breakdown-label-row">' +
        '<span class="breakdown-label">' + escHtml(r.label) + '</span>' +
        '<span class="breakdown-cost">' + escHtml(r.fmt) +
          '<span class="breakdown-pct"> ' + p + '%</span>' +
        '</span>' +
      '</div>' +
      '<div class="breakdown-bar-bg">' +
        '<div class="breakdown-bar-fill ' + r.color + '" style="width:' + p + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('');

  var notables = [
    { label: 'Project rules file (CLAUDE.md)', value: breakdown.claudeMd, fmt: breakdown.claudeMdFmt },
    { label: 'File reads',                     value: breakdown.fileRead, fmt: breakdown.fileReadFmt },
  ].filter(function(n) { return n.value > 0; });

  if (notables.length > 0) {
    html += '<div class="breakdown-notable">' +
      '<div class="breakdown-notable-title">Biggest input drivers</div>' +
      notables.map(function(n) {
        return '<div class="breakdown-notable-item">' +
          '<span>' + escHtml(n.label) + '</span>' +
          '<span>' + escHtml(n.fmt) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  body.innerHTML = html;
}

// ── Active Tools ──────────────────────────────────────────────

const TYPE_DOT = {
  agent: 'dot-agent', skill: 'dot-skill',
  plugin: 'dot-plugin', hook: 'dot-hook', other: 'dot-other',
};

const TYPE_LABEL = {
  agent:  'Runs separately — keeps heavy work out of your context',
  skill:  'Focused prompt — skips exploratory back-and-forth',
  plugin: 'Handles request internally — result only enters context',
  hook:   'Runs on events — zero tokens charged to your session',
  other:  'Ran outside main context',
};

function renderTools(features) {
  const body = el('features-body');
  if (!features || features.length === 0) {
    body.innerHTML = '<div class="no-tools">No tools used yet this session</div>';
    return;
  }

  body.innerHTML = features.map(function(f) {
    var dot      = TYPE_DOT[f.type]   || 'dot-other';
    var label    = TYPE_LABEL[f.type] || 'Ran outside main context';
    var hasSaved  = f.savedCostFmt && f.savedCostFmt !== '$0.000';
    var hasTokens = f.tokensSaved > 0;

    return '<div class="tool-item">' +
      '<span class="tool-dot ' + dot + '"></span>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">' +
          '<span class="tool-name">' + escHtml(f.name) + '</span>' +
          '<span class="tool-type">' + escHtml(f.type) + '</span>' +
        '</div>' +
        '<div style="font-size:10px;opacity:.45;line-height:1.4">' + escHtml(label) + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div class="tool-meta">' + f.firedCount + 'x</div>' +
        (hasTokens ? '<div class="tool-meta">' + escHtml(f.tokensSavedFmt) + ' saved</div>' : '') +
        (hasSaved  ? '<div class="tool-saved">' + escHtml(f.savedCostFmt)  + '</div>'        : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Live Feed ─────────────────────────────────────────────────

const FEED_META = {
  CACHE_HIT:          { dot: 'fdot-cache',   label: 'Reused from memory' },
  COMPACTION_FIRED:   { dot: 'fdot-compact', label: 'Context cleared' },
  CLAUDE_MD_LOAD:     { dot: 'fdot-rules',   label: 'Project rules loaded' },
  LARGE_FILE_READ:    { dot: 'fdot-read',    label: 'Large file in context' },
  REPEATED_FILE_READ: { dot: 'fdot-read',    label: 'File re-read' },
  SKILL_AGENT_USED:   { dot: 'fdot-agent',   label: 'Agent ran' },
  PLUGIN_FIRED:       { dot: 'fdot-plugin',  label: 'Plugin ran' },
  TURN_COMPLETED:     { dot: 'fdot-default', label: 'Turn completed' },
  VAGUE_PROMPT:       { dot: 'fdot-default', label: 'Prompt tip' },
};

let lastEventTimestamp = 0;

function renderFeed(ev) {
  const body = el('last-event-body');
  if (!ev) {
    body.innerHTML = '<div class="no-feed">Waiting for activity…</div>';
    return;
  }

  const meta    = FEED_META[ev.type] || { dot: 'fdot-default', label: ev.type };
  const age     = fmtAge(ev.ageMs || 0);
  const hasPaid  = ev.costFmt      && ev.costFmt      !== '$0.000';
  const hasSaved = ev.savedCostFmt && ev.savedCostFmt !== '$0.000';

  var numbers = '';
  if (hasPaid || hasSaved) {
    numbers = '<div class="feed-numbers">' +
      (hasPaid  ? '<span class="feed-paid">Cost: '   + escHtml(ev.costFmt)      + '</span>' : '') +
      (hasSaved ? '<span class="feed-saved">Saved: ' + escHtml(ev.savedCostFmt) + '</span>' : '') +
    '</div>';
  }

  var tip = ev.advice
    ? '<div class="feed-tip">' + escHtml(ev.advice) + '</div>'
    : '';

  body.innerHTML =
    '<div class="feed-item">' +
      '<div class="feed-top">' +
        '<div class="feed-badge">' +
          '<span class="feed-dot ' + escHtml(meta.dot) + '"></span>' +
          '<span>' + escHtml(meta.label) + '</span>' +
        '</div>' +
        '<span class="feed-age" id="event-age-ticker">' + escHtml(age) + '</span>' +
      '</div>' +
      '<div class="feed-detail">' + escHtml(ev.detail) + '</div>' +
      numbers +
      tip +
    '</div>';

  lastEventTimestamp = Date.now() - (ev.ageMs || 0);
}

// ── Age ticker ───────────────────────────────────────────────

setInterval(function() {
  const ticker = el('event-age-ticker');
  if (ticker && lastEventTimestamp) {
    ticker.textContent = fmtAge(Date.now() - lastEventTimestamp);
  }
}, 5000);

// ── Message handler ──────────────────────────────────────────

window.addEventListener('message', function(e) {
  const msg = e.data;
  if (!msg || msg.type !== 'update') return;

  currentState = msg.state;
  activeTab    = msg.state.activeTab || activeTab;

  document.getElementById('tab-project').classList.toggle('active', activeTab === 'project');
  document.getElementById('tab-global').classList.toggle('active', activeTab === 'global');

  renderAll(currentState);
});
