import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runScan } from '../core/orchestrator.js';
import {
  renderJson,
  renderText,
  renderSarif,
  renderHtml,
  renderJsonExport,
  renderCsv,
} from '../reporting/reporters.js';
import { ProgressReporter, formatProgressLine } from '../core/progress.js';
import { ProbeCache } from '../core/cache.js';
import { logger } from '../utils/logger.js';
import { version } from './version.js';

interface CliOptions {
  maxPages?: string;
  maxDepth?: string;
  maxTime?: string;
  concurrency?: string;
  rate?: string;
  userAgent?: string;
  timeout?: string;
  output?: string;
  format?: 'json' | 'text' | 'sarif' | 'html' | 'csv' | 'export';
  noRobots?: boolean;
  allowPrivate?: boolean;
  quiet?: boolean;
  progress?: boolean;
  cacheCapacity?: string;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('wbh')
    .description('Open-source website bug & quality scanner')
    .version(version)
    .argument('<url>', 'Target URL to scan (http:// or https://)')
    .option('--max-pages <n>', 'Max pages to scan', '500')
    .option('--max-depth <n>', 'Max link depth', '5')
    .option('--max-time <ms>', 'Max total time in ms', '600000')
    .option('--concurrency <n>', 'Parallel fetches', '4')
    .option('--rate <ms>', 'Per-request delay in ms', '0')
    .option('--user-agent <ua>', 'User-Agent string')
    .option('--timeout <ms>', 'Per-request timeout in ms', '15000')
    .option('--output <file>', 'Write report to file (default stdout)')
    .option('--format <fmt>', 'json|text|sarif|html|csv|export', 'text')
    .option('--no-robots', 'Ignore robots.txt')
    .option('--allow-private', 'Allow scanning private IP ranges (NEVER in production)')
    .option('--quiet', 'Suppress info logs')
    .option('--progress', 'Print per-page progress to stderr')
    .option('--cache-capacity <n>', 'Probe cache capacity (entries)', '50000')
    .action(async (url: string, opts: CliOptions) => {
      if (opts.quiet) {
        process.env['WBH_LOG_LEVEL'] = 'error';
      }

      const progress = new ProgressReporter();
      let unsub: (() => void) | null = null;
      if (opts.progress) {
        unsub = progress.on((e) => {
          const line = formatProgressLine(e);
          if (line) process.stderr.write(line + '\n');
        });
      }

      const cache = new ProbeCache(parseInt(opts.cacheCapacity ?? '50000', 10));

      logger.info({ url, format: opts.format }, 'scan starting');

      const result = await runScan(
        {
          target: url,
          overrides: {
            maxPages: parseInt(opts.maxPages ?? '500', 10),
            maxDepth: parseInt(opts.maxDepth ?? '5', 10),
            maxTimeMs: parseInt(opts.maxTime ?? '600000', 10),
            concurrency: parseInt(opts.concurrency ?? '4', 10),
            rateMs: parseInt(opts.rate ?? '0', 10),
            ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
            timeoutMs: parseInt(opts.timeout ?? '15000', 10),
            respectRobots: !opts.noRobots,
            allowPrivate: Boolean(opts.allowPrivate),
          },
        },
        undefined,
        { progress, cache },
      );

      if (unsub) unsub();

      const format = opts.format ?? 'text';
      const body =
        format === 'json'
          ? renderJson(result)
          : format === 'sarif'
            ? renderSarif(result)
            : format === 'html'
              ? renderHtml(result)
              : format === 'csv'
                ? renderCsv(result)
                : format === 'export'
                  ? renderJsonExport(result, { toolVersion: version })
                  : renderText(result);

      if (opts.output) {
        const outPath = resolve(opts.output);
        writeFileSync(outPath, body, 'utf8');
        logger.info({ path: outPath }, 'report written');
      } else {
        process.stdout.write(body);
      }

      if (result.errors.length > 0 && result.pagesScanned === 0) {
        process.exit(2);
      } else if (result.findings.some((f) => f.severity === 'error')) {
        process.exit(1);
      } else {
        process.exit(0);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  logger.fatal({ err: (e as Error).message, stack: (e as Error).stack }, 'fatal');
  process.exit(2);
});