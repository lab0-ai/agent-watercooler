import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairs (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscribers (
        id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
        name TEXT NOT NULL, cursor INTEGER NOT NULL, paused INTEGER DEFAULT 0,
        revoked INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        subscriber TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL,
        marker TEXT NOT NULL, ts TEXT, data TEXT NOT NULL,
        PRIMARY KEY (subscriber, seq)
      );
    `);
  }
  close() { this.db.close(); }
  tail() { return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq; }
  issuePair(owner, now = Date.now()) {
    const code = secret();
    this.db.prepare('DELETE FROM pairs WHERE expires < ?').run(now);
    this.db.prepare('INSERT INTO pairs VALUES (?, ?, ?)').run(hash(code), owner, now + 300_000);
    return code;
  }
  pairOwner(code, now = Date.now()) {
    return this.db.prepare('SELECT owner FROM pairs WHERE hash = ? AND expires > ?').get(hash(code), now)?.owner;
  }
  enroll(code, name, now = Date.now()) {
    const owner = this.pairOwner(code, now);
    if (!owner) return null;
    const id = randomUUID(), token = secret();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('DELETE FROM pairs WHERE hash = ?').run(hash(code)).changes !== 1) throw new Error('Pairing code already used');
      this.db.prepare('INSERT INTO subscribers (id, hash, owner, name, cursor) VALUES (?, ?, ?, ?, ?)')
        .run(id, hash(token), owner, name, this.tail());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, token, owner, name };
  }
  auth(token) { return this.db.prepare('SELECT * FROM subscribers WHERE hash = ? AND revoked = 0').get(hash(token)); }
  member(id) { return this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id); }
  members() { return this.db.prepare('SELECT id, owner, name FROM subscribers WHERE revoked = 0 AND paused = 0').all(); }
  revokeOwner(owner) {
    this.db.prepare('DELETE FROM pairs WHERE owner = ?').run(owner);
    this.db.prepare('UPDATE subscribers SET revoked = 1 WHERE owner = ?').run(owner);
  }
  revoke(id) { this.db.prepare('UPDATE subscribers SET revoked = 1 WHERE id = ?').run(id); }
  pauseOwner(owner, paused) {
    // Resume starts from now: pausing should not trigger a storm of old work.
    this.db.prepare('UPDATE subscribers SET paused = ?, cursor = ? WHERE owner = ? AND revoked = 0').run(paused ? 1 : 0, this.tail(), owner);
  }
  append(id, data) {
    const result = this.db.prepare('INSERT OR IGNORE INTO events (id, data) VALUES (?, ?)').run(id, JSON.stringify(data));
    return result.changes ? Number(result.lastInsertRowid) : null;
  }
  event(seq) {
    const row = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq);
    return row ? { seq: row.seq, id: row.id, ...JSON.parse(row.data) } : null;
  }
  next(id) {
    const sub = this.member(id);
    if (!sub || sub.revoked || sub.paused) return null;
    const row = this.db.prepare('SELECT seq FROM events WHERE seq > ? ORDER BY seq LIMIT 1').get(sub.cursor);
    return row ? this.event(row.seq) : null;
  }
  ack(id, seq) {
    const sub = this.member(id);
    if (!sub || sub.revoked || sub.paused) return false;
    if (seq <= sub.cursor) return true;
    if (this.next(id)?.seq !== seq) return false;
    this.db.prepare('UPDATE subscribers SET cursor = ? WHERE id = ?').run(seq, id);
    return true;
  }
  context(thread, before) {
    return this.db.prepare("SELECT seq, data FROM events WHERE seq <= ? AND json_extract(data, '$.thread') = ? ORDER BY seq DESC LIMIT 20")
      .all(before, thread).reverse().map(row => ({ seq: row.seq, ...JSON.parse(row.data) }));
  }
  outgoing(id, seq) { return this.db.prepare('SELECT * FROM outbox WHERE subscriber = ? AND seq = ?').get(id, seq); }
  prepareOutgoing(id, seq, data) {
    this.db.prepare('INSERT OR IGNORE INTO outbox VALUES (?, ?, ?, ?, NULL, ?)')
      .run(id, seq, 'sending', randomUUID(), JSON.stringify(data));
    return this.outgoing(id, seq);
  }
  sent(id, seq, ts) { this.db.prepare("UPDATE outbox SET status = 'sent', ts = ? WHERE subscriber = ? AND seq = ?").run(ts, id, seq); }
}
