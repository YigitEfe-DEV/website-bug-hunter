import type { Confidence, ScanResult, FindingType } from '../types/index.js';

export function renderJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Sort findings for an actionable report:
 *   1. errors first, then warnings, then notes
 *   2. within a severity, group by type
 *   3. within a type, stable by id
 */
export function sortFindingsForReport<
  T extends { severity: 'error' | 'warning' | 'info'; type: string; id: string },
>(findings: T[]): T[] {
  const sev = (s: string) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);
  return [...findings].sort((a, b) => {
    const sd = sev(a.severity) - sev(b.severity);
    if (sd !== 0) return sd;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export function renderText(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(`Website Bug Hunter — scan report`);
  lines.push(`Target:        ${result.target}`);
  lines.push(`Started:       ${new Date(result.startedAt).toISOString()}`);
  lines.push(`Duration:      ${(result.durationMs / 1000).toFixed(2)}s`);
  lines.push(`Pages scanned: ${result.pagesScanned}`);
  lines.push(`Pages failed:  ${result.pagesFailed}`);
  if (result.pagesSkipped) lines.push(`Pages skipped (robots.txt): ${result.pagesSkipped}`);
  lines.push(`Findings:      ${result.findings.length}`);
  if (result.cache) {
    lines.push(`Cache:         ${result.cache.linkProbes} link probes, ${result.cache.assetProbes} asset probes`);
  }
  if (result.budgetExhausted) {
    lines.push(`Budget:        EXHAUSTED (results may be incomplete)`);
  }
  if (result.errors.length > 0) {
    lines.push('');
    lines.push(`Errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 20)) lines.push(`  - ${e}`);
    if (result.errors.length > 20) lines.push(`  ... ${result.errors.length - 20} more`);
  }

  // Severity + confidence summary
  const sevCounts = { error: 0, warning: 0, info: 0 };
  const confCounts: Record<Confidence, number> = { confirmed: 0, probable: 0, inconclusive: 0 };
  for (const f of result.findings) {
    sevCounts[f.severity]++;
    confCounts[f.confidence]++;
  }
  lines.push('');
  lines.push(
    `By severity:  ${sevCounts.error} errors · ${sevCounts.warning} warnings · ${sevCounts.info} info`,
  );
  lines.push(
    `By confidence: ${confCounts.confirmed} confirmed · ${confCounts.probable} probable · ${confCounts.inconclusive} inconclusive`,
  );

  const sorted = sortFindingsForReport(result.findings);
  const grouped = groupBy(sorted, (f) => f.type);
  lines.push('');
  for (const [type, items] of grouped) {
    lines.push(`▸ ${type} (${items.length})`);
    for (const f of items) {
      const conf = f.confidence.padEnd(11);
      lines.push(
        `    [${f.severity.padEnd(7)}] [${conf}] ${f.message}  (${truncate(f.page, 60)})`,
      );
      if (f.affectedPages && f.affectedPages.length > 1) {
        lines.push(`              also on: ${f.affectedPages.slice(1, 6).map((p) => truncate(p, 50)).join(', ')}${f.affectedPages.length > 6 ? ` …+${f.affectedPages.length - 6}` : ''}`);
      }
      if (f.explanation) {
        lines.push(`              why:    ${truncate(f.explanation, 80)}`);
      }
      if (f.fix) {
        lines.push(`              fix:    ${truncate(f.fix, 80)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderSarif(result: ScanResult): string {
  const rules = new Map<string, { name: string; shortDesc: string }>();
  for (const f of result.findings) {
    if (!rules.has(f.type)) {
      rules.set(f.type, { name: f.type, shortDesc: f.message.substring(0, 80) });
    }
  }
  const sarifRules = Array.from(rules.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    shortDescription: { text: info.shortDesc },
    defaultConfiguration: { level: severityToSarif(defaultSeverity(id as FindingType)) },
  }));

  const results = result.findings.map((f) => ({
    ruleId: f.type,
    level: severityToSarif(f.severity),
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.page },
        },
        properties: {
          ...f.detail,
          fix: f.fix,
          confidence: f.confidence,
          explanation: f.explanation,
          affectedPages: f.affectedPages,
        },
      },
    ],
  }));

  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'website-bug-hunter',
            version: '0.1.0',
            informationUri: 'https://github.com/website-bug-hunter',
            rules: sarifRules,
          },
        },
        results,
        properties: {
          target: result.target,
          pagesScanned: result.pagesScanned,
          durationMs: result.durationMs,
        },
      },
    ],
  });
}

function severityToSarif(s: 'error' | 'warning' | 'info'): string {
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warning';
  return 'note';
}

function defaultSeverity(type: FindingType): 'error' | 'warning' | 'info' {
  switch (type) {
    case 'link_broken':
    case 'image_broken':
    case 'redirect_loop':
    case 'redirect_chain_long':
    case 'js_error':
    case 'request_failed':
    case 'scanner_error':
      return 'error';
    case 'redirect_downgrade':
    case 'meta_missing':
    case 'meta_invalid':
    case 'mobile_overflow':
    case 'accessibility':
    case 'duplicate':
      return 'warning';
  }
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of arr) {
    const k = key(x);
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

export function renderHtml(result: ScanResult): string {
  const escape = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  const bySeverity = (s: 'error' | 'warning' | 'info') =>
    result.findings.filter((f) => f.severity === s).length;
  const byConfidence = (c: Confidence) =>
    result.findings.filter((f) => f.confidence === c).length;
  const sorted = sortFindingsForReport(result.findings);
  const findingsHtml = sorted
    .map((f) => {
      const detail = f.detail
        ? `<details class="detail"><summary>Evidence</summary><pre>${escape(JSON.stringify(f.detail, null, 2))}</pre></details>`
        : '';
      const fix = f.fix
        ? `<details class="fix" open><summary>Fix</summary><pre>${escape(f.fix)}</pre></details>`
        : '';
      const explanation = f.explanation
        ? `<details class="why" open><summary>Why this matters</summary><p>${escape(f.explanation)}</p></details>`
        : '';
      const affected = f.affectedPages && f.affectedPages.length > 1
        ? `<details class="affected"><summary>Also on ${f.affectedPages.length - 1} other page${f.affectedPages.length - 1 === 1 ? '' : 's'}</summary><ul>${f.affectedPages.map((p) => `<li><a href="${escape(p)}" rel="noopener">${escape(p)}</a></li>`).join('')}</ul></details>`
        : '';
      return `<article class="finding finding-${f.severity} confidence-${f.confidence}" data-type="${escape(f.type)}" data-confidence="${escape(f.confidence)}">
  <header>
    <span class="badge severity">${escape(f.severity)}</span>
    <span class="badge confidence confidence-${f.confidence}">${escape(f.confidence)}</span>
    <span class="type">${escape(f.type)}</span>
  </header>
  <p class="msg">${escape(f.message)}</p>
  <p class="page"><a href="${escape(f.page)}" rel="noopener">${escape(f.page)}</a></p>
  ${explanation}
  ${fix}
  ${detail}
  ${affected}
</article>`;
    })
    .join('\n');

  const cache = result.cache
    ? `<div class="stat"><div class="v">${result.cache.linkProbes}</div><div class="l">link probes (cached)</div></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WBH report — ${escape(result.target)}</title>
  <style>
    :root {
      --bg: #0f1115;
      --card: #181b22;
      --border: #2a2f3a;
      --text: #e6e8ee;
      --muted: #8c93a3;
      --error: #ff6b6b;
      --warning: #f5c84b;
      --info: #74c0fc;
      --confirmed: #51cf66;
      --probable: #74c0fc;
      --inconclusive: #8c93a3;
      --link: #8ab4ff;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafbfc;
        --card: #ffffff;
        --border: #e6e8ec;
        --text: #1a1d22;
        --muted: #5a6170;
        --error: #c92a2a;
        --warning: #b07b00;
        --info: #1971c2;
        --confirmed: #2b8a3e;
        --probable: #1971c2;
        --inconclusive: #5a6170;
        --link: #1864ab;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    header.top { padding: 24px; border-bottom: 1px solid var(--border); }
    header.top h1 { margin: 0 0 8px; font-size: 18px; }
    header.top .meta { color: var(--muted); font-size: 13px; word-break: break-all; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; padding: 16px 24px; }
    .summary .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
    .summary .stat .v { font-size: 24px; font-weight: 600; }
    .summary .stat .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat.error .v { color: var(--error); }
    .stat.warning .v { color: var(--warning); }
    .stat.info .v { color: var(--info); }
    .stat.confirmed .v { color: var(--confirmed); }
    .stat.probable .v { color: var(--probable); }
    .stat.inconclusive .v { color: var(--inconclusive); }
    .controls {
      padding: 0 24px 12px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .controls button {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .controls button.active { background: var(--info); color: var(--bg); border-color: var(--info); }
    .controls input[type="search"] {
      flex: 1;
      min-width: 200px;
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }
    main { padding: 8px 24px 64px; display: grid; gap: 12px; }
    .finding { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
    .finding header { padding: 0; border: none; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge.severity { background: rgba(255,255,255,0.04); }
    .finding-error .badge.severity { background: rgba(255,107,107,0.15); color: var(--error); }
    .finding-warning .badge.severity { background: rgba(245,200,75,0.15); color: var(--warning); }
    .finding-info .badge.severity { background: rgba(116,192,252,0.15); color: var(--info); }
    .badge.confidence.confirmed { background: rgba(81,207,102,0.15); color: var(--confirmed); }
    .badge.confidence.probable { background: rgba(116,192,252,0.15); color: var(--probable); }
    .badge.confidence.inconclusive { background: rgba(140,147,163,0.15); color: var(--inconclusive); }
    .type { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }
    .msg { margin: 4px 0; font-size: 14px; }
    .page { margin: 4px 0; font-size: 12px; color: var(--muted); word-break: break-all; }
    .page a { color: var(--link); text-decoration: none; }
    .page a:hover { text-decoration: underline; }
    details { margin-top: 8px; }
    details summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; }
    details pre { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; margin: 4px 0 0; }
    details.fix summary { color: var(--info); }
    details.why summary { color: var(--probable); }
    details ul { margin: 4px 0; padding-left: 18px; font-size: 12px; }
    .empty { padding: 48px 24px; text-align: center; color: var(--muted); }
    footer { padding: 16px 24px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); }
    .hide { display: none !important; }
    @media (max-width: 600px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <header class="top">
    <h1>Website Bug Hunter — scan report</h1>
    <div class="meta">Target <strong>${escape(result.target)}</strong> · ${escape(
      new Date(result.startedAt).toISOString(),
    )} · ${(result.durationMs / 1000).toFixed(2)}s${result.budgetExhausted ? ' · budget exhausted' : ''}</div>
  </header>
  <section class="summary">
    <div class="stat"><div class="v">${result.pagesScanned}</div><div class="l">pages scanned</div></div>
    <div class="stat"><div class="v">${result.pagesFailed}</div><div class="l">pages failed</div></div>
    ${result.pagesSkipped ? `<div class="stat"><div class="v">${result.pagesSkipped}</div><div class="l">pages skipped</div></div>` : ''}
    <div class="stat error"><div class="v">${bySeverity('error')}</div><div class="l">errors</div></div>
    <div class="stat warning"><div class="v">${bySeverity('warning')}</div><div class="l">warnings</div></div>
    <div class="stat info"><div class="v">${bySeverity('info')}</div><div class="l">info</div></div>
    <div class="stat confirmed"><div class="v">${byConfidence('confirmed')}</div><div class="l">confirmed</div></div>
    <div class="stat probable"><div class="v">${byConfidence('probable')}</div><div class="l">probable</div></div>
    <div class="stat inconclusive"><div class="v">${byConfidence('inconclusive')}</div><div class="l">inconclusive</div></div>
    ${cache}
  </section>
  <div class="controls">
    <button data-filter="all" data-kind="severity" class="active">All</button>
    <button data-filter="error" data-kind="severity">Errors</button>
    <button data-filter="warning" data-kind="severity">Warnings</button>
    <button data-filter="info" data-kind="severity">Info</button>
    <button data-filter="confirmed" data-kind="confidence">Confirmed</button>
    <button data-filter="probable" data-kind="confidence">Probable</button>
    <button data-filter="inconclusive" data-kind="confidence">Inconclusive</button>
    <input id="search" type="search" placeholder="Filter by message, URL, or type…" />
  </div>
  <main id="findings">
    ${findingsHtml || '<div class="empty">No findings. ✓</div>'}
  </main>
  <footer>Generated by website-bug-hunter 0.1.0. SSRF protection: every HTTP request goes through <code>assertSafeUrl</code>.</footer>
  <script>
    const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    let currentFilter = 'all';
    let currentFilterKind = 'severity'; // 'severity' or 'confidence'
    let currentSearch = '';
    document.querySelectorAll('.controls button[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.controls button[data-filter]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter || 'all';
        currentFilterKind = btn.dataset.kind || 'severity';
        applyFilters();
      });
    });
    document.getElementById('search').addEventListener('input', (e) => {
      currentSearch = e.target.value.toLowerCase();
      applyFilters();
    });
    function applyFilters() {
      const cards = document.querySelectorAll('.finding');
      cards.forEach((card) => {
        const sev = card.classList.contains('finding-error') ? 'error'
          : card.classList.contains('finding-warning') ? 'warning' : 'info';
        const conf = card.dataset.confidence || '';
        let matchesFilter = true;
        if (currentFilterKind === 'severity') {
          matchesFilter = currentFilter === 'all' || sev === currentFilter;
        } else {
          matchesFilter = currentFilter === 'all' || conf === currentFilter;
        }
        const text = (card.textContent || '').toLowerCase();
        const matchesSearch = !currentSearch || text.includes(currentSearch);
        card.classList.toggle('hide', !(matchesFilter && matchesSearch));
      });
    }
  </script>
</body>
</html>`;
}