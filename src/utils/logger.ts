import pino from 'pino';

/**
 * Application logger. Never logs response bodies at INFO (R3: response
 * contents are untrusted attacker-controlled data). Logs go to STDERR so
 * STDOUT stays clean for the report (json/text/sarif/html).
 *
 * Redaction list is intentionally broad: any field whose name looks like
 * a credential, token, cookie, or authorization header is dropped, both at
 * top level and one level deep. This is defense in depth — a scanner that
 * accidentally captures a `set-cookie` value should never see it in stderr.
 *
 * The paths use `*.name` (Pino wildcard for any first-level key) AND the
 * bare key, because Pino's wildcard matches by exact path, not by suffix.
 */
export const logger = pino({
  level: process.env['WBH_LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      // Bodies / payloads: never log attacker-controlled content.
      'html',
      'body',
      'response',
      'requestBody',
      'responseBody',
      // Credentials / secrets / tokens. Case-insensitive matching happens
      // via separate wildcard entries.
      'password',
      'passwd',
      'secret',
      'token',
      'apiKey',
      'api_key',
      'apikey',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'privateKey',
      'private_key',
      'private',
      'bearer',
      'jwt',
      'authorization',
      'cookie',
      'cookies',
      'set-cookie',
      'session',
      '*.password',
      '*.passwd',
      '*.secret',
      '*.token',
      '*.apiKey',
      '*.api_key',
      '*.apikey',
      '*.accessToken',
      '*.access_token',
      '*.refreshToken',
      '*.refresh_token',
      '*.privateKey',
      '*.private_key',
      '*.bearer',
      '*.jwt',
      '*.authorization',
      '*.cookie',
      '*.set-cookie',
      '*.session',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
}, pino.destination({ dest: 2, sync: false }));