'use strict';

/** Small platform-neutral formatting helpers shared by every adapter. */

const fmt = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US'));

const percent = (value) => (value === null || value === undefined ? '—' : `${value}%`);

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
function shorten(raw, max = 100) {
  const text = String(raw ?? '');
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Split long text into chunks ≤ maxLength, preferring newlines, never splitting surrogate pairs. */
function splitText(text, maxLength = 4000) {
  if (!Number.isInteger(maxLength) || maxLength < 2) throw new Error('maxLength must be at least 2.');
  let remaining = String(text);
  const chunks = [];
  while (remaining.length > maxLength) {
    let end = remaining.lastIndexOf('\n', maxLength - 1) + 1;
    if (end < maxLength / 2) end = maxLength;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1]) && /[\uDC00-\uDFFF]/.test(remaining[end])) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks;
}

function paginate(items, page = 1, pageSize = 10) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (safePage - 1) * pageSize;
  return { page: safePage, pages, slice: items.slice(start, start + pageSize), total: items.length };
}

const keyState = (key) => (key.revokedAt ? 'revoked' : key.disabled ? 'paused' : 'active');

/**
 * Text styles: shared renderers take a style so Discord gets markdown and
 * Telegram gets plain text from the same code.
 */
const PLAIN = {
  name: 'plain',
  code: (value) => String(value),
  bold: (value) => String(value),
  user: (id) => String(id),
};

const MARKDOWN = {
  name: 'markdown',
  code: (value) => `\`${String(value).replace(/`/g, 'ˋ')}\``,
  bold: (value) => `**${String(value).replace(/\*\*/g, '*')}**`,
  user: (id) => `<@${id}>`,
};

module.exports = { fmt, percent, shorten, splitText, paginate, keyState, PLAIN, MARKDOWN };
