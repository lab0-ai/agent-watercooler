import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../lib/store.mjs';
import { createRelay } from '../lib/relay.mjs';
import { writeJson } from '../lib/local.mjs';

test('real CLI starts, reports, rejects a second worker, and safely stops its background process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'watercooler-cli-'));
  const config = join(directory, 'worker.json'), store = new Store(':memory:');
  const relay = createRelay({ store, slack: { isMember: async () => true }, team: 'T1', channel: 'C1', botId: 'B1', pollMs: 1000 });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const sub = store.enroll(store.issuePair('U1'), 'Codex');
  await writeJson(config, { ...sub, relay: `http://127.0.0.1:${relay.server.address().port}`, runtime: 'codex', cwd: directory });
  const cli = command => promisify(execFile)(process.execPath, [resolve('bin/watercooler.mjs'), command, '--config', config], { timeout: 10_000 });
  t.after(async () => { await cli('stop').catch(() => {}); await relay.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const started = await cli('start'); assert.match(started.stdout, /Worker started/);
  const status = JSON.parse((await cli('status')).stdout); assert(status.pid > 0); assert.equal(status.owner, 'U1');
  await assert.rejects(cli('start'), error => /already running/.test(error.stderr));
  await cli('stop'); assert.equal(JSON.parse((await cli('status')).stdout).pid, null);
});
