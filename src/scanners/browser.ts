import type { Confidence, Finding } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { sameOrigin } from '../utils/url.js';

/**
 * Headless browser scanners: JS errors and mobile responsiveness.
 * Playwright is an OPTIONAL dependency — if not installed, both scanners
 * report "skipped" as INCONCLUSIVE findings (one per scan) so the operator
 * knows the report is incomplete.
 *
 * Security hardening (R3, R4):
 *   - Chromium is launched headless with the OS sandbox on; we never
 *     pass `--no-sandbox`.
 *   - The browser launch itself has a 30s timeout so a hung Chromium
 *     does not stall the whole scan.
 *   - A `page.route()` handler aborts any navigation/sub-resource
 *     request whose host differs from the scan target's origin. This
 *     prevents remote HTML from making arbitrary calls into the user's
 *     network (e.g. SSRF via JS-issued fetches, file:// probes, etc.).
 *   - Page-level navigation is capped at 30s with `setDefaultNavigationTimeout`.
 *
 * Confidence semantics:
 *   - console.error / pageerror / sub-resource 4xx     confirmed
 *   - skipped (Playwright not installed)               inconclusive
 *   - mobile render error                              inconclusive
 */
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const PAGE_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Install a route guard on the page. Any request whose URL is not
 * same-origin to the target URL is aborted. This is defense in depth
 * against pages that load third-party scripts which attempt to fetch
 * from internal hosts.
 */
async function installRouteGuard(
  page: import('playwright').Page,
  targetUrl: string,
): Promise<void> {
  await page.route('**/*', (route) => {
    try {
      const reqUrl = route.request().url();
      if (!reqUrl.startsWith('http')) {
        return route.abort();
      }
      if (!sameOrigin(reqUrl, targetUrl)) {
        return route.abort();
      }
      return route.continue();
    } catch {
      return route.abort();
    }
  });
}

export async function scanJsErrors(
  url: string,
  userAgent: string,
): Promise<Finding[]> {
  let playwright: typeof import('playwright') | null = null;
  try {
    playwright = await import('playwright');
  } catch {
    return [skipped(url, 'js_error', 'playwright not installed; JS error scan skipped')];
  }
  const browser = await launchOrSkip(playwright, url, 'js_error');
  if (!browser) return [skipped(url, 'js_error', 'chromium browser binary not installed; JS error scan skipped')];
  const findings: Finding[] = [];
  try {
    const context = await browser.newContext({ userAgent, javaScriptEnabled: true });
    context.setDefaultNavigationTimeout(PAGE_NAVIGATION_TIMEOUT_MS);
    context.setDefaultTimeout(PAGE_NAVIGATION_TIMEOUT_MS);
    const page = await context.newPage();
    await installRouteGuard(page, url);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: { url: string; status: number | null }[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (res) => {
      const s = res.status();
      if (s >= 400 && res.url().startsWith('http')) {
        failedRequests.push({ url: res.url(), status: s });
      }
    });
    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: PAGE_NAVIGATION_TIMEOUT_MS,
      });
    } catch (e) {
      findings.push({
        id: `jserr-nav-${shortHash(url)}`,
        type: 'js_error',
        severity: 'error',
        confidence: 'inconclusive',
        message: `Browser navigation failed: ${truncate((e as Error).message)}`,
        page: url,
        explanation:
          'Playwright could not complete the navigation within 30s; the page may be slow, blocked, or the browser crashed.',
        fix: 'Retry with --timeout higher; if it persists, investigate the page manually.',
      });
    }
    for (const e of consoleErrors) {
      findings.push({
        id: `jserr-c-${shortHash(url + e)}`,
        type: 'js_error',
        severity: 'error',
        confidence: 'confirmed',
        message: `Console error: ${truncate(e)}`,
        page: url,
        explanation:
          'The page emitted a console.error. JavaScript errors break interactive features for users.',
        fix: 'Open the page in DevTools, reproduce the error, and fix the offending code.',
      });
    }
    for (const e of pageErrors) {
      findings.push({
        id: `jserr-p-${shortHash(url + e)}`,
        type: 'js_error',
        severity: 'error',
        confidence: 'confirmed',
        message: `Page error: ${truncate(e)}`,
        page: url,
        explanation:
          'An uncaught JavaScript exception fired during page load or runtime.',
        fix: 'Open the page in DevTools, reproduce the error, and fix the offending code.',
      });
    }
    for (const r of failedRequests) {
      // 5xx is treated as inconclusive (transient) but stays at warning
      // severity; "inconclusive" is a confidence level, not a severity.
      const sev = 'warning';
      const conf: Confidence = r.status !== null && r.status >= 500 ? 'inconclusive' : 'confirmed';
      findings.push({
        id: `jserr-net-${shortHash(r.url + r.status)}`,
        type: 'link_broken',
        severity: sev,
        confidence: conf,
        message: `Sub-resource HTTP ${r.status}: ${r.url}`,
        page: url,
        detail: { status: r.status },
        explanation:
          'A sub-resource (script, image, stylesheet, fetch, XHR) returned a non-2xx status. The page may render incorrectly as a result.',
        fix: 'Verify the sub-resource exists and is reachable; fix or replace broken references.',
      });
    }
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
  logger.debug({ url, count: findings.length }, 'js error scan done');
  return findings;
}

export interface MobileCheck {
  viewport: string;
  overflow: boolean;
  scrollWidth: number;
  clientWidth: number;
}

const MOBILE_VIEWPORTS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'mobile-375', width: 375, height: 667 },
  { name: 'tablet-768', width: 768, height: 1024 },
];

export async function scanMobile(
  url: string,
  userAgent: string,
): Promise<Finding[]> {
  let playwright: typeof import('playwright') | null = null;
  try {
    playwright = await import('playwright');
  } catch {
    return [skipped(url, 'mobile_overflow', 'playwright not installed; mobile scan skipped')];
  }
  const browser = await launchOrSkip(playwright, url, 'mobile_overflow');
  if (!browser) {
    return [
      skipped(url, 'mobile_overflow', 'chromium browser binary not installed; mobile scan skipped'),
    ];
  }
  const findings: Finding[] = [];
  try {
    for (const vp of MOBILE_VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        userAgent,
      });
      context.setDefaultNavigationTimeout(PAGE_NAVIGATION_TIMEOUT_MS);
      context.setDefaultTimeout(PAGE_NAVIGATION_TIMEOUT_MS);
      const page = await context.newPage();
      await installRouteGuard(page, url);
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_NAVIGATION_TIMEOUT_MS,
        });
        const dims = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        const overflow = dims.scrollWidth > dims.clientWidth + 1; // 1px tolerance
        if (overflow) {
          findings.push({
            id: `mobile-${vp.name}-${shortHash(url)}`,
            type: 'mobile_overflow',
            severity: 'warning',
            confidence: 'confirmed',
            message: `Horizontal overflow at ${vp.name} (${dims.scrollWidth}px > ${dims.clientWidth}px)`,
            page: url,
            detail: dims,
            explanation:
              'The page is wider than the viewport at this size — users will see a horizontal scrollbar and may miss content.',
            fix: 'Inspect the page at this viewport. Common causes: fixed-width elements, large images, non-wrapping text, or off-canvas UI.',
          });
        }
      } catch (e) {
        findings.push({
          id: `mobile-err-${vp.name}-${shortHash(url)}`,
          type: 'mobile_overflow',
          severity: 'warning',
          confidence: 'inconclusive',
          message: `Mobile render failed at ${vp.name}: ${truncate((e as Error).message)}`,
          page: url,
          explanation:
            'Playwright could not render the page at this viewport within 30s; the mobile check could not be performed.',
          fix: 'Retry; if it persists, the page may be too heavy or anti-bot blocking.',
        });
      }
      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return findings;
}

function skipped(url: string, type: 'js_error' | 'mobile_overflow', message: string): Finding {
  return {
    id: `skip-${type}-${shortHash(url)}`,
    type,
    severity: 'info',
    confidence: 'inconclusive',
    message,
    page: url,
    explanation:
      'The dynamic scanner could not run because Playwright/Chromium is unavailable. Install it (`npx playwright install chromium`) to enable JS-error and mobile checks.',
  };
}

/**
 * Launch Chromium. Distinguishes "browser binary missing" (which is
 * recoverable by the operator via `npx playwright install chromium`)
 * from real launch failures (sandbox / OS-level issues).
 *
 * Returns `null` for the missing-binary case so the caller can emit a
 * `skipped` finding instead of letting the error propagate to the
 * orchestrator's "scanner crashed" handler.
 */
async function launchOrSkip(
  playwright: typeof import('playwright'),
  url: string,
  type: 'js_error' | 'mobile_overflow',
): Promise<import('playwright').Browser | null> {
  try {
    return await playwright.chromium.launch({
      headless: true,
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
    });
  } catch (e) {
    const msg = (e as Error).message || '';
    // Playwright throws a plain `Error` with this exact substring when
    // the cached Chromium binary has not been downloaded yet.
    if (msg.includes("Executable doesn't exist") || /No executable found/.test(msg)) {
      logger.warn(
        { url, type, hint: 'npx playwright install chromium' },
        'chromium browser binary missing; skipping dynamic scanner',
      );
      return null;
    }
    // Anything else is a real launch failure (sandbox, missing libs,
    // GPU init). Re-throw so the orchestrator's catch handler logs it
    // as a scanner_error — the operator should investigate.
    throw e;
  }
}

function truncate(s: string, n = 240): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.substring(0, n) + '…' : s;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}