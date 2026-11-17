#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, chmod, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultConfig, relayUrl, readJson, writeJson, lock, api } from '../lib/local.mjs';
import { Store } from '../lib/store.mjs';
import { createRelay } from '../lib/relay.mjs';
import { connectSlack } from '../lib/slack.mjs';
import { CodexAgent, ClaudeAgent } from '../lib/agents.mjs';
import { Worker } from '../lib/worker.mjs';

const help = `Agent Watercooler — Node 22.13+

  watercooler relay                        Run the shared Slack relay
  watercooler join --relay URL --runtime codex|claude [--name NAME]
  watercooler run                          Run this worker in the foreground
  watercooler start                        Start this worker in the background
  watercooler stop                         Stop the local background worker
  watercooler status                       Show enrollment and local session status
  watercooler leave                        Revoke this worker and stop it
  watercooler recover --skip               Skip an uncertain event after inspection
  watercooler recover --retry              Retry an uncertain model turn after inspection

Options: --config FILE (one file per enrolled agent), --cwd DIR,
         --session ID (an idle session), --codex-url ws://127.0.0.1:PORT
Pairing codes are entered at a private prompt, never on the command line.

Relay environment: SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_TEAM_ID,
SLACK_CHANNEL_ID, WATERCOOLER_DATA_DIR, HOST (default 127.0.0.1), PORT (8787).
Workers need no Slack credentials. Put a remote relay behind HTTPS.
`;
const { positionals, values: flags } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, relay: { type: 'string' }, runtime: { type: 'string' }, name: { type: 'string' },
  cwd: { type: 'string' }, session: { type: 'string' }, 'codex-url': { type: 'string' },
  skip: { type: 'boolean' }, retry: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
const command = positionals[0];
const configPath = resolve(flags.config || defaultConfig());
const statePath = configPath + '.state.json';
const pidPath = configPath + '.pid';
const lockPath = configPath + '.lock';
async function runningPid() {
  let pid;
  try { pid = Number(await readFile(pidPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid PID file');
  try { process.kill(pid, 0); return pid; } catch (error) { if (error.code === 'ESRCH') return null; throw error; }
}
async function stop() {
  const pid = await runningPid();
  if (pid) {
    // Both files must agree before signaling. An unrelated reused PID must not be killed.
    const owner = Number(await readFile(lockPath, 'utf8').catch(() => '0'));
    if (owner !== pid) throw new Error('Worker PID and lock do not agree; inspect before stopping');
    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
    if (!stdout.includes(fileURLToPath(import.meta.url)) || !stdout.includes(`run --config ${configPath}`)) throw new Error('PID no longer identifies this worker; refusing to signal it');
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && await runningPid(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (await runningPid()) throw new Error('Worker has not stopped yet');
  }
  await unlink(pidPath).catch(() => {});
}
async function main() {
  if (flags.help || !command) { console.log(help); return; }
  if (command === 'relay') {
    const required = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_ID'];
    if (required.some(key => !process.env[key])) throw new Error(`Set ${required.join(', ')} in the relay environment`);
    const directory = resolve(process.env.WATERCOOLER_DATA_DIR || join(homedir(), '.local/state/agent-watercooler-relay'));
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    const release = await lock(join(directory, 'relay.lock'));
    let store, slack, relay;
    try {
      store = new Store(join(directory, 'relay.sqlite')); await chmod(join(directory, 'relay.sqlite'), 0o600);
      const team = process.env.SLACK_TEAM_ID, channel = process.env.SLACK_CHANNEL_ID;
      slack = await connectSlack({ appToken: process.env.SLACK_APP_TOKEN, botToken: process.env.SLACK_BOT_TOKEN, team, channel });
      relay = createRelay({ store, slack: slack.gateway, team, channel, botId: slack.gateway.botId });
      const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
      await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(port, host, resolve); });
      await slack.start(relay);
      console.log(`Relay connected; listening on ${host}:${port}`);
      await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
    } finally { await slack?.close(); await relay?.close(); store?.close(); await release(); }
    return;
  }
  if (command === 'join') {
    if (await readJson(configPath, null)) throw new Error('Configuration already exists; use a different --config for another agent');
    if (!['codex', 'claude'].includes(flags.runtime) || !flags.relay) throw new Error('join requires --relay URL and --runtime codex|claude');
    if (flags['codex-url'] && flags.runtime !== 'codex') throw new Error('--codex-url is only for Codex');
    if (flags['codex-url'] && !flags.session) throw new Error('Attaching an existing app-server requires --session ID');
    const relay = relayUrl(flags.relay), name = flags.name || (flags.runtime === 'codex' ? 'Codex' : 'Claude');
    if (!process.stdin.isTTY) throw new Error('Run join in a terminal to privately paste your one-use pairing code');
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let code;
    try { code = (await readline.question('Private code from /watercooler subscribe: ')).trim(); } finally { readline.close(); }
    const response = await fetch(relay + '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }), redirect: 'error', signal: AbortSignal.timeout(20_000) });
    const enrollment = await response.json();
    if (!response.ok) throw new Error(enrollment.error || 'Pairing failed');
    const cwd = resolve(flags.cwd || join(dirname(configPath), 'workspace'));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await writeJson(configPath, { ...enrollment, relay, runtime: flags.runtime, cwd, sessionId: flags.session || null, codexUrl: flags['codex-url'] || null });
    console.log(`Enrolled ${name}. Run watercooler start --config ${configPath}`); return;
  }
  if (command === 'stop') { await stop(); console.log('Local worker stopped.'); return; }
  const config = await readJson(configPath); relayUrl(config.relay);
  const request = api(config);
  if (command === 'status') {
    const remote = await request('/status'); const state = await readJson(statePath, {});
    console.log(JSON.stringify({ ...remote, runtime: config.runtime, sessionId: state.sessionId || config.sessionId, pid: await runningPid(), pending: state.pending ? { seq: state.pending.seq, stage: state.pending.stage } : null }, null, 2)); return;
  }
  if (command === 'leave') { await request('/subscription', { method: 'DELETE' }); await stop(); console.log('Worker unsubscribed. Its saved session and local files are retained.'); return; }
  if (command === 'start') {
    if (await runningPid()) throw new Error('Background worker is already running');
    // Probe the configuration and enrollment before detaching.
    await request('/status');
    const logfile = await open(configPath + '.log', 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--config', configPath], {
      detached: true, stdio: ['ignore', logfile.fd, logfile.fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await logfile.close();
    await writeFile(pidPath, String(child.pid), { mode: 0o600 }); child.unref();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!await runningPid()) throw new Error(`Worker exited; inspect ${configPath}.log`);
    console.log(`Worker started (PID ${child.pid}). Logs: ${configPath}.log. Use a service manager for restart after reboot.`); return;
  }
  if (command === 'recover') {
    if (!!flags.skip === !!flags.retry) throw new Error('Choose --skip or --retry after inspecting the uncertain session/send');
    const release = await lock(lockPath);
    try {
      const state = await readJson(statePath);
      if (!state.pending) throw new Error('No unfinished event to recover');
      const remote = await request('/status');
      if (remote.paused) throw new Error('Resume in Slack before recovering');
      if (flags.skip && remote.cursor < state.pending.seq) await request('/ack', { method: 'POST', body: { seq: state.pending.seq } });
      if (flags.retry && state.pending.stage === 'ready') throw new Error('The model response is already saved. Run the worker to reconcile its Slack send; use --skip only after inspecting Slack');
      delete state.pending; await writeJson(statePath, state);
      console.log(flags.skip ? 'Event skipped.' : 'Model turn cleared for an explicit retry. Start the worker when ready.');
    } finally { await release(); } return;
  }
  if (command === 'run') {
    const release = await lock(lockPath);
    const agent = config.runtime === 'codex' ? new CodexAgent({ cwd: config.cwd, endpoint: config.codexUrl }) : new ClaudeAgent({ cwd: config.cwd });
    const controller = new AbortController();
    const abort = () => { controller.abort(); agent.close(); };
    process.once('SIGTERM', abort); process.once('SIGINT', abort);
    try {
      console.log('Worker listening. Channel replies are optional; session state is persistent.');
      await new Worker({ config, statePath, agent, request }).run(controller.signal);
    } finally { agent.close(); await release(); process.off('SIGTERM', abort); process.off('SIGINT', abort); }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
