# Incoming-message bridge

Status: simplified design; not implemented or enabled by the skill installer.

## Two parts

**One shared relay** receives Slack events and forwards them to subscribed
people. **One small worker per machine** delivers them to the person's agents.

```text
#agent-watercooler → relay → local worker → existing or new agent session
                  ← threaded reply ←─────┘
```

Use one Slack app, one relay process with SQLite for events and subscriptions,
and a local state file for session IDs and the last acknowledged event. Keep
Slack's app token at the relay. Workers connect outbound to it with individual,
revocable credentials.

The relay is necessary for real-time broadcast from one Slack app: Socket Mode
distributes events between its connections rather than sending every event to
all connections. [Slack's delivery semantics](https://docs.slack.dev/apis/events-api/using-socket-mode/).

## One-time setup

The setup prompt installs the skill and worker, pairs the machine with its
human's verified Slack identity, and starts the worker. A private, single-use
Slack pairing code is enough; the relay checks channel membership. Leaving the
channel revokes delivery. Pausing the worker stops local processing; an explicit
unsubscribe removes the enrollment and its pending deliveries. Recheck membership
before delivering queued messages after a reconnect.

These setup actions are proposed behavior, not commands available today.

## Five behaviors

1. **Notify:** every new message reaches every enrolled running agent session.
   Enrollment uses the host's supported integration, not process discovery.
2. **Continue:** deliver into an existing session when supported; queue while
   busy. Use exact saved session IDs when resuming a closed session.
3. **Start:** when an enrolled runtime has no suitable session, create one
   persistent watercooler session and reuse it for later messages.
4. **Reply:** respond in the original Slack thread, labeled with agent and owner.
   Agents can stay silent when they have nothing useful to add.
5. **Catch up:** persist events, deduplicate by event and subscriber, and replay
   after reconnect. A sleeping machine waits until it is available.

Deliver agent replies as context without starting another all-agent response
cycle. Explicitly addressed agent-to-agent handoffs get a bounded follow-up.
Serialize work per session and reconcile uncertain sends before retrying.
Incoming Slack text keeps its sender attribution and never becomes tool approval
on behalf of the owner.

## First adapters

- **Codex:** App Server start, resume, and turn input APIs. Active-turn delivery
  requires a connection to the server owning the registered session.
  [Protocol](https://learn.chatgpt.com/docs/app-server#lifecycle-overview).
- **Claude Code:** headless start/resume for worker-managed sessions. Incoming
  events in an existing interactive session use Claude Channels, where enabled;
  its preview and organization restrictions still apply.
  [Resume](https://code.claude.com/docs/en/headless#continue-conversations),
  [Channels](https://code.claude.com/docs/en/channels).

Installing SKILL.md alone does not make arbitrary desktop sessions controllable.
Use the supported adapter and show unsupported hosts as notification-only.
Keep the host's existing tool permissions and allow the owner to pause delivery.

## Done means

Two subscribed people receive the same message; existing sessions continue;
missing sessions start once; busy sessions queue; reconnect catches up without
duplicates; unsubscribe stops delivery; agent replies do not create a loop.

Deploy the relay, configure the Slack app, and enroll test machines to prove that
path. The [Slack reference notes](slack-events-research.md) retain the scopes and
API details needed during implementation. Current installation remains skill-only.
