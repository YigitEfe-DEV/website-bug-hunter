import type { Finding } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Headless browser scanners: JS errors and mobile responsiveness.
 * Playwright is an OPTIONAL dependency — if not installed, both scanners
 * report "skipped" as info-level findings (one per scan) so the operator
 * knows the report is incomplete.
 */
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
  const browser = await playwright.chromium.launch({ headless: true });
  const findings: Finding[] = [];
  try {
    const context = await browser.newContext({ userAgent, javaScriptEnabled: true });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: { url: string; status: number | null }[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (res) => {
      if (res.status() >= 400 && res.url().startsWith('http')) {
        failedRequests.push({ url: res.url(), status: res.status() });
      }
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      findings.push({
        id: `jserr-nav-${shortHash(url)}`,
        type: 'js_error',
        severity: 'error',
        message: `Browser navigation failed: ${(e as Error).message}`,
        page: url,
      });
    }
    for (const e of consoleErrors) {
      findings.push({
        id: `jserr-c-${shortHash(url + e)}`,
        type: 'js_error',
        severity: 'error',
        message: `Console error: ${truncate(e)}`,
        page: url,
      });
    }
    for (const e of pageErrors) {
      findings.push({
        id: `jserr-p-${shortHash(url + e)}`,
        type: 'js_error',
        severity: 'error',
        message: `Page error: ${truncate(e)}`,
        page: url,
      });
    }
    for (const r of failedRequests) {
      findings.push({
        id: `jserr-net-${shortHash(r.url + r.status)}`,
        type: 'link_broken',
        severity: 'warning',
        message: `Sub-resource HTTP ${r.status}: ${r.url}`,
        page: url,
        detail: { status: r.status },
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
  const browser = await playwright.chromium.launch({ headless: true });
  const findings: Finding[] = [];
  try {
    for (const vp of MOBILE_VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        userAgent,
      });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
            message: `Horizontal overflow at ${vp.name} (${dims.scrollWidth}px > ${dims.clientWidth}px)`,
            page: url,
            detail: dims,
          });
        }
      } catch (e) {
        findings.push({
          id: `mobile-err-${vp.name}-${shortHash(url)}`,
          type: 'mobile_overflow',
          severity: 'warning',
          message: `Mobile render failed at ${vp.name}: ${(e as Error).message}`,
          page: url,
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
    message,
    page: url,
  };
}

function truncate(s: string, n = 240): string {
  return s.length > n ? s.substring(0, n) + '…' : s;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}