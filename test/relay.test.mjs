import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createRelay } from '../lib/relay.mjs';
import { api } from '../lib/local.mjs';

async function setup(t, path = ':memory:') {
  const members = new Set(['U1', 'U2']), posts = [];
  const store = new Store(path);
  const slack = {
    isMember: async owner => members.has(owner),
    postReply: async data => { const ts = `200.${posts.length}`; posts.push({ ...data, ts }); return ts; },
    findReply: async (thread, marker) => posts.find(p => p.thread === thread && p.clientMsgId === marker)?.ts,
  };
  const relay = createRelay({ store, slack, team: 'T1', channel: 'C1', botId: 'B1', pollMs: 20, log: { error() {} } });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  t.after(async () => { await relay.close(); store.close(); });
  const enroll = owner => {
    const sub = store.enroll(store.issuePair(owner), `Agent ${owner}`);
    return { ...sub, request: api({ ...sub, relay: url }) };
  };
  const human = (id = 'E1', extra = {}) => relay.ingest({ team_id: 'T1', event_id: id, event: { type: 'message', channel: 'C1', user: 'U1', ts: `100.${id}`, text: 'Can anyone help?', ...extra } });
  return { store, slack, relay, members, posts, enroll, human, url };
}

test('one Slack event reaches two owners; retries do not duplicate delivery', async t => {
  const f = await setup(t); const a = f.enroll('U1'), b = f.enroll('U2');
  f.human(); f.human();
  const [one, two] = await Promise.all([a.request('/events'), b.request('/events')]);
  assert.equal(one.event.seq, two.event.seq); assert.equal(one.event.wake, true);
  await a.request('/ack', { method: 'POST', body: { seq: one.event.seq } });
  assert.equal((await a.request('/events')).event, null);
  assert.equal((await b.request('/events')).event.seq, two.event.seq);
});

test('long poll wakes promptly when an event arrives', async t => {
  const f = await setup(t), a = f.enroll('U1');
  const pending = a.request('/events');
  setTimeout(() => f.human(), 5);
  assert.equal((await pending).event.text, 'Can anyone help?');
});

test('pairing is identity-bound, expires, and cannot be reused', async t => {
  const f = await setup(t);
  const code = f.store.issuePair('U1');
  const pair = data => fetch(f.url + '/pair', { method: 'POST', body: JSON.stringify(data) });
  const first = await pair({ code, name: 'Codex', owner: 'U2' });
  assert.equal(first.status, 201); assert.equal((await first.json()).owner, 'U1');
  assert.equal((await pair({ code, name: 'Codex' })).status, 401);
  assert.equal((await pair({ code: f.store.issuePair('U1', Date.now() - 400_000), name: 'Codex' })).status, 401);
  f.members.delete('U2');
  assert.equal((await pair({ code: f.store.issuePair('U2'), name: 'Codex' })).status, 403);
});

test('leaving revokes queued events and outstanding pairing codes', async t => {
  const f = await setup(t), a = f.enroll('U1'), code = f.store.issuePair('U1');
  f.human();
  f.relay.ingest({ team_id: 'T1', event: { type: 'member_left_channel', channel: 'C1', user: 'U1' } });
  await assert.rejects(a.request('/events'), error => error.status === 401);
  assert.equal(f.store.pairOwner(code), undefined);
});

test('missed leave event is detected on reconnect', async t => {
  const f = await setup(t), a = f.enroll('U1'); f.human(); f.members.delete('U1');
  await assert.rejects(a.request('/events'), error => error.status === 401);
  assert.equal(f.store.member(a.id).revoked, 1);
});

test('wrong workspace/channel and edits never create conversational turns', async t => {
  const f = await setup(t), a = f.enroll('U1');
  f.human('edit', { subtype: 'message_changed' }); f.human('wrong-channel', { channel: 'C2' });
  f.relay.ingest({ team_id: 'T2', event_id: 'wrong-team', event: { type: 'message', channel: 'C1', ts: '10', text: 'no' } });
  assert.equal((await a.request('/events')).event, null);
});

test('replies are threaded, deduplicated, and agent followups are bounded', async t => {
  const f = await setup(t), a = f.enroll('U1'), b = f.enroll('U2'); f.human();
  const first = (await a.request('/events')).event;
  const result = await a.request('/reply', { method: 'POST', body: { seq: first.seq, text: '<@U2>, can you help?' } });
  assert.equal(f.posts[0].thread, first.thread);
  assert.match(f.posts[0].text, /Agent U1 for <slack:\/\/user\?team=T1&id=U1\|U1>/);
  assert.equal((await a.request('/reply', { method: 'POST', body: { seq: first.seq, text: 'duplicate' } })).ts, result.ts);
  assert.equal(f.posts.length, 1);
  await a.request('/ack', { method: 'POST', body: { seq: first.seq } });
  await b.request('/ack', { method: 'POST', body: { seq: first.seq } });
  f.human('reply1', { bot_id: 'B1', thread_ts: first.thread, metadata: f.posts[0].metadata });
  assert.equal((await a.request('/events')).event.wake, false);
  const followup = (await b.request('/events')).event;
  assert.equal(followup.wake, true);
  await b.request('/reply', { method: 'POST', body: { seq: followup.seq, text: '<@U1>, here is the answer.' } });
  await a.request('/ack', { method: 'POST', body: { seq: followup.seq } });
  await b.request('/ack', { method: 'POST', body: { seq: followup.seq } });
  f.human('reply2', { bot_id: 'B1', thread_ts: first.thread, metadata: f.posts[1].metadata });
  assert.equal((await a.request('/events')).event.wake, false);
  assert.equal((await b.request('/events')).event.wake, false);
});

test('unknown bots provide context without waking agents; broadcast mentions rejected', async t => {
  const f = await setup(t), a = f.enroll('U1'); f.human('bot', { bot_profile: { id: 'B2' } });
  const bot = (await a.request('/events')).event; assert.equal(bot.wake, false);
  await assert.rejects(a.request('/reply', { method: 'POST', body: { seq: bot.seq, text: 'hello' } }), error => error.status === 409);
  await a.request('/ack', { method: 'POST', body: { seq: bot.seq } }); f.human();
  const human = (await a.request('/events')).event;
  await assert.rejects(a.request('/reply', { method: 'POST', body: { seq: human.seq, text: '<!channel> ping' } }), error => error.status === 400);
  assert.equal(f.posts.length, 0);
});

test('ambiguous Slack send reconciles without sending twice', async t => {
  const f = await setup(t), a = f.enroll('U1'); f.human();
  const event = (await a.request('/events')).event;
  const original = f.slack.postReply;
  f.slack.postReply = async data => { await original(data); throw new Error('Connection lost after Slack accepted'); };
  const send = () => a.request('/reply', { method: 'POST', body: { seq: event.seq, text: 'A useful answer.' } });
  await assert.rejects(send(), error => error.status === 503);
  assert.equal((await send()).reconciled, true); assert.equal(f.posts.length, 1);
});

test('ambiguous send with no receipt remains blocked instead of blindly retrying', async t => {
  const f = await setup(t), a = f.enroll('U1'); f.human();
  const event = (await a.request('/events')).event; let attempts = 0;
  f.slack.postReply = async () => { attempts++; throw new Error('Network lost'); };
  const send = () => a.request('/reply', { method: 'POST', body: { seq: event.seq, text: 'A useful answer.' } });
  await assert.rejects(send(), error => error.status === 503);
  await assert.rejects(send(), error => error.status === 409);
  assert.equal(attempts, 1);
});

test('pause stops delivery, resume skips paused backlog, unsubscribe revokes all owner devices', async t => {
  const f = await setup(t), a = f.enroll('U1'), b = f.enroll('U1');
  const command = text => f.relay.command({ team_id: 'T1', channel_id: 'C1', user_id: 'U1', text });
  await command('pause'); f.human(); assert.equal((await a.request('/events')).paused, true);
  await command('resume'); assert.equal((await a.request('/events')).event, null);
  await command('unsubscribe');
  await assert.rejects(a.request('/status'), error => error.status === 401);
  await assert.rejects(b.request('/status'), error => error.status === 401);
});

test('durable inbox survives relay restart and retains independent cursors', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'watercooler-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'relay.sqlite');
  let store = new Store(path); const a = store.enroll(store.issuePair('U1'), 'Codex');
  store.append('E1', { text: 'one', thread: '1' }); store.append('E2', { text: 'two', thread: '2' });
  store.ack(a.id, 1); store.close();
  store = new Store(path);
  assert.equal(store.auth(a.token).owner, 'U1'); assert.equal(store.next(a.id).text, 'two');
  assert.equal(store.append('E2', { text: 'duplicate' }), null); store.close();
});
