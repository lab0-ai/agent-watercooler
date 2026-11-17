import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';

export function bindSocket(socket, relay, web, log = console) {
  socket.on('slack_event', async ({ type, body, ack }) => {
    if (type !== 'events_api') return;
    try { relay.ingest(body); await ack(); }
    catch { log.error('Slack event was not acknowledged; durable ingestion failed.'); }
  });
  socket.on('slash_commands', async ({ body, ack }) => {
    // Ack immediately; member lookup can exceed Slack's 3-second limit.
    try {
      await ack();
      const text = await relay.command(body);
      await web.chat.postEphemeral({ channel: body.channel_id, user: body.user_id, text });
    } catch { log.error('Could not complete /watercooler; check channel membership and app permissions.'); }
  });
  socket.on('error', () => log.error('Slack socket disconnected; the SDK will attempt to reconnect.'));
}

export async function connectSlack({ botToken, appToken, team, channel, log = console }) {
  // Disable SDK send retries: an ambiguous post is reconciled from history.
  const web = new WebClient(botToken, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, logLevel: 'error' });
  const auth = await web.auth.test();
  if (auth.team_id !== team || !auth.bot_id) throw new Error('Slack token does not belong to the configured workspace bot');
  const info = await web.conversations.info({ channel });
  if (!info.channel?.is_member || info.channel?.is_archived) throw new Error('Invite the bot to the active target channel first');
  let memberCache = null, checkedAt = 0, pending = null;
  const gateway = {
    botId: auth.bot_id,
    invalidateMembers() { memberCache = null; },
    async isMember(owner, fresh = false) {
      if (fresh || !memberCache || Date.now() - checkedAt > 30_000) {
        if (!pending) pending = (async () => {
          const members = new Set(); let cursor;
          do {
            const page = await web.conversations.members({ channel, cursor, limit: 200 });
            page.members?.forEach(id => members.add(id)); cursor = page.response_metadata?.next_cursor;
          } while (cursor);
          memberCache = members; checkedAt = Date.now();
        })().finally(() => { pending = null; });
        await pending;
      }
      return memberCache.has(owner);
    },
    async postReply({ thread, text, metadata, clientMsgId }) {
      const result = await web.chat.postMessage({ channel, thread_ts: thread, text, metadata, client_msg_id: clientMsgId, unfurl_links: false, unfurl_media: false });
      if (!result.ok || !result.ts) throw new Error('Slack returned no post receipt');
      return result.ts;
    },
    async findReply(thread, marker) {
      let cursor;
      do {
        const page = await web.conversations.replies({ channel, ts: thread, cursor, limit: 100, include_all_metadata: true });
        const found = page.messages?.find(message => message.bot_id === auth.bot_id &&
          (message.client_msg_id === marker || message.metadata?.event_payload?.marker === marker));
        if (found) return found.ts;
        cursor = page.response_metadata?.next_cursor;
      } while (cursor);
      return null;
    },
  };
  const socket = new SocketModeClient({ appToken, logLevel: 'error' });
  return {
    gateway,
    async start(relay) {
      bindSocket(socket, relay, web, log);
      await socket.start();
    },
    async close() { await socket.disconnect(); },
  };
}
