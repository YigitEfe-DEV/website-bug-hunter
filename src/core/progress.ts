/**
 * Scan progress reporter. Emits discrete events the CLI can subscribe to.
 * Does NOT compute completion percentages — we don't know the total page
 * count up-front, and inventing one would be misleading.
 */

export type ProgressEvent =
  | { kind: 'started'; target: string; maxPages: number; maxDepth: number }
  | { kind: 'page-queued'; url: string; depth: number; queueSize: number }
  | { kind: 'page-fetching'; url: string }
  | { kind: 'page-scanned'; url: string; status: number; pagesScanned: number; pagesFailed: number; queueSize: number }
  | { kind: 'page-failed'; url: string; code: string; pagesScanned: number; pagesFailed: number; queueSize: number }
  | { kind: 'page-skipped-robots'; url: string }
  | { kind: 'finding'; type: string; severity: string; message: string }
  | { kind: 'cache-hit'; kind2: 'link' | 'asset'; url: string }
  | { kind: 'redirect-chain'; url: string; hops: number }
  | { kind: 'finished'; pagesScanned: number; pagesFailed: number; findings: number; budgetExhausted: boolean; durationMs: number };

export type ProgressListener = (e: ProgressEvent) => void;

export class ProgressReporter {
  private listeners: ProgressListener[] = [];
  private stats = {
    pagesScanned: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
    cacheHits: 0,
    findings: 0,
  };

  on(listener: ProgressListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: ProgressEvent): void {
    if (event.kind === 'page-scanned') this.stats.pagesScanned++;
    if (event.kind === 'page-failed') this.stats.pagesFailed++;
    if (event.kind === 'finding') this.stats.findings++;
    if (event.kind === 'cache-hit') this.stats.cacheHits++;
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // Listener errors must not crash the scan.
      }
    }
  }

  statsSnapshot() {
    return { ...this.stats };
  }
}

/**
 * Format a progress event as a single short line for stderr. Designed
 * to be compact so it doesn't drown out the actual scan work.
 */
export function formatProgressLine(e: ProgressEvent): string | null {
  switch (e.kind) {
    case 'started':
      return `start  target=${e.target} maxPages=${e.maxPages} maxDepth=${e.maxDepth}`;
    case 'page-fetching':
      return `fetch  ${truncate(e.url, 80)}`;
    case 'page-scanned':
      return `scanned ${truncate(e.url, 60)}  ${e.status}  (${e.pagesScanned} ok, ${e.pagesFailed} failed, ${e.queueSize} queued)`;
    case 'page-failed':
      return `failed  ${truncate(e.url, 60)}  ${e.code}  (${e.pagesScanned} ok, ${e.pagesFailed} failed, ${e.queueSize} queued)`;
    case 'page-skipped-robots':
      return `robots-skip  ${truncate(e.url, 80)}`;
    case 'finding':
      return `finding ${e.severity.padEnd(7)} ${e.type.padEnd(18)} ${truncate(e.message, 60)}`;
    case 'cache-hit':
      return null; // Too noisy.
    case 'redirect-chain':
      return `redirects  ${truncate(e.url, 60)}  ${e.hops} hops`;
    case 'finished':
      return `done  scanned=${e.pagesScanned} failed=${e.pagesFailed} findings=${e.findings} duration=${(e.durationMs / 1000).toFixed(2)}s${e.budgetExhausted ? ' (budget exhausted)' : ''}`;
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}