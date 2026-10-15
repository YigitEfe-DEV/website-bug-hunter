import pino from 'pino';

/**
 * Application logger. Never logs response bodies at INFO (R3: response
 * contents are untrusted attacker-controlled data). Logs go to STDERR so
 * STDOUT stays clean for the report (json/text/sarif/html).
 */
export const logger = pino({
  level: process.env['WBH_LOG_LEVEL'] ?? 'info',
  redact: {
    paths: ['html', 'body', 'response'],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
}, pino.destination({ dest: 2, sync: false }));