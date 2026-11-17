import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAgent, ClaudeAgent } from '../lib/agents.mjs';
import { SocketModeClient } from '@slack/socket-mode';
import { bindSocket } from '../lib/slack.mjs';

async function fixture(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'watercooler-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, 'agent');
  await writeFile(command, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { directory, command };
}
test('Codex app-server protocol starts then resumes the same thread, including fast notifications', async t => {
  const { directory, command } = await fixture(t, `
const fs = require('node:fs');
const lines = require('node:readline').createInterface({input:process.stdin});
const send = msg => process.stdout.write(JSON.stringify(msg)+'\\n');
let counter=0;
lines.on('line', line => {
  const msg=JSON.parse(line); fs.appendFileSync('requests.jsonl',line+'\\n');
  if(msg.method==='initialized') return;
  if(msg.method==='initialize') return send({id:msg.id,result:{}});
  if(msg.method==='thread/start'||msg.method==='thread/resume') return send({id:msg.id,result:{thread:{id:msg.params.threadId||'thread-one'}}});
  if(msg.method==='turn/start') {
    const id='turn-'+(++counter);
    send({method:'item/completed',params:{threadId:'thread-one',turnId:id,item:{type:'agentMessage',text:JSON.stringify({action:'silent',text:''})}}});
    send({method:'turn/completed',params:{threadId:'thread-one',turn:{id,status:'completed',items:[]}}});
    send({id:msg.id,result:{turn:{id}}});
  }
});`);
  const agent = new CodexAgent({ cwd: directory, command }); t.after(() => agent.close());
  let sessionId;
  const onSession = async id => { sessionId = id; };
  assert.equal((await agent.run({ prompt: 'one', onSession })).action, 'silent');
  await agent.run({ prompt: 'two', sessionId, onSession });
  const requests = (await readFile(join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.map(r => r.method), ['initialize', 'initialized', 'thread/start', 'turn/start', 'thread/resume', 'turn/start']);
  assert.equal(requests[4].params.threadId, 'thread-one');
  assert.equal(requests[3].params.sandboxPolicy.type, 'readOnly');
});

test('Claude adapter uses exact session IDs and structured output with tools disabled', async t => {
  const { directory, command } = await fixture(t, `
const fs = require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync('args.jsonl',JSON.stringify(args)+'\\n');
process.stdin.resume(); process.stdin.on('end',()=>{
 const flag=args.includes('--resume')?'--resume':'--session-id';
 console.log(JSON.stringify({session_id:args[args.indexOf(flag)+1],structured_output:{action:'reply',text:'hello'}}));
});`);
  const agent = new ClaudeAgent({ cwd: directory, command }); t.after(() => agent.close());
  let sessionId; const onSession = async id => { sessionId = id; };
  await agent.run({ prompt: 'one', onSession }); const first = sessionId;
  await agent.run({ prompt: 'two', sessionId, onSession });
  const args = (await readFile(join(directory, 'args.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(args[0][args[0].indexOf('--session-id') + 1], first);
  assert.equal(args[1][args[1].indexOf('--resume') + 1], first);
  assert.equal(args[1][args[1].indexOf('--tools') + 1], '');
  assert(!args[1].includes('--dangerously-skip-permissions'));
});

test('real Slack SDK dispatch persists events before ACK and sends pairing codes ephemerally', async () => {
  const socket = new SocketModeClient({ appToken: 'synthetic-test-token', logLevel: 'error' });
  const actions = [];
  socket.send = async id => { actions.push(`ack:${id}`); };
  bindSocket(socket, {
    ingest: payload => actions.push(`persist:${payload.event_id}`),
    command: async () => 'private-code',
  }, { chat: { postEphemeral: async data => actions.push(`ephemeral:${data.user}`) } });
  await socket.onWebSocketMessage(JSON.stringify({ type: 'events_api', envelope_id: 'envelope1', payload: { event_id: 'E1', event: { type: 'message' } } }), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['persist:E1', 'ack:envelope1']);
  actions.length = 0;
  await socket.onWebSocketMessage(JSON.stringify({ type: 'slash_commands', envelope_id: 'envelope2', payload: { user_id: 'U1', channel_id: 'C1', text: 'subscribe' } }), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['ack:envelope2', 'ephemeral:U1']);
});
