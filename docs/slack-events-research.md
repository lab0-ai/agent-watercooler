# Slack event delivery for Agent Watercooler

Verified against Slack's primary documentation on 2026-11-18. These are design
findings, not a deployed listener or a guarantee about the current app's scopes.

## What Slack provides

**Socket Mode receives events; it is not a per-agent broadcast bus.** One app may
open up to ten connections, but Slack can deliver a payload to any connection.
Connections refresh periodically. Acknowledgement uses the received
`envelope_id`; reconnect handling belongs in the listener. Therefore, distributing
one app token to every teammate would not make every machine receive every
message. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

For this public channel, subscribe to `message.channels` with `channels:history`,
and add the bot to the channel. The event itself has type `message`; filter its
workspace and channel IDs. `app_mention` alone would omit unmentioned messages.
[Message subscription](https://docs.slack.dev/reference/events/message.channels/),
[Events API permission model](https://docs.slack.dev/apis/events-api/)

The event wrapper's `event_id` is globally unique. Slack sends one event when
several installations/users can see the same activity; its `authorizations`
array is not the list of channel members to notify. Delivery is best effort.
The documented HTTP retry schedule is immediate, one minute, then five minutes;
the optional Delayed Events setting extends retries. Do not assume that schedule
or indefinite offline replay as a Socket Mode guarantee.
[Events API](https://docs.slack.dev/apis/events-api/)

`conversations.members` provides a cursor-paginated membership list.
`member_joined_channel` and `member_left_channel` provide membership changes;
public-channel access uses `channels:read`. These identify Slack users, not their
computers or agent sessions.
[Membership API](https://docs.slack.dev/reference/methods/conversations.members/),
[Join event](https://docs.slack.dev/reference/events/member_joined_channel/),
[Leave event](https://docs.slack.dev/reference/events/member_left_channel/)

## Proposed delivery path

This is application architecture inferred from those APIs:

```text
Slack message -> central listener -> durable event/outbox -> enrolled devices
                                                           -> agent inbox
                                                           -> session adapter
                                                           -> threaded reply
```

- Each human enrolls a device/agent once. Bind it to a verified Slack identity
  and the expected workspace; channel membership alone is not device enrollment.
- A Slack slash command can authenticate a pairing step using the invocation's
  `team_id`, `user_id`, and `channel_id`. Return a short-lived, single-use pairing
  code privately, then exchange it for a revocable device credential. The code
  and exchange protocol are ours to implement, not a built-in Slack feature.
  [Slash-command payload](https://docs.slack.dev/interactivity/implementing-slash-commands/)
- Compute recipients as **currently eligible channel members intersected with
  active, opted-in enrollments**. Reconcile paginated membership at startup and
  periodically; process leave events immediately. Recheck eligibility before
  delivering queued work, so leaving the channel also stops delayed deliveries.
- Unsubscribe revokes the enrollment and removes pending delivery jobs. Stop new
  automatic turns, while treating an already-running turn separately from
  delivery cancellation; runtime interruption support must be explicit.
- Persist events and recipient jobs before considering ingestion complete, then
  acknowledge promptly. Deduplicate globally by `event_id`, and per recipient by
  `(event_id, enrollment_id)`. A second acknowledgement for a duplicate is fine;
  a second agent turn is not. Apply bounded queue retention and per-agent
  concurrency limits; expired messages become a catch-up summary, not a burst
  of newly spawned sessions.
- Keep notification delivery separate from deciding to run a model. Every
  accepted new message can reach each enrolled agent's inbox without forcing
  each agent to respond. Launch/resume behavior is a local runtime adapter's job.

## Agent replies and loop prevention

Modern bot messages can be identified by `bot_id` and `bot_profile`; testing only
`subtype == bot_message` is insufficient. Agent messages sent through a human
account need our own recorded send IDs/origin information.
[Bot message fields](https://docs.slack.dev/reference/events/message/bot_message/)

Bolt's `ignoreSelf` middleware filters the handling app's own messages, not every
other agent's messages. If one shared bot posts every agent's response, blindly
ignoring that bot also hides all agent-to-agent output from the inbox. The app
must deliberately separate **deliver for awareness** from **wake to respond**.
[Slack's middleware source](https://github.com/slackapi/bolt-js/blob/main/src/middleware/builtin.ts)

Proposed policy: fan out agent replies for awareness, but do not automatically
reinvoke responders for their own generated messages or turn an agent reply into
another all-subscriber wakeup. Track source event, producing enrollment, root
thread, and generated message timestamp in the relay. Explicitly addressed
agent-to-agent requests can be a separate, bounded policy. Edits, deletions, join
notices, and duplicate delivery update state rather than spawning fresh turns.

Post replies using the original root message's `ts` as `thread_ts`. A successful
send returns a channel and message timestamp; record that result for correlation.
The shared bot identity can show a text prefix such as "Codex for Maya" without
impersonating the human. [Posting and threads](https://docs.slack.dev/reference/methods/chat.postMessage/)

## Minimum scopes for the proposed public-channel app

| Need | Scope / subscription |
|---|---|
| Socket connection | App-level token with `connections:write` |
| New channel messages | Bot `channels:history`; `message.channels` |
| Membership and channel lookup | Bot `channels:read`; `member_joined_channel`, `member_left_channel` |
| Central threaded replies | Bot `chat:write` |
| Slack slash-command enrollment, if used | Bot `commands` |

These scope sets follow the specific APIs above;
[`connections:write`](https://docs.slack.dev/reference/scopes/connections.write/)
and [`commands`](https://docs.slack.dev/reference/scopes/commands/) document the
remaining entries. Manually adding the bot avoids requesting channel-join
privileges. There is no need for DM-history scopes or `chat:write.public` for a
bot that is already a member of the one target channel.

Persisted delivery is the relay's responsibility. For gap reconciliation,
`conversations.history` can fetch bounded channel history, and
`conversations.replies` can retrieve individual threads with pagination. Respect
the token's actual access and rate-limit responses; history recovery does not
reconstruct every lost edit/delete event.
[Channel history](https://docs.slack.dev/reference/methods/conversations.history/),
[Thread history](https://docs.slack.dev/reference/methods/conversations.replies/)
