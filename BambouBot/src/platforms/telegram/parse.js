'use strict';

/** Telegram command parsing: /command@bot args, quoted values, key=value / key:value options. */

const { ValidationError } = require('../../core/errors');

function tokenize(text) {
  const tokens = [];
  let token = '';
  let quote = null;
  let started = false;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && (input[i + 1] === quote || input[i + 1] === '\\')) token += input[++i];
      else token += char;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else if ((char === '"' || char === "'") && (!started || /[=:]$/.test(token))) {
      quote = char;
      started = true;
    } else if (char === '\\' && i + 1 < input.length) {
      token += input[++i];
      started = true;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new ValidationError('Unclosed quote. Put values containing spaces in matching quotes.');
  if (started) tokens.push(token);
  return tokens;
}

function parseCommand(text, username = '') {
  const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(String(text || ''));
  if (!match) return null;
  if (match[2] && username && match[2].toLowerCase() !== username.toLowerCase()) return null;
  return { name: match[1].toLowerCase(), args: tokenize(match[3]) };
}

/** Accept positional arguments, key=value, and Discord-style key:value. */
function readOptions(tokens, { positionals = [], allowed = [], aliases = {} } = {}) {
  const valid = new Set([...positionals, ...allowed]);
  const options = Object.create(null);
  for (const token of tokens) {
    const named = /^([a-z][a-z0-9_-]*)(=|:)([\s\S]*)$/i.exec(token);
    // A URL is a positional value, not an option named "https".
    if (named && !(named[2] === ':' && named[3].startsWith('//'))) {
      const rawKey = named[1].toLowerCase().replace(/-/g, '_');
      const key = Object.prototype.hasOwnProperty.call(aliases, rawKey) ? aliases[rawKey] : rawKey;
      if (!valid.has(key)) throw new ValidationError(`Unknown option: ${rawKey}. Use /help for examples.`);
      if (Object.prototype.hasOwnProperty.call(options, key)) throw new ValidationError(`Option ${key} was supplied twice.`);
      options[key] = named[3];
    } else {
      const key = positionals.find((name) => !Object.prototype.hasOwnProperty.call(options, name));
      if (!key) throw new ValidationError('Too many arguments. Quote values that contain spaces; use /help for examples.');
      options[key] = token;
    }
  }
  return options;
}

module.exports = { tokenize, parseCommand, readOptions };
