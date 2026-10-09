// Extracted from the Claude-online Ogdoad overview prototype (2026-10-09). Reference for the plugin port.

// Shared by the prover (node) and the page (browser): CSV text -> SQLite tables.
(function (root) {
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== '');
  }
  const SCHEMA = {
    invoices: { amount_aud: 'REAL', paid_aud: 'REAL', balance_aud: 'REAL', days_past_due: 'INTEGER' },
    bank_transactions: { credit_in: 'REAL', debit_out: 'REAL' },
    tasks: { runs: 'INTEGER' },
  };
  function loadTables(db, csvByTable) {
    for (const [table, text] of Object.entries(csvByTable)) {
      const [head, ...body] = parseCSV(text);
      const types = SCHEMA[table] || {};
      db.run(`CREATE TABLE ${table} (${head.map((c) => `"${c}" ${types[c] || 'TEXT'}`).join(', ')})`);
      const stmt = db.prepare(`INSERT INTO ${table} VALUES (${head.map(() => '?').join(',')})`);
      for (const r of body) stmt.run(head.map((c, j) => (r[j] === '' || r[j] === undefined ? null : types[c] ? Number(r[j]) : r[j])));
      stmt.free();
    }
  }
  function runQuery(db, sqlText) {
    const res = db.exec(sqlText);
    if (!res.length) return [];
    const { columns, values } = res[res.length - 1];
    return values.map((v) => Object.fromEntries(columns.map((c, j) => [c, v[j]])));
  }
  root.OgdoadData = { parseCSV, loadTables, runQuery, SCHEMA };
})(typeof window !== 'undefined' ? window : globalThis);

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const RECIPES = JSON.parse($('og-recipes').textContent);
  const BAKED = JSON.parse($('og-baked').textContent);
  const TOKENS_CSS = $('og-tokens-css').textContent.trim();
  const CSV = { invoices: $('csv-invoices').textContent, bank_transactions: $('csv-bank_transactions').textContent, tasks: $('csv-tasks').textContent };
  const byId = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

  // Where each recipe sits. Layout is the page's business, not the recipe's.
  const LAYOUT = {
    money: [
      ['cashflow-monthly', 8, 320], ['cashflow-fy-cumulative', 4, 320],
      ['ageing-buckets', 4, 300], ['ageing-by-client', 8, 300],
      ['who-owes-what', 7, 0], ['payment-habits', 5, 400, 500],
      ['invoice-flow', 6, 380, 520], ['late-heatmap', 6, 380, 480],
      ['expenses-by-category', 7, 270], ['match-method', 5, 270],
    ],
    agents: [['tasks-by-agent', 6, 270], ['tasks-throughput', 6, 270], ['relationship-map', 12, 640, 680]],
  };
  const KPI_IDS = ['kpi-outstanding', 'kpi-overdue', 'kpi-collected-month', 'kpi-days-to-pay', 'kpi-open-tasks', 'kpi-agent-success'];

  // ---------------------------------------------------------------- formats (the only functions a chart ever gets)
  const nf0 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
  const neg = (v) => (v < 0 ? '−' : '');
  const compact = (v) => (Math.abs(v) >= 1000 ? nf1.format(Math.abs(v) / 1000) + 'k' : nf0.format(Math.abs(v)));
  const FMT = {
    aud: (v) => (v == null ? '—' : neg(v) + 'A$' + nf0.format(Math.abs(v))),
    audAxis: (v) => neg(v) + 'A$' + compact(v),
    audSigned: (v) => (v < 0 ? '−' : '+') + 'A$' + nf0.format(Math.abs(v)),
    int: (v) => (v == null ? '—' : nf0.format(v)),
    days: (v) => (v == null ? '—' : neg(v) + nf1.format(Math.abs(v)) + ' days'),
    daysAxis: (v) => neg(v) + nf0.format(Math.abs(v)) + 'd',
    pct: (v) => (v == null ? '—' : nf1.format(v) + '%'),
    text: (v) => (v == null ? '—' : String(v)),
  };
  const fmt = (kind) => FMT[kind] || FMT.text;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pretty = (field) => { const s = String(field).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

  // ---------------------------------------------------------------- theme tokens -> concrete colours for canvas
  const probeEl = el('span', { style: 'position:absolute;visibility:hidden;pointer-events:none' });
  document.body.append(probeEl);
  const probeCtx = el('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  let colorCache = new Map();
  const cssColor = (expr) => {
    if (colorCache.has(expr)) return colorCache.get(expr);
    probeEl.style.color = ''; probeEl.style.color = expr;
    probeCtx.clearRect(0, 0, 1, 1); probeCtx.fillStyle = '#000'; probeCtx.fillStyle = getComputedStyle(probeEl).color; probeCtx.fillRect(0, 0, 1, 1);
    const d = probeCtx.getImageData(0, 0, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    colorCache.set(expr, hex);
    return hex;
  };
  const TOKEN = /^var\(--[\w-]+\)$/;
  const resolveTokens = (node) => {
    if (typeof node === 'string') return TOKEN.test(node) ? cssColor(node) : node;
    if (Array.isArray(node)) return node.map(resolveTokens);
    if (node && typeof node === 'object') { const out = {}; for (const k in node) out[k] = resolveTokens(node[k]); return out; }
    return node;
  };
  const setPath = (obj, path, value) => {
    const keys = path.split('.');
    let cur = obj;
    keys.slice(0, -1).forEach((k, i) => { if (cur[k] == null) cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}; cur = cur[k]; });
    cur[keys[keys.length - 1]] = value;
  };
  const expandDots = (row) => { const out = {}; for (const k in row) { if (k.includes('.')) setPath(out, k, row[k]); else out[k] = row[k]; } return out; };

  const baseTheme = () => {
    const c = (name) => cssColor('var(--' + name + ')');
    const axisText = { color: c('muted-foreground'), fontSize: 11, fontFamily: 'Inter, system-ui, sans-serif', hideOverlap: true };
    return {
      color: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => c('chart-' + i)),
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: c('foreground') },
      categoryAxis: { axisLine: { lineStyle: { color: c('border') } }, axisTick: { show: false }, axisLabel: axisText, splitLine: { show: false }, nameTextStyle: axisText },
      valueAxis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: axisText, splitLine: { lineStyle: { color: c('grid') } }, nameTextStyle: axisText },
      legend: { textStyle: { color: c('muted-foreground'), fontSize: 11 }, itemWidth: 10, itemHeight: 10, itemGap: 14, icon: 'roundRect', top: 0, left: 0, right: 0, pageIconColor: c('foreground'), pageIconInactiveColor: c('border'), pageIconSize: 10, pageTextStyle: { color: c('muted-foreground'), fontSize: 11 } },
      tooltip: { backgroundColor: c('card'), borderColor: c('border'), borderWidth: 1, padding: [8, 10], textStyle: { color: c('foreground'), fontSize: 12, fontFamily: 'Inter, system-ui, sans-serif' }, extraCssText: 'border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.14);', axisPointer: { lineStyle: { color: c('muted-foreground') }, shadowStyle: { color: 'rgba(128,128,140,0.10)' } } },
      visualMap: { textStyle: { color: c('muted-foreground'), fontSize: 11 } },
      bar: { label: { color: c('foreground'), fontSize: 11 } },
      line: { endLabel: { color: c('foreground'), fontSize: 11 } },
      sankey: { label: { fontSize: 11 } },
      graph: { label: { fontSize: 11 } },
    };
  };

  // ---------------------------------------------------------------- recipe + rows -> ECharts option (pure)
  function buildOption(recipe, results) {
    const opt = resolveTokens(JSON.parse(JSON.stringify(recipe.chart)));
    if (recipe.bind) for (const [path, name] of Object.entries(recipe.bind)) setPath(opt, path, results[name].map(expandDots).map(resolveTokens));
    else if (Array.isArray(opt.dataset)) opt.dataset = [Object.assign({}, opt.dataset[0], { source: results.query }), ...opt.dataset.slice(1)];
    else opt.dataset = Object.assign({}, opt.dataset, { source: results.query });
    if (opt.legend && !Array.isArray(opt.legend)) opt.legend = Object.assign({ type: 'scroll' }, opt.legend);
    if (opt.xAxis || opt.yAxis) opt.grid = Object.assign({ left: 8, right: 18, top: 16, bottom: 8, containLabel: true }, opt.grid);

    const f = recipe.format || {};
    const fv = fmt(f.value);
    const horizontal = arr(opt.xAxis)[0] && arr(opt.xAxis)[0].type === 'value' && arr(opt.yAxis)[0] && arr(opt.yAxis)[0].type === 'category';
    for (const ax of ['xAxis', 'yAxis']) for (const a of arr(opt[ax])) {
      const kind = f[ax] || f.value;
      if (a.type === 'value' && kind && !(a.axisLabel && a.axisLabel.formatter)) a.axisLabel = Object.assign({}, a.axisLabel, { formatter: FMT[kind + 'Axis'] || FMT[kind] });
    }
    const dimLabel = (d) => { const hit = arr((arr(opt.dataset)[0] || {}).dimensions).find((x) => x && x.name === d); return (hit && hit.displayName) || pretty(d); };
    const valueDim = (series) => { const enc = series.encode || {}; return arr(enc.value)[0] || arr(horizontal ? enc.x : enc.y)[0]; };
    opt.tooltip = Object.assign({ confine: true }, opt.tooltip);
    if (opt.tooltip.formatter == null) {
      if (opt.tooltip.trigger === 'item') {
        opt.tooltip.formatter = (p) => {
          if (p.dataType === 'edge') return esc(p.data.source) + ' → ' + esc(p.data.target) + '<br><b>' + fv(p.data.value) + '</b>';
          const row = p.data;
          const series = arr(opt.series)[p.seriesIndex] || {};
          if (row && typeof row === 'object' && !Array.isArray(row) && series.encode) {
            const enc = series.encode;
            const title = row[arr(enc.itemName)[0]] != null ? row[arr(enc.itemName)[0]] : p.name;
            const dims = arr(enc.tooltip).length ? arr(enc.tooltip) : [valueDim(series)];
            return '<b>' + esc(title) + '</b>' + dims.map((d) => '<br>' + esc(dimLabel(d)) + ': <b>' + esc(fmt((f.fields || {})[d] || f.value)(row[d])) + '</b>').join('');
          }
          return esc(p.name) + '<br><b>' + fv(typeof p.value === 'object' ? p.data && p.data.value : p.value) + '</b>';
        };
      } else opt.tooltip.valueFormatter = fv;
    }
    for (const s of arr(opt.series)) for (const key of ['label', 'endLabel']) {
      if (!s[key] || !s[key].show || s[key].formatter != null) continue;
      s[key] = Object.assign({}, s[key], { formatter: (p) => {
        if (s.type === 'sankey') return p.name + '  ' + fv(p.value);
        let v = p.value;
        if (v && typeof v === 'object' && !Array.isArray(v)) v = v[valueDim(s)]; else if (Array.isArray(v)) v = v[v.length - 1];
        return fv(v);
      } });
    }
    return opt;
  }

  // ---------------------------------------------------------------- query engine
  let db = null; let engine = 'baked';
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
  async function bootEngine() {
    if (typeof initSqlJs === 'undefined') { try { await loadScript('https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js'); } catch (e) { /* fall through to baked rows */ } }
    if (typeof initSqlJs === 'undefined') return;
    const SQL = await initSqlJs();
    db = new SQL.Database();
    OgdoadData.loadTables(db, CSV);
    engine = 'sqljs';
  }
  // Results for one recipe: { query: rows } or { name: rows, ... }, with timing.
  function runRecipe(recipe) {
    const named = recipe.queries || { query: recipe.query };
    const out = {}; const t0 = performance.now();
    for (const [name, text] of Object.entries(named)) out[name] = db ? OgdoadData.runQuery(db, text) : BAKED[recipe.id + (recipe.queries ? ':' + name : '')];
    return { results: out, ms: performance.now() - t0 };
  }

  // ---------------------------------------------------------------- inspector ("show query")
  const SQL_KW = /\b(WITH|RECURSIVE|SELECT|FROM|WHERE|GROUP BY|ORDER BY|LEFT JOIN|CROSS JOIN|JOIN|ON|USING|AS|AND|OR|NOT|IN|IS|NULL|CASE|WHEN|THEN|ELSE|END|UNION ALL|VALUES|DISTINCT|LIMIT|DESC|ASC|BETWEEN|LIKE|OVER|PARTITION BY|SUM|COUNT|AVG|MAX|MIN|ROUND|COALESCE|CAST|INTEGER)\b/g;
  const highlightSql = (text) => esc(text).replace(/('[^']*')|\b(\d+(?:\.\d+)?)\b|(\b[A-Z][A-Z ]*[A-Z]\b)/g, (m, str, num, word) => {
    if (str) return '<span class="str">' + str + '</span>';
    if (num) return '<span class="numlit">' + num + '</span>';
    return word.replace(SQL_KW, '<span class="kw">$1</span>');
  });
  const copyBtn = (getText, label) => {
    const b = el('button', { class: 'qbtn copy', type: 'button' });
    b.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span></span>';
    const span = b.querySelector('span'); span.textContent = label;
    b.addEventListener('click', () => {
      const done = (ok) => { span.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { span.textContent = label; }, 1600); };
      try { navigator.clipboard.writeText(getText()).then(() => done(true), () => done(false)); } catch (e) { done(false); }
    });
    return b;
  };
  function fillInspector(box, recipe, run) {
    box.replaceChildren();
    const named = recipe.queries || { query: recipe.query };
    const sqlText = Object.entries(named).map(([n, t]) => (recipe.queries ? '-- ' + n + '\n' : '') + t).join('\n\n');
    const rowCount = Object.values(run.results).reduce((t, r) => t + r.length, 0);
    const views = {
      Query: () => { const pre = el('pre', { class: 'code', tabindex: '0' }); pre.innerHTML = highlightSql(sqlText).replace(/^(-- .*)$/gm, '<span class="qname">$1</span>'); return pre; },
      'Chart spec': () => el('pre', { class: 'code', tabindex: '0', text: JSON.stringify(Object.assign({ chart: recipe.chart }, recipe.bind ? { bind: recipe.bind } : {}, recipe.format ? { format: recipe.format } : {}), null, 2) }),
      Rows: () => {
        const wrap = el('div', { class: 'rows-wrap' });
        for (const [name, rows] of Object.entries(run.results)) {
          const t = el('table', { class: 'rows' });
          const cols = rows.length ? Object.keys(rows[0]) : [];
          t.append(el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { text: (recipe.queries ? name + ' · ' : '') + c })))));
          const tb = el('tbody');
          rows.slice(0, 60).forEach((r) => tb.append(el('tr', {}, ...cols.map((c) => el('td', { text: r[c] == null ? 'NULL' : String(r[c]).replace(/\n/g, '↵') })))));
          t.append(tb); wrap.append(t);
        }
        return wrap;
      },
    };
    const seg = el('div', { class: 'seg', role: 'tablist' });
    const holder = el('div', { style: 'min-width:0' });
    const show = (name) => { [...seg.children].forEach((b) => b.setAttribute('aria-selected', String(b.textContent === name))); holder.replaceChildren(views[name]()); };
    Object.keys(views).forEach((name) => { const b = el('button', { type: 'button', role: 'tab', text: name }); b.addEventListener('click', () => show(name)); seg.append(b); });
    const meta = el('span', { class: 'mono', text: recipe.id + ' · ' + rowCount + (rowCount === 1 ? ' row' : ' rows') + (engine === 'sqljs' ? ' · ' + run.ms.toFixed(1) + ' ms' : ' · saved rows') });
    box.append(el('div', { class: 'inspect-top' }, seg, meta, copyBtn(() => sqlText, 'Copy SQL')), el('p', { class: 'inspect-note', text: recipe.notes }), holder);
    show('Query');
  }
  const queryButton = (label) => {
    const b = el('button', { class: 'qbtn', type: 'button', 'aria-expanded': 'false', title: 'Show the query behind this' });
    b.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg><span></span>';
    b.querySelector('span').textContent = label;
    return b;
  };

  // ---------------------------------------------------------------- renderers
  const template = (text, row) => text.replace(/\{(\w+)\}/g, (_, k) => (row[k] == null ? '—' : typeof row[k] === 'number' ? nf1.format(row[k]) : row[k]));
  function renderStat(host, recipe, rows) {
    const row = rows[0] || {}; const c = recipe.chart;
    host.dataset.tone = c.tone || '';
    host.append(el('span', { class: 'kpi-label', text: recipe.title }), el('span', { class: 'kpi-value', text: fmt(c.format)(row[c.value]) }));
    const detail = el('span', { class: 'kpi-detail num' });
    if (c.delta) {
      const d = row[c.delta.field]; const good = (c.delta.goodWhen === 'down') === (d < 0);
      detail.append(el('span', { class: 'delta ' + (good ? 'up' : 'down'), text: (d < 0 ? '▼ ' : '▲ ') + FMT[c.delta.format + 'Signed'](d) }), ' ' + template(c.delta.label, row));
    } else if (c.detail) detail.textContent = template(c.detail, row);
    host.append(detail);
  }
  function renderTable(host, recipe, rows) {
    const c = recipe.chart;
    const t = el('table', { class: 'tbl' });
    t.append(el('thead', {}, el('tr', {}, ...c.columns.map((col) => el('th', { class: col.align === 'right' ? 'r' : '', text: col.label })))));
    const tb = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      c.columns.forEach((col, i) => {
        const v = row[col.field];
        const td = el('td', { class: (col.align === 'right' ? 'r' : '') + (i === 0 ? ' strong' : '') });
        if (col.pill) td.append(el('span', { class: 'pill', 'data-tone': col.pill[v] || '', text: v == null ? col.empty || '—' : v }));
        else if (col.bar) { const max = Math.max(...rows.map((r) => r[col.field] || 0)) || 1; const bar = el('i'); bar.style.width = Math.round((48 * (v || 0)) / max) + 'px'; bar.style.background = col.bar; td.append(el('div', { class: 'cellbar' }, bar, el('span', { text: fmt(col.format)(v) }))); }
        else td.textContent = fmt(col.format)(v);
        tr.append(td);
      });
      tb.append(tr);
    }
    t.append(tb);
    host.append(el('div', { class: 'tbl-wrap' }, t));
  }
  const charts = new Map();
  function renderChart(host, recipe, results) {
    if (typeof echarts === 'undefined') { host.append(el('div', { class: 'chart-msg', text: 'The chart library did not load.' })); return; }
    const old = charts.get(recipe.id); if (old) old.dispose();
    const chart = echarts.init(host, baseTheme(), { renderer: 'canvas' });
    chart.setOption(buildOption(recipe, results), true);
    charts.set(recipe.id, chart);
  }

  // ---------------------------------------------------------------- page assembly
  const runs = new Map();
  function drawAll() {
    colorCache = new Map();
    const kpis = $('kpis'); kpis.replaceChildren();
    for (const id of KPI_IDS) {
      const recipe = byId[id]; const run = runRecipe(recipe); runs.set(id, run);
      const tile = el('div', { class: 'kpi' });
      renderStat(tile, recipe, run.results.query);
      const b = queryButton('SQL');
      b.setAttribute('aria-label', 'Show the query behind ' + recipe.title);
      b.addEventListener('click', () => {
        const box = $('kpi-inspect'); const open = box.dataset.open === id && !box.hidden;
        kpis.querySelectorAll('.qbtn').forEach((x) => x.setAttribute('aria-expanded', 'false'));
        box.hidden = open; box.dataset.open = id;
        if (!open) { fillInspector(box, recipe, runs.get(id)); b.setAttribute('aria-expanded', 'true'); }
      });
      tile.append(b); kpis.append(tile);
    }
    const kbox = $('kpi-inspect'); if (!kbox.hidden && kbox.dataset.open) fillInspector(kbox, byId[kbox.dataset.open], runs.get(kbox.dataset.open));

    for (const [group, items] of Object.entries(LAYOUT)) {
      const grid = $('grid-' + group);
      for (const [id, span, height, minWidth] of items) {
        const recipe = byId[id]; const run = runRecipe(recipe); runs.set(id, run);
        let card = document.getElementById('card-' + id);
        if (!card) {
          card = el('article', { class: 'card', id: 'card-' + id, style: '--span:' + span });
          const b = queryButton('Show query');
          const inspect = el('div', { class: 'inspect', hidden: '' });
          b.addEventListener('click', () => { const open = inspect.hidden; inspect.hidden = !open; b.setAttribute('aria-expanded', String(open)); b.querySelector('span').textContent = open ? 'Hide query' : 'Show query'; if (open) fillInspector(inspect, recipe, runs.get(id)); });
          const body = el('div', { class: 'card-body' }, el('div', { class: 'chart', id: 'chart-' + id, style: (height ? 'height:' + height + 'px;' : '') + (minWidth ? 'min-width:' + minWidth + 'px' : '') }));
          card.append(el('div', { class: 'card-head' }, el('h3', { text: recipe.title }), b), body, inspect);
          grid.append(card);
        }
        const host = $('chart-' + id);
        if (recipe.chart.type === 'table') { host.replaceChildren(); renderTable(host, recipe, run.results.query); }
        else renderChart(host, recipe, run.results);
        const inspect = card.querySelector('.inspect'); if (!inspect.hidden) fillInspector(inspect, recipe, run);
      }
    }
    const total = [...runs.values()].reduce((t, r) => t + r.ms, 0);
    const status = $('status'); status.replaceChildren();
    if (engine === 'sqljs') {
      const v = OgdoadData.runQuery(db, 'SELECT sqlite_version() AS v')[0].v;
      status.append(el('span', {}, el('span', { class: 'dot' }), 'Live: ', el('b', { text: RECIPES.length + ' recipes' }), ' ran on SQLite ' + v + ' in your browser in ', el('b', { text: total.toFixed(0) + ' ms' })),
        el('span', { text: '205 invoices · 432 bank rows · 64 tasks' }), el('span', { text: 'Money figures run to 7 Oct 2026, the latest bank row' }));
    } else status.append(el('span', {}, el('span', { class: 'dot warn' }), 'The SQL engine did not load here, so the charts are drawn from rows saved when the same queries were last run.'));
  }

  // ---------------------------------------------------------------- reference tabs
  function fillReference() {
    const json = JSON.stringify(RECIPES, null, 2);
    $('recipes-json').textContent = json;
    $('recipe-count').textContent = String(RECIPES.length);
    $('recipe-size').textContent = (json.length / 1024).toFixed(1) + ' KB';
    $('copy-recipes').replaceWith(copyBtn(() => json, 'Copy JSON'));
    $('tokens-css').textContent = TOKENS_CSS;
    $('copy-tokens').replaceWith(copyBtn(() => TOKENS_CSS, 'Copy CSS'));
  }
  function fillSwatches() {
    const groups = {
      'sw-chart': [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'chart-' + i),
      'sw-sem': ['good', 'warning', 'serious', 'bad', 'neutral', 'age-current', 'age-1-30', 'age-31-60', 'age-61-90', 'age-90-plus', 'diverge-mid'],
      'sw-ui': ['background', 'card', 'muted', 'border', 'grid', 'foreground', 'muted-foreground', 'primary', 'destructive'],
    };
    const css = getComputedStyle(document.documentElement);
    for (const [hostId, names] of Object.entries(groups)) {
      const host = $(hostId); host.replaceChildren();
      for (const n of names) {
        const chip = el('i'); chip.style.background = 'var(--' + n + ')';
        host.append(el('div', { class: 'sw' }, chip, el('div', {}, el('b', { text: '--' + n }), el('span', { text: css.getPropertyValue('--' + n).trim() }), el('span', { text: cssColor('var(--' + n + ')') }))));
      }
    }
  }

  // ---------------------------------------------------------------- tabs, theme, resize
  const TABS = ['overview', 'recipes', 'tokens', 'approach'];
  function showTab(name) {
    if (!TABS.includes(name)) name = 'overview';
    for (const t of TABS) { $('view-' + t).hidden = t !== name; if (t === 'overview') $('view-overview').style.display = t === name ? 'flex' : 'none'; $('tab-' + t).setAttribute('aria-selected', String(t === name)); }
    if (name === 'overview') charts.forEach((c) => c.resize());
    if (name === 'tokens') fillSwatches();
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* hash is a convenience */ }
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const syncThemeButtons = () => { $('theme-light').setAttribute('aria-pressed', String(!isDark())); $('theme-dark').setAttribute('aria-pressed', String(isDark())); };
  let ready = false;
  const onTheme = () => { syncThemeButtons(); if (ready) { drawAll(); if (!$('view-tokens').hidden) fillSwatches(); } };
  $('theme-light').addEventListener('click', () => { document.documentElement.dataset.theme = 'light'; });
  $('theme-dark').addEventListener('click', () => { document.documentElement.dataset.theme = 'dark'; });
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => charts.forEach((c) => c.resize()), 120); });

  syncThemeButtons();
  fillReference();
  const start = () => bootEngine().catch(() => {}).then(() => { ready = true; drawAll(); showTab(location.hash.slice(1) || 'overview'); });
  if (document.fonts && document.fonts.ready) Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]).then(start); else start();
})();
