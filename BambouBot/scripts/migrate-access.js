#!/usr/bin/env node
'use strict';

/**
 * Convert the legacy per-bot access files into BambouBot's single access file.
 *
 *   npm run migrate:access -- --discord <access.json> --telegram <telegram-access.json> [--out <file>] [--write] [--force]
 *
 * Dry run by default: prints the merged document (permissions only, no secrets
 * live in these files). --write saves it; an existing output file is only
 * replaced with --force, after a timestamped backup. Sources are never modified.
 */

const fs = require('node:fs');
const path = require('node:path');
const { migrateLegacy } = require('../src/core/access');
const { loadConfig, readEnvironment, ROOT } = require('../src/config');

function parseArgs(argv) {
  const args = { write: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--force') args.force = true;
    else if (['--discord', '--telegram', '--out'].includes(arg)) args[arg.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

function readLegacy(file, label) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { throw new Error(`${label}: cannot read ${file}: ${error.message}`); }
  try { return JSON.parse(raw); } catch { throw new Error(`${label}: ${file} is not valid JSON`); }
}

function defaultOut() {
  try { return loadConfig().accessFile; } catch { /* config may be incomplete during migration */ }
  const { values } = readEnvironment();
  return path.resolve(ROOT, values.ACCESS_FILE || 'data/access.json');
}

function run(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv);
  if (!args.discord && !args.telegram) throw new Error('Pass --discord <file> and/or --telegram <file>.');
  const doc = migrateLegacy({ discord: readLegacy(args.discord, 'discord'), telegram: readLegacy(args.telegram, 'telegram') });
  const out = path.resolve(args.out || defaultOut());
  const counts = Object.keys(doc.users).reduce((acc, key) => { const p = key.split(':')[0]; acc[p] = (acc[p] || 0) + 1; return acc; }, {});
  log(`owners: discord=${doc.owners.discord || '—'} telegram=${doc.owners.telegram || '—'}`);
  log(`approved users: discord=${counts.discord || 0} telegram=${counts.telegram || 0}`);
  if (!args.write) {
    log(`\nDry run — would write ${out}:\n${JSON.stringify(doc, null, 2)}\nRe-run with --write to save it.`);
    return { doc, out, written: false };
  }
  if (fs.existsSync(out)) {
    if (!args.force) throw new Error(`${out} already exists. Re-run with --force to replace it (a backup is kept).`);
    const backup = `${out}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(out, backup);
    log(`backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  log(`written: ${out}`);
  return { doc, out, written: true };
}

if (require.main === module) {
  try { run(); } catch (error) {
    console.error(`migrate-access: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs };
