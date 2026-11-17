import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (res, status, value) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 32_768) fail(413, 'Request too large');
  }
  try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON'); }
}
const validSeq = (seq) => Number.isSafeInteger(seq) && seq > 0;
export function shouldWake(event, subscriber) {
  if (event.origin === 'human') return true;
  return event.origin === 'agent' && event.depth < 2 && event.sender !== subscriber.id && event.targets.includes(subscriber.owner);
}
export function normalizeEvent(payload, { team, channel, botId }) {
  const event = payload.event;
  if (payload.team_id !== team || event?.channel !== channel || event.type !== 'message') return null;
  // Edits, deletions, joins, and unfurls are not new conversational turns.
  if (event.subtype && !['bot_message', 'thread_broadcast', 'file_share'].includes(event.subtype)) return null;
  if (!event.ts || !payload.event_id) return null;
  const own = event.bot_id === botId && event.metadata?.event_type === 'agent_watercooler';
  const metadata = own ? event.metadata.event_payload : {};
  const origin = own ? 'agent' : (event.bot_id || event.bot_profile || event.subtype === 'bot_message') ? 'bot' : 'human';
  return {
    channel, ts: event.ts, thread: event.thread_ts || event.ts, user: event.user || event.bot_id || 'unknown',
    text: (event.text || '').slice(0, 16_000), origin,
    depth: own ? Math.max(1, Number(metadata?.depth) || 1) : 0,
    sender: own ? metadata?.sender : null,
    targets: own && Array.isArray(metadata?.targets) ? metadata.targets.filter(x => typeof x === 'string') : [],
  };
}

export function createRelay({ store, slack, team, channel, botId, pollMs = 25_000, log = console }) {
  const changed = new EventEmitter();
  changed.setMaxListeners(0);
  const posting = new Set();
  const pulse = () => changed.emit('change');
  async function eligible(sub) {
    const current = store.member(sub.id);
    if (!current || current.revoked) fail(401, 'Subscription revoked');
    if (!await slack.isMember(current.owner)) {
      store.revokeOwner(current.owner); pulse(); fail(401, 'Owner is no longer in the channel');
    }
    return current;
  }
  function ingest(payload) {
    if (payload.team_id !== team || payload.event?.channel !== channel) return;
    const event = payload.event;
    if (event.type === 'member_left_channel') { slack.invalidateMembers?.(); store.revokeOwner(event.user); pulse(); return; }
    if (event.type === 'member_joined_channel') { slack.invalidateMembers?.(); return; }
    const normalized = normalizeEvent(payload, { team, channel, botId });
    if (normalized && store.append(payload.event_id, normalized)) pulse();
  }
  async function command(command) {
    if (command.team_id !== team || command.channel_id !== channel) return 'Run this command inside #agent-watercooler.';
    if (!await slack.isMember(command.user_id, true)) return 'Join #agent-watercooler first.';
    const action = command.text.trim();
    if (action === 'subscribe') {
      const code = store.issuePair(command.user_id);
      return `Pair one worker using this private, single-use code (expires in 5 minutes):\n\`${code}\`\nRun \`watercooler join --relay <relay-url> --runtime codex\` (or \`claude\`) and paste the code at the prompt. Repeat subscribe for each additional agent. Do not post this code.`;
    }
    if (action === 'unsubscribe') { store.revokeOwner(command.user_id); pulse(); return 'All your workers are unsubscribed. Subscribe again to enroll a new worker.'; }
    if (action === 'pause' || action === 'resume') { store.pauseOwner(command.user_id, action === 'pause'); pulse(); return action === 'pause' ? 'Your workers are paused.' : 'Your workers are resumed from now.'; }
    return 'Use /watercooler subscribe, pause, resume, or unsubscribe. Each pairing enrolls one agent. Channel membership alone does not install a worker.';
  }
  async function poll(req, res, subscriber) {
    let current = await eligible(subscriber);
    let next = store.next(current.id);
    if (!next) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); changed.off('change', done); res.off('close', done); resolve(); };
        const timer = setTimeout(done, pollMs);
        changed.once('change', done); res.once('close', done);
        if (store.next(current.id)) done();
      });
      if (res.destroyed) return;
      current = await eligible(subscriber);
      next = store.next(current.id);
    }
    json(res, 200, { paused: !!current.paused, event: next ? {
      ...next, wake: shouldWake(next, current), context: store.context(next.thread, store.tail()),
      peers: store.members().map(({ owner, name }) => ({ owner, name })),
    } : null });
  }
  async function reply(sub, data) {
    sub = await eligible(sub);
    if (!validSeq(data.seq)) fail(400, 'Invalid event sequence');
    if (sub.paused) fail(409, 'Worker paused');
    const existing = store.outgoing(sub.id, data.seq);
    if (existing?.status === 'sent') return { ts: existing.ts, duplicate: true };
    const event = store.next(sub.id);
    if (!event || event.seq !== data.seq || !shouldWake(event, sub)) fail(409, 'Reply must address the current actionable event');
    const key = `${sub.id}:${event.seq}`;
    if (posting.has(key)) fail(409, 'Reply is in progress');
    posting.add(key);
    try {
      if (existing) {
        const found = await slack.findReply(event.thread, existing.marker);
        if (found) { store.sent(sub.id, event.seq, found); return { ts: found, reconciled: true }; }
        // A timeout is not proof Slack did not post. Never blindly resend.
        fail(409, 'Reply outcome uncertain; inspect Slack and resolve explicitly with watercooler recover');
      }
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 3_000) fail(400, 'Reply must contain 1–3000 characters');
      if (/<!|@(channel|here|everyone)\b/i.test(data.text)) fail(400, 'Broadcast mentions are not allowed');
      const targets = [...new Set((data.text.match(/<@[A-Z0-9]+>/g) || []).map(x => x.slice(2, -1)))];
      if (targets.length > 1) fail(400, 'Tag at most one teammate per reply');
      // Identity labels are profile links, not mentions that ping the owner on every reply.
      const text = `*${sub.name} for <slack://user?team=${team}&id=${sub.owner}|${sub.owner}>*\n${data.text}`;
      const metadata = { event_type: 'agent_watercooler', event_payload: { sender: sub.id, depth: event.depth + 1, targets } };
      const outgoing = store.prepareOutgoing(sub.id, event.seq, { text, metadata, thread: event.thread });
      metadata.event_payload.marker = outgoing.marker;
      const ts = await slack.postReply({ thread: event.thread, text, metadata, clientMsgId: outgoing.marker });
      store.sent(sub.id, event.seq, ts);
      return { ts };
    } finally { posting.delete(key); }
  }
  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (route === '/pair' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.code !== 'string' || data.code.length > 100 || typeof data.name !== 'string' || !/^[a-zA-Z0-9 _.-]{1,60}$/.test(data.name)) fail(400, 'Invalid pairing code or agent name');
        const owner = store.pairOwner(data.code);
        if (!owner) fail(401, 'Invalid or expired pairing code');
        if (!await slack.isMember(owner, true)) fail(403, 'Owner is not in the channel');
        const enrollment = store.enroll(data.code, data.name);
        if (!enrollment) fail(401, 'Pairing code already used');
        return json(res, 201, { ...enrollment, team, channel });
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || token.length > 100) fail(401, 'Worker token required');
      const found = store.auth(token);
      if (!found) fail(401, 'Invalid worker token');
      const sub = await eligible(found);
      if (route === '/events' && req.method === 'GET') return await poll(req, res, sub);
      if (route === '/status' && req.method === 'GET') return json(res, 200, { id: sub.id, owner: sub.owner, name: sub.name, paused: !!sub.paused, cursor: sub.cursor });
      if (route === '/subscription' && req.method === 'DELETE') { store.revoke(sub.id); pulse(); return json(res, 200, { revoked: true }); }
      if (route === '/ack' && req.method === 'POST') {
        const data = await body(req);
        if (!validSeq(data.seq) || !store.ack(sub.id, data.seq)) fail(409, 'Cannot acknowledge out of order or while paused');
        return json(res, 200, { acknowledged: data.seq });
      }
      if (route === '/reply' && req.method === 'POST') return json(res, 200, await reply(sub, await body(req)));
      fail(404, 'Not found');
    } catch (error) {
      // SDK errors can contain request data; never log objects, tokens, or message bodies.
      if (!error.status) log.error('Relay request failed; check Slack connectivity and app permissions.');
      json(res, error.status || 503, { error: error.status ? error.message : 'Slack unavailable; retry later' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, ingest, command, close: async () => { pulse(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
