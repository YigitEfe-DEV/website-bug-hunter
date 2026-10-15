/** Shared types used across scanners, orchestrator, and reporters. */

/** A page that was fetched and inspected. */
export interface CrawledPage {
  /** Final URL after redirects. */
  finalUrl: string;
  /** Original URL (may differ from finalUrl after redirects). */
  requestUrl: string;
  /** HTTP status of the final response. */
  status: number;
  /** HTTP status chain for redirects (final status included). */
  statusChain: number[];
  /** Redirect URLs in order (empty if none). */
  locationChain: string[];
  /** Response Content-Type header value. */
  contentType: string;
  /** Response body (HTML only; truncated). */
  html: string;
  /** When the page was fetched (ms since epoch). */
  fetchedAt: number;
  /** Bytes downloaded for the response body (truncated to maxBytes). */
  bytes: number;
  /** True if the page is HTML (text/html or application/xhtml+xml). */
  isHtml: boolean;
}

export type Severity = 'error' | 'warning' | 'info';

/**
 * Confidence expresses how certain the scanner is that a finding reflects a
 * real defect, not a heuristic guess or transient condition.
 *
 * - `confirmed`   The scanner observed the defect directly. Examples: the
 *                 server returned 404, a redirect chain looped, two
 *                 canonical links were emitted, the page HTML had no
 *                 `<title>` tag.
 * - `probable`    Heuristic evidence — the pattern usually indicates a
 *                 problem but is not definitive. Examples: title shorter
 *                 than recommended length, duplicate titles across pages,
 *                 an `<img>` URL returning text/html (could be a CDN
 *                 misconfiguration or an intentional placeholder).
 * - `inconclusive` The scanner could not verify. Examples: request timed
 *                 out, DNS resolver returned no usable answer, the host
 *                 responded with a generic 5xx. The finding is reported so
 *                 the operator can investigate; it is NOT a confirmed
 *                 defect.
 */
export type Confidence = 'confirmed' | 'probable' | 'inconclusive';

export type FindingType =
  | 'link_broken'
  | 'image_broken'
  | 'redirect_loop'
  | 'redirect_chain_long'
  | 'redirect_downgrade'
  | 'meta_missing'
  | 'meta_invalid'
  | 'js_error'
  | 'mobile_overflow'
  | 'scanner_error'
  | 'request_failed'
  | 'accessibility'
  | 'duplicate';

export interface Finding {
  /** Stable identifier for this finding instance. */
  id: string;
  type: FindingType;
  severity: Severity;
  /** Confidence the scanner holds in the finding — see Confidence. */
  confidence: Confidence;
  /** Short, human-readable message describing the observation. */
  message: string;
  /**
   * The affected page or resource. For findings tied to a single URL
   * (e.g. a broken link), this is that URL. For findings observed on a
   * crawled page (e.g. missing viewport), this is the page URL.
   */
  page: string;
  /**
   * When the same resource-level finding was observed from multiple
   * pages, all pages that referenced it are listed here. Absent when
   * the finding pertains to a single page only.
   */
  affectedPages?: string[];
  /**
   * Brief explanation of WHY this matters — what the user-visible or
   * SEO-impact is. Distinct from `message` (which states WHAT was
   * observed) and `fix` (which says HOW to address it).
   */
  explanation?: string;
  /** Optional source location within the page (e.g., a URL or selector). */
  source?: string;
  /** Optional raw diagnostic context (status code, MIME, error code). */
  detail?: Record<string, unknown>;
  /** Optional actionable recommendation (code snippet or guidance). */
  fix?: string;
}

export interface ScanConfig {
  /** Target URL to begin scanning from. */
  target: string;
  /** Max pages to fetch (default 500). */
  maxPages: number;
  /** Max link depth (default 5). */
  maxDepth: number;
  /** Max time in ms (default 10 min). */
  maxTimeMs: number;
  /** Max bytes per response (default 2 MB). */
  maxBytesPerPage: number;
  /** Concurrency for HTTP fetches (default 4). */
  concurrency: number;
  /** Per-host delay in ms (default 0). */
  rateMs: number;
  /** User-Agent string (defaults to wbh/<version>). */
  userAgent: string;
  /** Request timeout in ms (default 15000). */
  timeoutMs: number;
  /** Respect robots.txt (default true). */
  respectRobots: boolean;
  /** Opt-in to scan private IPs (NEVER set in production). */
  allowPrivate: boolean;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  target: '',
  maxPages: 500,
  maxDepth: 5,
  maxTimeMs: 10 * 60 * 1000,
  maxBytesPerPage: 2 * 1024 * 1024,
  concurrency: 4,
  rateMs: 0,
  userAgent: 'wbh/0.1 (+https://github.com/website-bug-hunter)',
  timeoutMs: 15000,
  respectRobots: true,
  allowPrivate: false,
};

export interface ScanResult {
  target: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  pagesScanned: number;
  pagesFailed: number;
  pagesSkipped: number;
  findings: Finding[];
  errors: string[];
  budgetExhausted: boolean;
  /** Probe cache statistics at scan end (informational). */
  cache?: { linkProbes: number; assetProbes: number };
}