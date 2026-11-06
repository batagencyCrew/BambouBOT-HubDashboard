'use strict';

/** Error types and safe error → text conversion shared by every platform. */

class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** A user-input problem: shown to the user as-is, never logged as a failure. */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Remove known secrets plus anything shaped like a bbk_ key or a Telegram bot token. */
function redact(text, secrets = []) {
  let value = String(text ?? '');
  // Very short values cannot be real credentials and would mangle ordinary text.
  for (const secret of secrets) if (secret && String(secret).length >= 6) value = value.split(String(secret)).join('[redacted]');
  return value
    .replace(/\bbbk_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, '[redacted]');
}

/** Human-readable, redacted description of any error the services can throw. */
function errorText(error, secrets = []) {
  if (error?.name === 'SessionExpiredError') {
    return 'GetMySocial session expired — refresh GMS_COOKIE in .env (see docs/GETTING_COOKIE.md).';
  }
  let text = error?.message || 'Unknown error';
  if (error?.code === 'upgrade_required') text = `GetMySocial plan limit reached: ${text}`;
  const status = error?.errorCode || error?.status;
  if (status) text += ` (HTTP ${status}${error.retryAfter > 0 ? `; retry in ${error.retryAfter}s` : ''})`;
  return redact(text, secrets);
}

module.exports = { PermissionError, ValidationError, redact, errorText };
