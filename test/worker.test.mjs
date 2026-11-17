import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../lib/worker.mjs';
import { writeJson, readJson, ApiError, relayUrl } from '../lib/local.mjs';
import { BusyError } from '../lib/agents.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'watercooler-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [], replies = [], calls = [];
  let cursor = 0, failReply = false, failAck = false;
  const config = { id: 'sub1', owner: 'U1', name: 'Codex' }, statePath = join(directory, 'state.json');
  const request = async (path, options = {}) => {
    if (path === '/status') return { cursor };
    if (path === '/events') return { event: events.find(event => event.seq > cursor) || null };
    if (path === '/reply') {
      if (failReply) { failReply = false; throw new ApiError(503, 'transient'); }
      replies.push(options.body); return { ts: '200.1' };
    }
    if (path === '/ack') {
      cursor = options.body.seq;
      if (failAck) { failAck = false; throw new ApiError(503, 'ack response lost'); }
      return { acknowledged: cursor };
    }
    throw new Error(`Unexpected path ${path}`);
  };
  const agent = { async run({ sessionId, onSession }) {
    calls.push(sessionId); await onSession(sessionId || 'session-1'); return { action: 'reply', text: 'Useful reply' };
  } };
  const create = () => new Worker({ config, statePath, request, agent });
  const add = (wake = true) => events.push({ seq: events.length + 1, wake, text: 'help', thread: '100.1', user: 'U2', context: [], peers: [] });
  return { create, agent, statePath, add, calls, replies, config, request, failReply: () => { failReply = true; }, failAck: () => { failAck = true; } };
}

test('worker starts once, reuses its exact session, and resumes after restart', async t => {
  const f = await setup(t); f.add(); f.add(); const worker = f.create();
  await worker.step(); await worker.step(); f.add(); await f.create().step();
  assert.deepEqual(f.calls, [null, 'session-1', 'session-1']); assert.equal(f.replies.length, 3);
});

test('busy runtime queues events; later events cannot overtake it', async t => {
  const f = await setup(t); f.add(); f.add(); const original = f.agent.run;
  f.agent.run = async () => { throw new BusyError('busy'); };
  const worker = f.create(); assert.equal(await worker.step(), false);
  assert.equal((await readJson(f.statePath)).pending, undefined);
  f.agent.run = original; await worker.step(); await worker.step();
  assert.deepEqual(f.replies.map(reply => reply.seq), [1, 2]);
});

test('saved response survives network failure and worker restart without rerunning the model', async t => {
  const f = await setup(t); f.add(); f.failReply();
  await assert.rejects(f.create().step(), error => error.status === 503);
  await f.create().step();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
});

test('lost acknowledgement response does not repeat a model run or post', async t => {
  const f = await setup(t); f.add(); f.failAck();
  await assert.rejects(f.create().step(), error => error.status === 503);
  f.add(); await f.create().step();
  assert.deepEqual(f.replies.map(reply => reply.seq), [1, 2]); assert.equal(f.calls.length, 2);
});

test('uncertain model execution stays blocked for explicit recovery', async t => {
  const f = await setup(t); f.add();
  await writeJson(f.statePath, { subscription: f.config.id, sessionId: 'session-1', pending: { seq: 1, stage: 'running' } });
  await assert.rejects(f.create().step(), /uncertain outcome/);
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('bot context and silent model decisions do not create Slack posts', async t => {
  const f = await setup(t); f.add(false); f.add();
  const worker = f.create(); await worker.step();
  f.agent.run = async ({ onSession }) => { await onSession('session-1'); return { action: 'silent', text: '' }; };
  await worker.step(); assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('remote relay credentials require HTTPS and cannot ride URL redirects', () => {
  assert.equal(relayUrl('https://relay.example/'), 'https://relay.example');
  assert.equal(relayUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const url of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example/path', 'https://relay.example?token=x']) assert.throws(() => relayUrl(url));
});
