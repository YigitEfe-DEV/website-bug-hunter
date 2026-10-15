/** Public API surface for the website-bug-hunter library. */
export { runScan, type ScanInput, type RunScanOptions } from './core/orchestrator.js';
export {
  renderJson,
  renderText,
  renderSarif,
  renderHtml,
  sortFindingsForReport,
  computeHealthScore,
} from './reporting/reporters.js';
export { assertSafeUrl, UnsafeUrlError } from './fetcher/safeUrl.js';
export type { SafeUrlOptions, SafeUrlResult } from './fetcher/safeUrl.js';
export {
  ProgressReporter,
  formatProgressLine,
  type ProgressEvent,
  type ProgressListener,
} from './core/progress.js';
export { ProbeCache, type LinkRecord, type AssetRecord } from './core/cache.js';
export { validateAndSanitize, ReportValidationError } from './core/report.js';
export {
  scanLinks,
  scanImages,
  scanMeta,
  scanRedirects,
  scanAccessibility,
} from './scanners/index.js';
export { extractMeta, detectDuplicates } from './scanners/duplicates.js';
export type {
  Confidence,
  CrawledPage,
  Finding,
  FindingType,
  ScanConfig,
  ScanResult,
  Severity,
} from './types/index.js';
export { DEFAULT_SCAN_CONFIG } from './types/index.js';