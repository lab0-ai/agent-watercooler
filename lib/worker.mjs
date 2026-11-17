import { readJson, writeJson, api, ApiError } from './local.mjs';
import { promptFor, BusyError } from './agents.mjs';

const sleep = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
  if (signal?.aborted) done();
});
export class Worker {
  constructor({ config, statePath, agent, request = api(config), log = console }) {
    this.config = config; this.statePath = statePath; this.agent = agent; this.request = request; this.log = log;
  }
  async load() {
    this.state = await readJson(this.statePath, { subscription: this.config.id, sessionId: this.config.sessionId || null });
    if (this.state.subscription !== this.config.id) throw new Error('State belongs to another subscription');
    await this.reconcileAcknowledgement();
  }
  async reconcileAcknowledgement() {
    if (!this.state.pending) return;
    const remote = await this.request('/status');
    if (remote.cursor >= this.state.pending.seq && this.state.pending.stage === 'ready') {
      this.state.lastAcknowledged = this.state.pending.seq; delete this.state.pending; await this.save();
    }
  }
  async save() { await writeJson(this.statePath, this.state); }
  async step(signal) {
    if (!this.state) await this.load();
    const { event, paused } = await this.request('/events', { signal });
    if (!event || paused) return false;
    if (this.state.pending && this.state.pending.seq !== event.seq) {
      await this.reconcileAcknowledgement();
    }
    if (this.state.pending && this.state.pending.seq !== event.seq) {
      // A pause/resume may intentionally skip queued work, but must not discard an uncertain run.
      throw new Error('Relay cursor changed with an unfinished local event; inspect and recover before continuing');
    }
    if (!event.wake) {
      await this.request('/ack', { method: 'POST', body: { seq: event.seq }, signal });
      return true;
    }
    if (!this.state.pending) {
      this.state.pending = { seq: event.seq, stage: 'running' }; await this.save();
      try {
        const response = await this.agent.run({ prompt: promptFor(event, this.config), sessionId: this.state.sessionId,
          onSession: async id => { this.state.sessionId = id; await this.save(); } });
        this.state.pending = { seq: event.seq, stage: 'ready', response }; await this.save();
      } catch (error) {
        if (error instanceof BusyError) { delete this.state.pending; await this.save(); return false; }
        throw error;
      }
    }
    if (this.state.pending.stage === 'running') throw new Error('Previous agent run has an uncertain outcome. Inspect the session, then use watercooler recover');
    if (this.state.pending.response.action === 'reply') {
      await this.request('/reply', { method: 'POST', body: { seq: event.seq, text: this.state.pending.response.text }, signal });
    }
    await this.request('/ack', { method: 'POST', body: { seq: event.seq }, signal });
    this.state.lastAcknowledged = event.seq; delete this.state.pending; await this.save();
    return true;
  }
  async run(signal) {
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        const processed = await this.step(signal); delay = 1_000;
        if (!processed) await sleep(1_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ApiError && error.status === 409 && /paused/.test(error.message)) {
          await sleep(1_000, signal); continue;
        }
        // Transport failures retry the saved result, never rerun a completed model turn.
        if (error instanceof ApiError && error.status >= 500 || error.name === 'TimeoutError' || error instanceof TypeError && error.message === 'fetch failed') {
          this.log.error('Relay unavailable; reconnecting with the saved cursor.');
          await sleep(delay, signal); delay = Math.min(delay * 2, 30_000); continue;
        }
        throw error;
      }
    }
  }
}
