import type { Confidence, Finding, FindingType, ScanResult } from '../types/index.js';

export function renderJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Richer JSON export that wraps the (already-sanitised) ScanResult with
 * metadata, the effective configuration, a limitations section, and a
 * legal disclaimer. The wrapper itself is not a violation of the
 * "no fabricated data" rule — every field is derived from the scan
 * itself or from the static tool metadata.
 *
 * Output schema is documented in the schema field below. The format
 * is forward-compatible: new keys may be added but no existing key
 * will be removed or have its meaning changed without a major version
 * bump of `schema`.
 */
export function renderJsonExport(result: ScanResult, options?: { toolVersion?: string }): string {
  const toolVersion = options?.toolVersion ?? '0.1.0';
  const sevCounts = countBySeverity(result);
  const confCounts = countByConfidence(result);

  const wrapper: Record<string, unknown> = {
    schema: 'wbh-report-export-1.0',
    tool: {
      name: 'website-bug-hunter',
      version: toolVersion,
      url: 'https://github.com/website-bug-hunter',
    },
    exportedAt: Date.now(),
    scan: {
      target: result.target,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      pagesScanned: result.pagesScanned,
      pagesFailed: result.pagesFailed,
      pagesSkipped: result.pagesSkipped,
      budgetExhausted: result.budgetExhausted,
    },
    configuration: result.config ?? null,
    pages: result.pages ?? [],
    findings: result.findings,
    summary: {
      totalFindings: result.findings.length,
      bySeverity: sevCounts,
      byConfidence: confCounts,
      heuristicScore: computeHealthScore(result.findings),
      cacheStats: result.cache ?? null,
    },
    errors: result.errors,
    limitations: buildLimitations(),
    disclaimer:
      'Only scan sites you are authorized to test. Unauthorized scanning may violate computer-misuse laws and terms of service in your jurisdiction.',
  };

  return JSON.stringify(wrapper, null, 2);
}

/**
 * Render findings as RFC 4180 CSV. One row per finding. The header
 * row is included. Affected-pages arrays are joined with " | ".
 *
 * Fields containing commas, double quotes, or newlines are quoted;
 * embedded double quotes are doubled per RFC 4180. Lines are CRLF-
 * terminated for spreadsheet compatibility.
 *
 * Empty reports produce a header row with no data rows — that's a
 * valid, parseable CSV.
 */
export function renderCsv(result: ScanResult): string {
  const header = [
    'id',
    'type',
    'severity',
    'confidence',
    'page',
    'message',
    'explanation',
    'fix',
    'affected_pages',
    'detail',
  ];
  const lines: string[] = [header.map(csvField).join(',')];
  for (const f of result.findings) {
    const row = [
      f.id,
      f.type,
      f.severity,
      f.confidence,
      f.page,
      f.message,
      f.explanation ?? '',
      f.fix ?? '',
      Array.isArray(f.affectedPages) ? f.affectedPages.join(' | ') : '',
      f.detail ? JSON.stringify(f.detail) : '',
    ];
    lines.push(row.map(csvField).join(','));
  }
  // RFC 4180 specifies CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

function csvField(s: string): string {
  if (s === undefined || s === null) return '';
  const needsQuoting = /[",\r\n]/.test(s);
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function countBySeverity(result: ScanResult): Record<'error' | 'warning' | 'info', number> {
  const out = { error: 0, warning: 0, info: 0 };
  for (const f of result.findings) out[f.severity]++;
  return out;
}

function countByConfidence(result: ScanResult): Record<Confidence, number> {
  const out: Record<Confidence, number> = { confirmed: 0, probable: 0, inconclusive: 0 };
  for (const f of result.findings) {
    out[f.confidence] = (out[f.confidence] || 0) + 1;
  }
  return out;
}

/**
 * Static list of known scope limitations. Kept here (not in the
 * orchestrator) because it documents what the tool does NOT do —
 * it is metadata about the tool, not data about a specific scan.
 */
function buildLimitations(): string[] {
  return [
    'Same-origin crawl only: cross-origin links are probed for status but not crawled.',
    'No authentication: pages behind login are not reachable.',
    'Static HTML only by default: pages rendered entirely via client JS will appear empty and trigger a wave of meta_missing findings. Use --render-js if Playwright is installed.',
    'JS-error and mobile-overflow scans require Playwright; if not installed, those checks are skipped with an INFO finding.',
    'No resume on crash: long scans do not survive restart.',
    'SEO/accessibility findings are scoped heuristics. We do NOT claim full SEO audit or accessibility (WCAG) conformance.',
    'The heuristic health score is project-defined, not an industry standard.',
    'No rate limiting beyond operator-configured --rate; large scans may trigger defensive measures on the target host.',
    'Robots.txt is respected by default; --no-robots is opt-in and should only be used on sites you control or have authorization for.',
    'Static HTML report includes all findings pre-rendered; large reports (>10k findings) may be slow to open in a browser.',
  ];
}

const SEVERITY_ORDER: Record<'error' | 'warning' | 'info', number> = { error: 0, warning: 1, info: 2 };
const CONFIDENCE_ORDER: Record<Confidence, number> = { confirmed: 0, probable: 1, inconclusive: 2 };

/**
 * Sort findings for an actionable report.
 *   - default ("severity"): error → warning → info, then confirmed → probable → inconclusive,
 *     then by type, then stable by id.
 *   - "url": by page URL (locale-aware), stable by id.
 */
export function sortFindingsForReport<T extends { severity: 'error' | 'warning' | 'info'; type: string; id: string }>(
  findings: T[],
  mode: 'severity' | 'url' = 'severity',
): T[] {
  const sorted = [...findings];
  if (mode === 'url') {
    sorted.sort((a, b) => {
      const aPage = (a as unknown as { page?: string }).page ?? '';
      const bPage = (b as unknown as { page?: string }).page ?? '';
      const pd = aPage.localeCompare(bPage);
      if (pd !== 0) return pd;
      return a.id < b.id ? -1 : 1;
    });
    return sorted;
  }
  sorted.sort((a, b) => {
    const sd = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sd !== 0) return sd;
    const aConf = (a as unknown as { confidence?: Confidence }).confidence;
    const bConf = (b as unknown as { confidence?: Confidence }).confidence;
    const cd = (aConf ? CONFIDENCE_ORDER[aConf] : 0) - (bConf ? CONFIDENCE_ORDER[bConf] : 0);
    if (cd !== 0) return cd;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return sorted;
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
  if (result.cache) {
    const urlsChecked = result.cache.linkProbes + result.cache.assetProbes + result.pagesScanned;
    lines.push(`URLs checked: ${urlsChecked} (${result.cache.linkProbes} link probes, ${result.cache.assetProbes} asset probes)`);
  }
  lines.push(`Findings:      ${result.findings.length}`);
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
  lines.push(`Heuristic score: ${computeHealthScore(result.findings)} / 100 (project-specific, see HTML report for formula)`);

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

/**
 * Heuristic health score. Project-specific, NOT an industry standard.
 * Range 0-100. Higher is better.
 *
 *   start at 100
 *   subtract 10 per confirmed error
 *   subtract  5 per probable error
 *   subtract  2 per inconclusive error
 *   subtract  3 per confirmed warning
 *   subtract  1 per probable warning
 *   subtract  0.1 per any info finding
 *   clamp to [0, 100]
 *
 * Inconclusive findings barely affect the score because the scanner
 * could not verify them — penalising hard would punish users for
 * transient timeouts.
 */
export function computeHealthScore(findings: Finding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.severity === 'error') {
      if (f.confidence === 'confirmed') score -= 10;
      else if (f.confidence === 'probable') score -= 5;
      else score -= 2;
    } else if (f.severity === 'warning') {
      if (f.confidence === 'confirmed') score -= 3;
      else if (f.confidence === 'probable') score -= 1;
    } else if (f.severity === 'info') {
      score -= 0.1;
    }
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreFormulaBreakdown(findings: Finding[]): {
  confirmedErrors: number;
  probableErrors: number;
  inconclusiveErrors: number;
  confirmedWarnings: number;
  probableWarnings: number;
  infos: number;
} {
  let confirmedErrors = 0, probableErrors = 0, inconclusiveErrors = 0;
  let confirmedWarnings = 0, probableWarnings = 0, infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') {
      if (f.confidence === 'confirmed') confirmedErrors++;
      else if (f.confidence === 'probable') probableErrors++;
      else inconclusiveErrors++;
    } else if (f.severity === 'warning') {
      if (f.confidence === 'confirmed') confirmedWarnings++;
      else if (f.confidence === 'probable') probableWarnings++;
    } else if (f.severity === 'info') infos++;
  }
  return { confirmedErrors, probableErrors, inconclusiveErrors, confirmedWarnings, probableWarnings, infos };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
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
}

export function renderHtml(result: ScanResult): string {
  const findings = result.findings || [];
  const bySeverity = (s: 'error' | 'warning' | 'info') =>
    findings.filter((f) => f.severity === s).length;
  const byConfidence = (c: Confidence) =>
    findings.filter((f) => f.confidence === c).length;

  const linkProbes = (result.cache && result.cache.linkProbes) || 0;
  const assetProbes = (result.cache && result.cache.assetProbes) || 0;
  const urlsChecked = linkProbes + assetProbes + result.pagesScanned;

  const score = computeHealthScore(findings);
  const scoreClass = score >= 80 ? 'score-good' : score >= 50 ? 'score-mid' : 'score-bad';
  const startedAt = new Date(result.startedAt).toISOString();
  const duration = ((result.durationMs || 0) / 1000).toFixed(2);

  const partial = result.budgetExhausted || (result.pagesFailed || 0) > 0;
  const statusState = partial ? 'partial' : 'success';
  const statusLabel = partial ? 'partial' : 'complete';

  const sorted = sortFindingsForReport(findings);
  const findingsHtml = sorted.map((f, i) => renderFindingCard(f, i)).join('\n');

  // Unique types for the type-filter dropdown
  const types = [...new Set(findings.map((f) => f.type))].sort();

  // Pre-rendered script — embeds the report so the page is self-contained
  // AND the filter/sort UI works without any network call. The result
  // has already been through `validateAndSanitize`, but defense in depth:
// escape `</` to `<\/` so any literal "</script>" string inside a field
// (e.g. a malicious URL in a finding) cannot break out of the surrounding
// <script> tag. The browser tolerates `<\/` inside string literals.
  const reportJson = JSON.stringify(result).replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WBH report — ${escapeHtml(result.target)}</title>
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
      --good: #51cf66;
      --mid: #f5c84b;
      --bad: #ff6b6b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafbfc; --card: #ffffff; --border: #e6e8ec; --text: #1a1d22;
        --muted: #5a6170; --error: #c92a2a; --warning: #b07b00; --info: #1971c2;
        --confirmed: #2b8a3e; --probable: #1971c2; --inconclusive: #5a6170;
        --link: #1864ab; --good: #2b8a3e; --mid: #b07b00; --bad: #c92a2a;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
    header.top {
      padding: 24px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 12px;
    }
    header.top h1 { margin: 0 0 8px; font-size: 18px; }
    header.top .meta { color: var(--muted); font-size: 13px; word-break: break-all; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 999px; font-size: 12px;
      border: 1px solid var(--border); background: var(--card); color: var(--muted);
    }
    .status-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .status-pill[data-state="success"] .dot { background: var(--good); }
    .status-pill[data-state="partial"] .dot { background: var(--mid); }
    .status-banner {
      margin: 16px 24px 0; padding: 12px 16px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--card); font-size: 13px;
    }
    .status-banner.warn { border-color: var(--warning); background: rgba(245,200,75,0.08); }
    .status-banner.hide { display: none; }
    .summary {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px; padding: 16px 24px;
    }
    .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; position: relative; }
    .stat .v { font-size: 24px; font-weight: 600; line-height: 1.1; }
    .stat .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
    .stat.error .v { color: var(--error); }
    .stat.warning .v { color: var(--warning); }
    .stat.info .v { color: var(--info); }
    .stat.confirmed .v { color: var(--confirmed); }
    .stat.probable .v { color: var(--probable); }
    .stat.inconclusive .v { color: var(--inconclusive); }
    .stat .info-icon {
      position: absolute; top: 8px; right: 8px; width: 16px; height: 16px;
      border-radius: 50%; background: var(--border); color: var(--muted);
      font-size: 11px; font-weight: 600; display: inline-flex;
      align-items: center; justify-content: center; cursor: help; user-select: none;
    }
    .stat.score-good .v { color: var(--good); }
    .stat.score-mid .v { color: var(--mid); }
    .stat.score-bad .v { color: var(--bad); }
    .controls {
      padding: 0 24px 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
    }
    .controls button,
    .controls select,
    .controls input[type="text"],
    .controls input[type="search"] {
      background: var(--card); border: 1px solid var(--border); color: var(--text);
      border-radius: 6px; padding: 6px 12px; font-size: 13px;
    }
    .controls select { cursor: pointer; max-width: 200px; }
    .controls button { cursor: pointer; }
    .controls button.active { background: var(--info); color: var(--bg); border-color: var(--info); }
    .controls input[type="search"], .controls input[type="text"] { flex: 1; min-width: 160px; }
    .controls .group-label {
      color: var(--muted); font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.5px; margin-right: 4px;
    }
    .controls .group { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .results-meta {
      padding: 0 24px 12px; color: var(--muted); font-size: 13px;
      display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline;
    }
    .results-meta .reset-filters {
      background: var(--card); border: 1px solid var(--border); color: var(--text);
      border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;
    }
    main { padding: 8px 24px 64px; display: grid; gap: 12px; }
    .finding { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
    .finding header {
      padding: 0; border: none; display: flex; align-items: center;
      gap: 8px; margin-bottom: 6px; flex-wrap: wrap;
    }
    .badge { padding: 2px 8px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
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
    details summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; padding: 2px 0; }
    details pre {
      background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;
      overflow-x: auto; font-size: 12px; margin: 4px 0 0;
      white-space: pre-wrap; word-break: break-word;
    }
    details.fix summary { color: var(--info); }
    details.why summary { color: var(--probable); }
    details ul { margin: 4px 0; padding-left: 18px; font-size: 12px; }
    details ul li { word-break: break-all; }
    .empty { padding: 48px 24px; text-align: center; color: var(--muted); }
    .empty h3 { margin: 0 0 8px; color: var(--text); }
    footer { padding: 16px 24px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); }
    .hide { display: none !important; }
    @media (max-width: 720px) {
      .controls { flex-direction: column; align-items: stretch; }
      .controls .group { flex-wrap: wrap; }
      .controls button, .controls select, .controls input { width: 100%; }
      header.top { flex-direction: column; align-items: flex-start; }
    }
    @media (max-width: 480px) {
      .summary { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <header class="top">
    <h1>Website Bug Hunter — scan report</h1>
    <div class="meta">
      Target <strong>${escapeHtml(result.target)}</strong> · ${escapeHtml(startedAt)} · ${duration}s
    </div>
    <span class="status-pill" data-state="${statusState}"><span class="dot"></span><span>${statusLabel}</span></span>
  </header>

  ${result.budgetExhausted
    ? `<div class="status-banner warn">Scan ended because the budget was exhausted (max pages, max depth, or max time). Results are incomplete.</div>`
    : (result.pagesFailed && result.pagesFailed > 0
      ? `<div class="status-banner warn">${result.pagesFailed} page(s) failed to load. Their findings are reported but the pages themselves were not crawled.</div>`
      : '')
  }

  <section class="summary">
    <div class="stat"><div class="v">${result.pagesScanned}</div><div class="l">pages scanned</div></div>
    <div class="stat"><div class="v">${result.pagesFailed || 0}</div><div class="l">pages failed</div></div>
    ${result.pagesSkipped ? `<div class="stat"><div class="v">${result.pagesSkipped}</div><div class="l">pages skipped (robots)</div></div>` : ''}
    <div class="stat"><div class="v">${urlsChecked}</div><div class="l">URLs checked</div></div>
    <div class="stat error"><div class="v">${bySeverity('error')}</div><div class="l">errors</div></div>
    <div class="stat warning"><div class="v">${bySeverity('warning')}</div><div class="l">warnings</div></div>
    <div class="stat info"><div class="v">${bySeverity('info')}</div><div class="l">info</div></div>
    <div class="stat confirmed"><div class="v">${byConfidence('confirmed')}</div><div class="l">confirmed</div></div>
    <div class="stat probable"><div class="v">${byConfidence('probable')}</div><div class="l">probable</div></div>
    <div class="stat inconclusive"><div class="v">${byConfidence('inconclusive')}</div><div class="l">inconclusive</div></div>
    <div class="stat ${scoreClass}" title="Heuristic health score">
      <div class="v">${score}</div>
      <div class="l">heuristic score</div>
      <span class="info-icon" title="Click for the formula">?</span>
    </div>
    <div class="stat"><div class="v">${duration}s</div><div class="l">duration</div></div>
  </section>

  <div class="controls">
    <span class="group">
      <span class="group-label">Severity</span>
      <button data-kind="severity" data-filter="all" class="active">All</button>
      <button data-kind="severity" data-filter="error">Errors</button>
      <button data-kind="severity" data-filter="warning">Warnings</button>
      <button data-kind="severity" data-filter="info">Info</button>
    </span>
    <span class="group">
      <span class="group-label">Confidence</span>
      <button data-kind="confidence" data-filter="all">All</button>
      <button data-kind="confidence" data-filter="confirmed">Confirmed</button>
      <button data-kind="confidence" data-filter="probable">Probable</button>
      <button data-kind="confidence" data-filter="inconclusive">Inconclusive</button>
    </span>
    <span class="group">
      <span class="group-label">Type</span>
      <select id="typeFilter"><option value="all">All</option>${types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}</select>
    </span>
    <span class="group">
      <span class="group-label">Page</span>
      <input id="pageFilter" type="text" placeholder="filter by page URL" />
    </span>
    <span class="group">
      <span class="group-label">Search</span>
      <input id="search" type="search" placeholder="search message, URL, or type…" />
    </span>
    <span class="group">
      <span class="group-label">Sort</span>
      <select id="sortBy">
        <option value="severity">Severity</option>
        <option value="url">Page URL</option>
      </select>
    </span>
  </div>

  <div class="results-meta">
    <span id="visibleCount">${findings.length}</span>
    <span>of</span>
    <span id="totalCount">${findings.length}</span>
    <span>findings shown</span>
    <button id="resetFilters" class="reset-filters hide">Reset filters</button>
  </div>

  <main id="findings">
    ${findingsHtml || '<div class="empty"><h3>✓ No issues found.</h3><p>The scan completed with no findings.</p></div>'}
  </main>

  <footer>
    Generated by website-bug-hunter 0.1.0 · SSRF protection: every HTTP request goes through <code>assertSafeUrl</code>.
  </footer>

  <script>
    'use strict';
    const REPORT = ${reportJson};
    const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
    const CONFIDENCE_ORDER = { confirmed: 0, probable: 1, inconclusive: 2 };
    const state = {
      filter: { severity: 'all', confidence: 'all', type: 'all', page: '', search: '' },
      sort: 'severity',
    };

    const els = {
      typeFilter: document.getElementById('typeFilter'),
      pageFilter: document.getElementById('pageFilter'),
      search: document.getElementById('search'),
      sortBy: document.getElementById('sortBy'),
      resetFilters: document.getElementById('resetFilters'),
      visibleCount: document.getElementById('visibleCount'),
      totalCount: document.getElementById('totalCount'),
      findings: document.getElementById('findings'),
      summary: document.querySelector('.summary'),
    };

    function applyFilters() {
      const f = state.filter;
      const cards = document.querySelectorAll('.finding');
      let visible = 0;
      cards.forEach((card) => {
        const sev = card.dataset.severity;
        const conf = card.dataset.confidence;
        const typ = card.dataset.type;
        const page = (card.dataset.page || '').toLowerCase();
        const matchesSeverity = f.severity === 'all' || sev === f.severity;
        const matchesConfidence = f.confidence === 'all' || conf === f.confidence;
        const matchesType = f.type === 'all' || typ === f.type;
        const matchesPage = !f.page || page.includes(f.page);
        const matchesSearch = !f.search || (card.textContent || '').toLowerCase().includes(f.search);
        const matches = matchesSeverity && matchesConfidence && matchesType && matchesPage && matchesSearch;
        card.classList.toggle('hide', !matches);
        if (matches) visible++;
      });
      els.visibleCount.textContent = String(visible);
      els.totalCount.textContent = String(cards.length);
      els.resetFilters.classList.toggle(
        'hide',
        f.severity === 'all' && f.confidence === 'all' && f.type === 'all' && !f.page && !f.search,
      );
      const findings = REPORT.findings || [];
      if (cards.length > 0 && visible === 0 && findings.length > 0) {
        if (!document.getElementById('filterEmpty')) {
          els.findings.insertAdjacentHTML(
            'beforeend',
            '<div id="filterEmpty" class="empty"><h3>No findings match the current filters.</h3><p>Try resetting filters or broadening the search.</p></div>',
          );
        }
      } else {
        const fe = document.getElementById('filterEmpty');
        if (fe) fe.remove();
      }
    }

    function sortFindings() {
      const cards = Array.from(document.querySelectorAll('.finding'));
      cards.sort((a, b) => {
        if (state.sort === 'url') {
          const pd = (a.dataset.page || '').localeCompare(b.dataset.page || '');
          if (pd !== 0) return pd;
        } else {
          const sd = SEVERITY_ORDER[a.dataset.severity] - SEVERITY_ORDER[b.dataset.severity];
          if (sd !== 0) return sd;
          const cd = CONFIDENCE_ORDER[a.dataset.confidence] - CONFIDENCE_ORDER[b.dataset.confidence];
          if (cd !== 0) return cd;
          if (a.dataset.type !== b.dataset.type) return a.dataset.type < b.dataset.type ? -1 : 1;
        }
        return 0;
      });
      // Re-append in new order
      const frag = document.createDocumentFragment();
      cards.forEach((c) => frag.appendChild(c));
      els.findings.appendChild(frag);
    }

    document.querySelectorAll('.controls button[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.kind;
        const value = btn.dataset.filter;
        if (kind === 'severity') state.filter.severity = value;
        if (kind === 'confidence') state.filter.confidence = value;
        document.querySelectorAll('.controls button[data-kind="' + kind + '"]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        applyFilters();
      });
    });
    els.typeFilter.addEventListener('change', (e) => { state.filter.type = e.target.value; applyFilters(); });
    els.pageFilter.addEventListener('input', (e) => { state.filter.page = e.target.value.trim().toLowerCase(); applyFilters(); });
    els.search.addEventListener('input', (e) => { state.filter.search = e.target.value.trim().toLowerCase(); applyFilters(); });
    els.sortBy.addEventListener('change', (e) => { state.sort = e.target.value; sortFindings(); });
    els.resetFilters.addEventListener('click', () => {
      state.filter = { severity: 'all', confidence: 'all', type: 'all', page: '', search: '' };
      state.sort = 'severity';
      document.querySelectorAll('.controls button[data-kind="severity"]').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'all'));
      document.querySelectorAll('.controls button[data-kind="confidence"]').forEach((b) => b.classList.remove('active'));
      const fc = document.querySelector('.controls button[data-kind="confidence"][data-filter="all"]');
      if (fc) fc.classList.add('active');
      els.typeFilter.value = 'all';
      els.pageFilter.value = '';
      els.search.value = '';
      els.sortBy.value = 'severity';
      sortFindings();
      applyFilters();
    });

    // Score formula: click the ? icon next to the score to see it.
    (function wireScoreFormula() {
      const scoreStat = els.summary ? Array.from(els.summary.querySelectorAll('.stat')).find((s) => s.querySelector('.info-icon')) : null;
      if (!scoreStat) return;
      const b = (REPORT.findings || []);
      const breakdown = {
        confirmedErrors: 0, probableErrors: 0, inconclusiveErrors: 0,
        confirmedWarnings: 0, probableWarnings: 0, infos: 0,
      };
      for (const f of b) {
        if (f.severity === 'error') {
          if (f.confidence === 'confirmed') breakdown.confirmedErrors++;
          else if (f.confidence === 'probable') breakdown.probableErrors++;
          else breakdown.inconclusiveErrors++;
        } else if (f.severity === 'warning') {
          if (f.confidence === 'confirmed') breakdown.confirmedWarnings++;
          else if (f.confidence === 'probable') breakdown.probableWarnings++;
        } else if (f.severity === 'info') breakdown.infos++;
      }
      scoreStat.querySelector('.info-icon').addEventListener('click', () => {
        alert([
          'Heuristic health score (project-specific, NOT an industry standard).',
          '',
          'score = 100',
          '  - 10 \\u00d7 confirmed errors (' + breakdown.confirmedErrors + ')',
          '  -  5 \\u00d7 probable errors (' + breakdown.probableErrors + ')',
          '  -  2 \\u00d7 inconclusive errors (' + breakdown.inconclusiveErrors + ')',
          '  -  3 \\u00d7 confirmed warnings (' + breakdown.confirmedWarnings + ')',
          '  -  1 \\u00d7 probable warnings (' + breakdown.probableWarnings + ')',
          '  - 0.1 \\u00d7 any info finding (' + breakdown.infos + ')',
          'clamped to [0, 100]',
        ].join('\\n'));
      });
    })();
  </script>
</body>
</html>`;
}

function renderFindingCard(f: Finding, i: number): string {
  const detail = f.detail
    ? `<details class="detail"><summary>Evidence</summary><pre>${escapeHtml(JSON.stringify(f.detail, null, 2))}</pre></details>`
    : '';
  const fix = f.fix
    ? `<details class="fix" open><summary>Fix</summary><pre>${escapeHtml(f.fix)}</pre></details>`
    : '';
  const explanation = f.explanation
    ? `<details class="why" open><summary>Why this matters</summary><p>${escapeHtml(f.explanation)}</p></details>`
    : '';
  const affected = f.affectedPages && f.affectedPages.length > 1
    ? `<details class="affected"><summary>Also on ${f.affectedPages.length - 1} other page${f.affectedPages.length - 1 === 1 ? '' : 's'}</summary><ul>${f.affectedPages.map((p) => `<li><a href="${escapeHtml(p)}" rel="noopener">${escapeHtml(p)}</a></li>`).join('')}</ul></details>`
    : '';
  return `<article class="finding finding-${escapeHtml(f.severity)}" data-index="${i}" data-severity="${escapeHtml(f.severity)}" data-confidence="${escapeHtml(f.confidence)}" data-type="${escapeHtml(f.type)}" data-page="${escapeHtml(f.page || '')}">
  <header>
    <span class="badge severity">${escapeHtml(f.severity)}</span>
    <span class="badge confidence confidence-${escapeHtml(f.confidence)}">${escapeHtml(f.confidence)}</span>
    <span class="type">${escapeHtml(f.type)}</span>
  </header>
  <p class="msg">${escapeHtml(f.message)}</p>
  <p class="page"><a href="${escapeHtml(f.page)}" rel="noopener">${escapeHtml(f.page)}</a></p>
  ${explanation}
  ${fix}
  ${detail}
  ${affected}
</article>`;
}