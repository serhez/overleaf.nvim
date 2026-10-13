'use strict';

const { createHash } = require('node:crypto');
const { apply, diff, transformPair, updateComments } = require('./ot');
const { validateText } = require('./merge');
const outgoingHolds = new Set(['unsupported-insert', 'diff-limit', 'text-options']);

/** One saved-change stream on one project connection. Socket callbacks only
 * report queueing; an op-less applied event at the current base version proves
 * application. The connection owner buffers events before requesting a join. */
class DocumentTransport {
  constructor(engine, { document, source, send, onChange = () => {} }) {
    if (typeof document !== 'string' || !document || typeof source !== 'string' || !source || typeof send !== 'function') {
      throw new TypeError('Transport needs document and connection identities and a sender');
    }
    this.engine = engine;
    this.document = document;
    this.source = source;
    this.send = send;
    this.onChange = onChange;
    this.remote = null;
    this.pending = null;
    this.joining = true;
    this.buffered = [];
    this.held = null;
    this.closing = false;
    this._events = Promise.resolve();
  }

  status() {
    return { state: this.closing ? 'offline' : this.held ? 'held' : this.joining ? 'joining' : this.pending ? 'uploading' : 'idle',
      reason: this.held, version: this.remote?.version ?? null };
  }

  _notify() {
    try { this.onChange(this.status()); } catch { /* UI delivery cannot revoke durable state. */ }
  }

  _enqueue(operation) {
    if (this.closing) return Promise.resolve();
    const event = this._events.catch(() => {}).then(operation);
    this._events = event;
    return event;
  }

  async idle() {
    // Submission failures arrive in promise callbacks; allow them to enqueue
    // their persistence before observing the drain barrier.
    await Promise.resolve();
    await this._events;
  }

  async _hold(reason) {
    this.held = reason;
    const pending = this.engine.snapshot().pending;
    if (pending && pending.status !== 'uncertain') await this.engine.markUncertain(pending.token);
    this._notify();
  }

  beginJoin() {
    return this._enqueue(async () => {
      if (this.pending) await this._hold('uncertain-ack');
      this.joining = true;
      this.buffered = [];
      this.joinOverflow = false;
      this._notify();
    });
  }

  join(snapshot) {
    const captured = structuredClone(snapshot);
    return this._enqueue(async () => {
      validateText(captured?.content, 'joined snapshot');
      if (!Number.isSafeInteger(captured.version) || captured.version < 0) throw new TypeError('Invalid joined version');
      const remote = { content: captured.content, version: captured.version,
        comments: updateComments(captured.content, captured.ranges?.comments ?? [], []) };
      const pending = this.engine.snapshot().pending;
      if (pending && captured.updates !== undefined) {
        try { await this.engine.recoverUpload(pending.token, remote, captured.updates, { queueDrained: captured.queueDrained === true, wire: true }); }
        catch (error) { if (error.code !== 'UNPROVEN_UPLOAD') throw error; }
      }
      await this.engine.receiveRemote(remote, { wire: true });
      this.remote = remote;
      this.joinSnapshot = { content: remote.content, version: remote.version, queueDrained: captured.queueDrained === true };
      if (this.joinOverflow) { await this._hold('join-overflow'); return; }
      this.pending = null;
      this.joining = false;
      this.held = this.engine.snapshot().pending ? 'uncertain-ack' : null;
      const buffered = this.buffered;
      this.buffered = [];
      for (const update of buffered) await this._receive(update);
      await this._publish();
      this._notify();
    });
  }

  publish() { return this._enqueue(() => this._publish()); }

  async _publish() {
    if (this.closing || this.joining || (this.held && !outgoingHolds.has(this.held)) || this.pending) return;
    const previousHold = this.held, revision = this.engine.snapshot().revision;
    let intent;
    try { intent = await this.engine.prepareUpload(this.source); }
    catch (error) {
      if (!['UNSUPPORTED_INSERT', 'OP_LIMIT', 'UNSUPPORTED_TEXT'].includes(error.code)) throw error;
      this.held = error.code === 'UNSUPPORTED_INSERT' ? 'unsupported-insert' : error.code === 'OP_LIMIT' ? 'diff-limit' : 'text-options';
      this._notify();
      return;
    }
    this.held = null;
    if (!intent) {
      if (previousHold || revision !== this.engine.snapshot().revision) this._notify();
      return;
    }
    if (this.closing) return; // close() will retain the durable intent as uncertain.
    if ((intent.wire?.base ?? intent.base) !== this.remote.content || intent.version !== this.remote.version) {
      await this._hold('stale-transport');
      return;
    }
    let operation;
    try { operation = intent.operation ?? diff(intent.base, intent.content); }
    catch { await this._hold('invalid-operation'); return; }
    this.pending = { token: intent.token, operation };
    const update = {
      doc: this.document, v: intent.version, lastV: intent.version, op: operation,
      // This intentionally uses UTF-16 length: it is Overleaf's ShareJS hash,
      // not the byte-length header used by Git's object store.
      hash: createHash('sha1').update('blob ' + (intent.wire?.content ?? intent.content).length + '\0').update(intent.wire?.content ?? intent.content, 'utf8').digest('hex'),
    };
    const rejected = () => this._enqueue(async () => {
      if (this.pending?.token === intent.token) await this._hold('uncertain-ack');
    }).catch(() => { this.held = 'persistence-error'; this._notify(); });
    const queued = () => this._enqueue(async () => {
      if (this.pending?.token === intent.token) await this.engine.markQueued(intent.token);
    }).catch(() => { this.held = 'persistence-error'; this._notify(); });
    try { Promise.resolve(this.send(update)).then(queued, rejected); }
    catch { await this._hold('uncertain-ack'); }
    this._notify();
  }

  receive(update) {
    const captured = structuredClone(update);
    return this._enqueue(async () => {
      if (captured?.doc !== this.document) return;
      if (this.joining) {
        if (this.buffered.length >= 4096) { this.joinOverflow = true; await this._hold('join-overflow'); return; }
        this.buffered.push(captured);
      } else await this._receive(captured);
    });
  }

  async _receive(update) {
    if ((this.held && !outgoingHolds.has(this.held)) || update.doc !== this.document) return;
    if (!Number.isSafeInteger(update.v) || update.v < 0) { await this._hold('invalid-version'); return; }
    if (update.v < this.remote.version) return; // Already covered by a snapshot or applied event.
    if (update.v !== this.remote.version) { await this._hold('version-gap'); return; }
    let content;
    if (update.op === undefined) {
      if (!this.pending) { await this._hold('unexpected-ack'); return; }
      try { content = apply(this.remote.content, this.pending.operation); }
      catch { await this._hold('invalid-operation'); return; }
      const remote = { content, version: update.v + 1,
        comments: updateComments(this.remote.content, this.remote.comments, this.pending.operation) };
      await this.engine.acknowledge(this.pending.token, remote, { wire: true, operation: this.pending.operation });
      this.remote = remote;
      this.pending = null;
    } else {
      let transformed;
      try {
        content = apply(this.remote.content, update.op);
        if (this.pending) [transformed] = transformPair(this.remote.content, this.pending.operation, update.op);
      } catch { await this._hold('invalid-operation'); return; }
      const remote = { content, version: update.v + 1,
        comments: updateComments(this.remote.content, this.remote.comments, update.op) };
      await this.engine.receiveRemote(remote, { wire: true, operation: update.op });
      this.remote = remote;
      if (this.pending) this.pending.operation = transformed;
    }
    this._notify();
    await this._publish();
  }

  close() {
    if (!this._closing) {
      this.closing = true;
      this._closing = this._events.catch(() => {}).then(async () => {
        if (this.engine.snapshot().pending) await this._hold('uncertain-ack');
        this._notify();
      });
      this._events = this._closing;
    }
    return this._closing;
  }
}

module.exports = { DocumentTransport };
