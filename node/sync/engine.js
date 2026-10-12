'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mergeText, validateText } = require('./merge');
const { rebaseEditorHistory, captureEditorCheckpoint, currentText } = require('./history');

const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

function validateRemote(remote) {
  validateText(remote?.content, 'remote content');
  if (!Number.isSafeInteger(remote.version) || remote.version < 0) {
    throw new TypeError('Remote version must be a nonnegative safe integer');
  }
}

function checkRemote(current, incoming) {
  if (incoming.version < current.version) throw failure('STALE_REMOTE', 'Remote snapshot is older than the current version');
  if (incoming.version === current.version && incoming.content !== current.content) {
    throw failure('INVALID_REMOTE', 'Remote content changed without a new version');
  }
}

function conflict(kind, result) {
  return { id: randomUUID(), kind, inputs: result.inputs, candidate: result.candidate, reason: result.reason };
}

/**
 * Durable single-document reconciliation, independent of Neovim and sockets.
 * `saved` is the publishable branch (including incorporated remote changes).
 * The workspace adapter must install its changes with disk/buffer revision guards.
 * Callers retain rejected editor snapshots for re-reconciliation; rejection is
 * never an instruction to replace the editor's newer contents.
 */
class DocumentEngine {
  static async open(store, id, initial) {
    const record = await store.read(id);
    let state;
    if (record) {
      if (initial !== undefined) throw new Error('Reopening a document requires explicit remote reconciliation');
      state = record.state;
      if (state.format !== 1) throw new Error('Unsupported document recovery format');
      validateRemote(state.remote);
      validateText(state.saved, 'saved content');
      validateText(state.buffer, 'buffer content');
      if (state.pending) {
        state.pending.status = 'uncertain';
        state.conflict ??= conflict('uncertain', {
          reason: 'uncertain-ack', candidate: null,
          inputs: { base: state.pending.base, local: state.saved, remote: state.remote.content },
        });
      }
    } else {
      validateRemote(initial);
      state = {
        format: 1, remote: copy(initial), saved: initial.content, buffer: initial.content,
        pending: null, conflict: null,
      };
    }
    state.history ??= { undo: [], redo: [] };
    for (const direction of ['undo', 'redo']) {
      if (!Array.isArray(state.history[direction])) throw new Error('Invalid document undo history');
      for (const entry of state.history[direction]) {
        validateText(entry.base, 'undo base');
        validateText(entry.content, 'undo content');
      }
    }
    if (state.editor) {
      state.editor.checkpoint = captureEditorCheckpoint(state.editor.checkpoint);
      validateText(state.editor.saveBase, 'editor save baseline');
      // A process restart cannot establish whether a proposed import happened.
      // Retain its original checkpoint and desired buffer; require a fresh view.
      if (state.editor.pending) {
        state.editor.pending = null;
        state.editor.held = { reason: 'recovery' };
      }
    }
    state.session = randomUUID();
    const written = await store.write(id, state, record?.revision ?? 0);
    return new DocumentEngine(store, id, written);
  }

  constructor(store, id, record) {
    this._store = store;
    this._id = id;
    this._record = record;
    this._events = Promise.resolve();
  }

  snapshot() {
    return { revision: this._record.revision, ...copy(this._record.state) };
  }

  _transition(change) {
    const event = this._events.catch(() => {}).then(async () => {
      const next = copy(this._record.state);
      const result = await change(next);
      if (JSON.stringify(next) !== JSON.stringify(this._record.state)) {
        this._record = await this._store.write(this._id, next, this._record.revision);
      }
      return copy(result);
    });
    this._events = event;
    return event;
  }

  _checkRevision(revision) {
    if (revision !== this._record.revision) {
      throw failure('STALE_REVISION', 'Document changed since this editor snapshot was captured');
    }
  }

  // One call records one local undo unit. Incoming updates and disk observations
  // must use their own methods, never edit(), even if their text is identical.
  edit(content, revision) {
    validateText(content, 'buffer content');
    return this._transition(next => {
      this._checkRevision(revision);
      this._edit(next, content);
    });
  }

  _edit(next, content) {
    this._checkStandaloneHistory(next);
    if (next.buffer === content) return;
    next.history.undo.push({ base: content, content: next.buffer });
    next.history.redo = [];
    next.buffer = content;
  }

  undo(revision) {
    return this._history('undo', 'redo', revision);
  }

  redo(revision) {
    return this._history('redo', 'undo', revision);
  }

  _history(direction, reverse, revision) {
    return this._transition(async next => {
      this._checkRevision(revision);
      this._checkStandaloneHistory(next);
      const entry = next.history[direction].at(-1);
      if (!entry) return false;
      const merged = await mergeText({ base: entry.base, local: entry.content, remote: next.buffer });
      if (merged.status === 'conflict') {
        throw Object.assign(failure('UNDO_CONFLICT', `Cannot ${direction} across overlapping edits`), {
          inputs: merged.inputs, candidate: merged.candidate,
        });
      }
      // Reverse the actual rebased change, not the original entry. This preserves
      // incoming text on redo and consumes already-reverted changes only once.
      next.history[reverse].push({ base: merged.content, content: next.buffer });
      next.history[direction].pop();
      next.buffer = merged.content;
      return true;
    });
  }

  save(content, revision) {
    validateText(content, 'saved content');
    return this._transition(async next => {
      this._checkRevision(revision);
      this._checkStandaloneHistory(next);
      const previous = next.saved;
      next.saved = content;
      if (!next.conflict) await this._mergeBuffer(next, previous);
    });
  }

  _checkStandaloneHistory(next) {
    if (next.editor) throw failure('EDITOR_ATTACHED', 'Use native editor checkpoints and saves for this document');
  }

  /** The checkpoint is what Neovim actually displays; buffer remains the desired
   * merged text. Keeping these separate permits typing while an update is held. */
  checkpointEditor(checkpoint, revision) {
    const captured = captureEditorCheckpoint(checkpoint);
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.editor) {
        if (currentText(captured) !== next.buffer) throw failure('STALE_EDITOR', 'Initial editor text differs from the document');
        next.editor = { checkpoint: captured, saveBase: next.saved, pending: null, held: null };
      } else {
        await this._observeEditor(next, captured);
      }
    });
  }

  async _observeEditor(next, checkpoint) {
    const editor = next.editor;
    if (!editor) throw failure('NO_EDITOR', 'Capture the initial editor state first');
    if (!next.conflict) {
      const merged = await mergeText({
        base: currentText(editor.checkpoint), local: currentText(checkpoint), remote: next.buffer,
      });
      if (merged.status === 'conflict') next.conflict = conflict('buffer', merged);
      else next.buffer = merged.content;
    }
    editor.checkpoint = checkpoint;
    editor.pending = null;
  }

  /** Record an ordinary local save, reconcile against what that editor had seen,
   * and retry any held incoming update using the fresh native history. */
  saveEditor(checkpoint, revision, content) {
    const captured = captureEditorCheckpoint(checkpoint);
    validateText(content, 'saved disk text');
    if (content !== currentText(captured, { forWrite: true })) {
      throw failure('SAVE_MISMATCH', 'Saved disk text does not match the captured ordinary write; reconcile it separately');
    }
    return this._transition(async next => {
      this._checkRevision(revision);
      await this._observeEditor(next, captured);
      const merged = await mergeText({ base: next.editor.saveBase, local: content, remote: next.saved });
      next.editor.saveBase = content;
      next.editor.held = null;
      if (merged.status === 'conflict') {
        next.saved = content;
        next.conflict ??= conflict('remote', merged);
      } else {
        next.saved = merged.content;
      }
      return this._prepareEditorUpdate(next);
    });
  }

  prepareEditorUpdate(revision) {
    return this._transition(async next => {
      this._checkRevision(revision);
      return this._prepareEditorUpdate(next);
    });
  }

  async _prepareEditorUpdate(next) {
    const editor = next.editor;
    if (!editor) throw failure('NO_EDITOR', 'Capture the initial editor state first');
    if (next.conflict) return { status: 'held', reason: 'document-conflict' };
    if (editor.held) return { status: 'held', ...editor.held };
    if (editor.pending || currentText(editor.checkpoint) === next.buffer) return null;
    let result;
    try {
      result = await rebaseEditorHistory(editor.checkpoint, next.buffer);
    } catch (error) {
      if (!['HISTORY_LIMIT', 'UNSUPPORTED_TEXT'].includes(error.code)) throw error;
      editor.held = { reason: error.code === 'HISTORY_LIMIT' ? 'history-limit' : 'text-options' };
      return { status: 'held', ...editor.held };
    }
    if (result.status === 'held') {
      editor.held = { reason: result.reason };
      return result;
    }
    if (result.status === 'conflict') {
      editor.held = { reason: 'history-conflict', seq: result.seq, inputs: result.inputs, candidate: result.candidate };
      return { status: 'held', ...editor.held };
    }
    editor.pending = {
      token: randomUUID(), session: next.session, history: result.history, saveBase: next.saved, content: next.buffer,
    };
    return {
      status: 'ready', token: editor.pending.token, history: result.history, content: next.buffer,
      writeContent: currentText({ history: result.history, options: editor.checkpoint.options }, { forWrite: true }),
    };
  }

  _editorUpdate(next, token) {
    const pending = next.editor?.pending;
    if (!pending || pending.token !== token || pending.session !== next.session) {
      throw failure('STALE_EDITOR_UPDATE', 'Editor update is no longer current');
    }
    return pending;
  }

  holdEditorUpdate(token, reason) {
    if (!['undo-metadata', 'history-limit'].includes(reason)) throw new TypeError('Invalid editor hold reason');
    return this._transition(next => {
      this._editorUpdate(next, token);
      next.editor.pending = null;
      next.editor.held = { reason };
    });
  }

  acceptEditorUpdate(token, checkpoint) {
    const captured = captureEditorCheckpoint(checkpoint);
    return this._transition(next => {
      const pending = this._editorUpdate(next, token);
      if (!isDeepStrictEqual(captured.history, pending.history)
        || !isDeepStrictEqual(captured.options, next.editor.checkpoint.options)) {
        throw failure('STALE_EDITOR', 'Installed editor history differs from the proposed update');
      }
      next.editor.checkpoint = captured;
      next.editor.saveBase = pending.saveBase;
      next.editor.pending = null;
      next.editor.held = null;
      // Incoming revisions received during the import stay in next.buffer.
    });
  }

  async _mergeBuffer(next, previousSaved) {
    const merged = await mergeText({ base: previousSaved, local: next.buffer, remote: next.saved });
    if (merged.status === 'conflict') next.conflict = conflict('buffer', merged);
    else next.buffer = merged.content;
  }

  async _reconcile(next, base, remote) {
    const previousSaved = next.saved;
    next.remote = remote;
    if (next.conflict) return;
    const merged = await mergeText({ base, local: next.saved, remote: remote.content });
    if (merged.status === 'conflict') {
      next.conflict = conflict('remote', merged);
    } else {
      next.saved = merged.content;
      await this._mergeBuffer(next, previousSaved);
    }
  }

  receiveRemote(remote) {
    validateRemote(remote);
    const captured = copy(remote);
    return this._transition(async next => {
      checkRemote(next.remote, captured);
      if (next.remote.version === captured.version) return;
      await this._reconcile(next, next.remote.content, captured);
    });
  }

  /** Persist before returning an intent. The transport must confirm application,
   * not merely receipt/queueing, before calling acknowledge(). */
  prepareUpload() {
    return this._transition(next => {
      if (next.conflict || next.pending || next.saved === next.remote.content) return null;
      next.pending = {
        token: randomUUID(), session: next.session, status: 'unacknowledged',
        base: next.remote.content, content: next.saved, version: next.remote.version,
      };
      return next.pending;
    });
  }

  acknowledge(token, remote) {
    validateRemote(remote);
    const captured = copy(remote);
    return this._transition(async next => {
      const pending = next.pending;
      if (!pending || pending.token !== token) throw failure('STALE_ACK', 'Acknowledgement does not match the pending upload');
      if (pending.session !== next.session || pending.status === 'uncertain') {
        throw failure('UNCERTAIN_ACK', 'This upload needs recovery before it can be acknowledged');
      }
      checkRemote(next.remote, captured);
      if (captured.version <= pending.version) throw failure('INVALID_REMOTE', 'Acknowledgement must advance the submitted version');
      // Use what was actually submitted as the ancestor. Newer saves remain a
      // distinct branch even when the server transformed the submitted operation.
      await this._reconcile(next, pending.content, captured);
      next.pending = null;
    });
  }

  markUncertain(token) {
    return this._transition(next => {
      if (!next.pending || next.pending.token !== token) throw failure('STALE_ACK', 'Upload is no longer pending');
      next.pending.status = 'uncertain';
      next.conflict ??= conflict('uncertain', {
        reason: 'uncertain-ack', candidate: null,
        inputs: { base: next.pending.base, local: next.saved, remote: next.remote.content },
      });
    });
  }

  resolve(id, content, revision) {
    validateText(content, 'resolution');
    return this._transition(next => {
      this._checkRevision(revision);
      if (!next.conflict || next.conflict.id !== id) throw failure('STALE_CONFLICT', 'Conflict is no longer current');
      if (next.pending) throw failure('UPLOAD_PENDING', 'Confirm the pending upload outcome before resolving this document');
      if (/^(?:<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(content)) {
        throw failure('UNRESOLVED_CONFLICT', 'Resolution still contains conflict markers');
      }
      next.saved = content;
      this._edit(next, content);
      next.conflict = null;
    });
  }
}

module.exports = { DocumentEngine };
