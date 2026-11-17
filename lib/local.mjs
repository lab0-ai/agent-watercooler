import { mkdir, readFile, writeFile, rename, open, unlink, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
export const defaultConfig = () => resolve(homedir(), '.config/agent-watercooler/worker.json');
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await chmod(temp, 0o600); await rename(temp, path);
}
export async function lock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close();
      return async () => { await unlink(path).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock file; inspect it before removing it');
      try { process.kill(pid, 0); } catch (check) {
        if (check.code === 'ESRCH') { await unlink(path); continue; }
        throw check;
      }
      throw new Error('A worker already owns this configuration');
    }
  }
  throw new Error('Cannot acquire worker lock');
}
export function relayUrl(input) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Relay URL must be an origin without credentials, paths, or query parameters');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for a remote relay');
  return url.origin;
}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function api(config, fetchFn = fetch) {
  return async (path, { method = 'GET', body, signal } = {}) => {
    const response = await fetchFn(config.relay + path, {
      method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000),
      redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, data.error || `HTTP ${response.status}`);
    return data;
  };
}
