/**
 * Browser scanner regression tests.
 *
 * The dynamic scanners (JS errors, mobile overflow) require Playwright
 * + a Chromium binary. The contract under test:
 *   - When Playwright is not installed → a single `skipped` finding
 *     with type=js_error or mobile_overflow and confidence=inconclusive.
 *   - When Playwright IS installed but the Chromium binary is missing
 *     (typical fresh checkout: `npm install` ran but `npx playwright
 *     install chromium` did not) → the same `skipped` finding, NOT a
 *     crash that bubbles to the orchestrator's "scanner crashed"
 *     handler.
 *   - Real launch failures (sandbox, GPU init) DO propagate so the
 *     orchestrator's catch handler logs them.
 *
 * We exercise the "binary missing" branch by mocking the dynamic
 * `import('playwright')` to return a module whose `chromium.launch`
 * throws the exact error shape Playwright produces in that case.
 */
import { describe, it, expect, vi } from 'vitest';

describe('browser scanners — graceful degradation', () => {
  it('scanJsErrors returns a skipped finding (inconclusive) when the chromium binary is missing', async () => {
    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => {
          throw new Error(
            "Executable doesn't exist at /home/y/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell",
          );
        },
      },
    }));
    // Force the module under test to re-import the (now-mocked) playwright.
    // vitest's module cache means we have to reset modules first.
    vi.resetModules();
    const mod = await import('../../src/scanners/browser.js');
    const findings = await mod.scanJsErrors('https://example.com/', 'wbh-test/0.1');
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe('js_error');
    expect(f.confidence).toBe('inconclusive');
    expect(f.severity).toBe('info');
    expect(f.message).toMatch(/chromium/i);
    vi.doUnmock('playwright');
    vi.resetModules();
  });

  it('scanMobile returns a skipped finding (inconclusive) when the chromium binary is missing', async () => {
    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => {
          throw new Error(
            "Executable doesn't exist at /home/y/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell",
          );
        },
      },
    }));
    vi.resetModules();
    const mod = await import('../../src/scanners/browser.js');
    const findings = await mod.scanMobile('https://example.com/', 'wbh-test/0.1');
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.type).toBe('mobile_overflow');
    expect(f.confidence).toBe('inconclusive');
    expect(f.message).toMatch(/chromium/i);
    vi.doUnmock('playwright');
    vi.resetModules();
  });

  it('scanJsErrors propagates real launch failures (not "missing binary") to the orchestrator', async () => {
    // A failure that does NOT match the missing-binary pattern should
    // bubble up — the orchestrator's catch handler logs and recovers.
    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => {
          throw new Error('Failed to launch browser: libgbm.so.1 cannot open shared object file');
        },
      },
    }));
    vi.resetModules();
    const mod = await import('../../src/scanners/browser.js');
    await expect(mod.scanJsErrors('https://example.com/', 'wbh-test/0.1')).rejects.toThrow(
      /libgbm/,
    );
    vi.doUnmock('playwright');
    vi.resetModules();
  });
});