import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe state directory');
  await fs.chmod(dir, 0o700);
}
export async function atomicWrite(file, text) {
  await privateDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await handle.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
}
export const writeJSON = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
export async function readOptional(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Unsafe local file');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readJSON(file, fallback = null) {
  const text = await readOptional(file);
  return text === null ? fallback : JSON.parse(text);
}
