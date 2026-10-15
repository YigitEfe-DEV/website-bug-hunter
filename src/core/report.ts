/**
 * Report validation + sanitization. Every report written to disk or
 * piped to stdout passes through `validateAndSanitize` so we never
 * emit malformed JSON, oversized blobs, or accidentally-leaked
 * sensitive fields.
 */

import type { Confidence, Finding, FindingType, ScanResult, Severity } from '../types/index.js';

/** Maximum findings per report. Above this, oldest findings get truncated. */
const MAX_FINDINGS = 100_000;

/** Maximum length for any string field in the report. */
const MAX_STRING_LEN = 2048;

/** Fields that MUST NOT appear in a serialized report (defense in depth). */
const FORBIDDEN_TOP_LEVEL_KEYS = new Set([
  'auth', 'authorization', 'cookie', 'cookies', 'session', 'token', 'password',
  'secret', 'apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken',
  'private', 'privateKey', 'private_key', 'bearer',
]);

const ALLOWED_FINDING_TYPES = new Set<FindingType>([
  'link_broken', 'image_broken', 'redirect_loop', 'redirect_chain_long',
  'redirect_downgrade', 'meta_missing', 'meta_invalid', 'js_error',
  'mobile_overflow', 'scanner_error', 'request_failed', 'accessibility',
  'duplicate',
]);

const ALLOWED_SEVERITIES = new Set<Severity>(['error', 'warning', 'info']);

const ALLOWED_CONFIDENCES = new Set<Confidence>(['confirmed', 'probable', 'inconclusive']);

export class ReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportValidationError';
  }
}

/**
 * Validate and sanitize a ScanResult in place. Returns the same object
 * (mutated) so callers can chain. Throws ReportValidationError if the
 * report is broken beyond repair.
 */
export function validateAndSanitize(r: ScanResult): ScanResult {
  if (typeof r !== 'object' || r === null) {
    throw new ReportValidationError('ScanResult is not an object');
  }
  if (typeof r.target !== 'string' || r.target.length === 0) {
    throw new ReportValidationError('target must be a non-empty string');
  }
  if (r.target.length > MAX_STRING_LEN) throw new ReportValidationError('target too long');
  if (typeof r.startedAt !== 'number' || r.startedAt < 0) {
    throw new ReportValidationError('startedAt must be a non-negative number');
  }
  if (typeof r.finishedAt !== 'number' || r.finishedAt < r.startedAt) {
    throw new ReportValidationError('finishedAt must be >= startedAt');
  }
  if (typeof r.durationMs !== 'number' || r.durationMs < 0) {
    throw new ReportValidationError('durationMs must be non-negative');
  }
  if (!Number.isInteger(r.pagesScanned) || r.pagesScanned < 0) {
    throw new ReportValidationError('pagesScanned must be a non-negative integer');
  }
  if (!Number.isInteger(r.pagesFailed) || r.pagesFailed < 0) {
    throw new ReportValidationError('pagesFailed must be a non-negative integer');
  }
  if (r.pagesSkipped !== undefined && (!Number.isInteger(r.pagesSkipped) || r.pagesSkipped < 0)) {
    r.pagesSkipped = 0;
  }
  if (Array.isArray(r.findings) === false) throw new ReportValidationError('findings must be an array');
  if (Array.isArray(r.errors) === false) throw new ReportValidationError('errors must be an array');

  // Sanitize target: no control characters, no newlines.
  r.target = sanitizeString(r.target, MAX_STRING_LEN);

  // Sanitize errors list.
  r.errors = r.errors.map((e) => (typeof e === 'string' ? sanitizeString(e, MAX_STRING_LEN) : ''));

  // Sanitize cache stats if present.
  if (r.cache) {
    r.cache = {
      linkProbes: Math.max(0, Math.floor(Number(r.cache.linkProbes) || 0)),
      assetProbes: Math.max(0, Math.floor(Number(r.cache.assetProbes) || 0)),
    };
  }

  // Sanitize findings.
  r.findings = r.findings
    .map((f): Finding | null => sanitizeFinding(f))
    .filter((f): f is Finding => f !== null);

  if (r.findings.length > MAX_FINDINGS) {
    r.findings = r.findings.slice(0, MAX_FINDINGS);
  }

  return r;
}

function sanitizeFinding(f: Finding): Finding | null {
  if (typeof f !== 'object' || f === null) return null;
  if (typeof f.id !== 'string' || f.id.length === 0) return null;
  if (typeof f.type !== 'string' || !ALLOWED_FINDING_TYPES.has(f.type as FindingType)) {
    // Unknown finding type — keep but coerce to a generic.
    f.type = 'scanner_error';
  }
  if (typeof f.severity !== 'string' || !ALLOWED_SEVERITIES.has(f.severity as Severity)) {
    f.severity = 'warning';
  }
  if (typeof f.confidence !== 'string' || !ALLOWED_CONFIDENCES.has(f.confidence as Confidence)) {
    // Missing or invalid confidence — default to probable.
    f.confidence = 'probable';
  }
  if (typeof f.message !== 'string') return null;
  f.message = sanitizeString(f.message, MAX_STRING_LEN);
  if (typeof f.page !== 'string') return null;
  f.page = sanitizeString(f.page, MAX_STRING_LEN);

  // Sanitize affectedPages (capped to 50 entries to keep reports bounded).
  if (f.affectedPages !== undefined) {
    if (!Array.isArray(f.affectedPages)) {
      delete f.affectedPages;
    } else {
      const cleaned: string[] = [];
      const seen = new Set<string>();
      for (const p of f.affectedPages) {
        if (typeof p !== 'string') continue;
        const s = sanitizeString(p, MAX_STRING_LEN);
        if (s.length === 0 || seen.has(s)) continue;
        seen.add(s);
        cleaned.push(s);
        if (cleaned.length >= 50) break;
      }
      if (cleaned.length === 0) delete f.affectedPages;
      else if (cleaned.length === 1 && cleaned[0] === f.page) delete f.affectedPages;
      else f.affectedPages = cleaned;
    }
  }

  // Sanitize optional explanation if present.
  if (f.explanation !== undefined && typeof f.explanation === 'string') {
    f.explanation = sanitizeString(f.explanation, 1024);
  }

  // Strip unknown keys from detail (no blobs, no secrets).
  if (f.detail && typeof f.detail === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.detail)) {
      if (FORBIDDEN_TOP_LEVEL_KEYS.has(k)) continue;
      if (typeof v === 'string') {
        cleaned[k] = sanitizeString(v, 512);
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        cleaned[k] = v;
      } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
        cleaned[k] = (v as Array<string | number>).slice(0, 50);
      }
    }
    f.detail = cleaned;
  }

  // Sanitize optional fix field if present.
  if (f.fix !== undefined && typeof f.fix === 'string') {
    f.fix = sanitizeString(f.fix, 1024);
  }

  return f;
}

function sanitizeString(s: string, max: number): string {
  // Strip ASCII control chars and limit length.
  const cleaned = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return cleaned.length > max ? cleaned.substring(0, max) : cleaned;
}