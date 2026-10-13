'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mergeText, validateText } = require('./merge');
const { rebaseEditorHistory, captureEditorCheckpoint, currentText } = require('./history');
const { diff, proveUpload, validateLegacyInsertions, updateComments, utf16Position, apply } = require('./ot');
const { toWire, fromWire, fileFormat } = require('./codec');

const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

function validateRemote(remote) {
  validateText(remote?.content, 'remote content');
  if (!Number.isSafeInteger(remote.version) || remote.version < 0) {
    throw new TypeError('Remote version must be a nonnegative safe integer');
  }
  if (remote.wire !== undefined && projectedText(remote.wire, remote.format, remote.wireBom ?? false) !== remote.content) {
    throw failure('INVALID_REMOTE', 'Remote physical text does not match its logical snapshot and format');
  }
  if (remote.comments !== undefined) updateComments(remote.wire ?? remote.content, remote.comments, []);
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

function resolutionText(content) {
  validateText(content, 'resolution');
  if (Buffer.byteLength(content) > 16 * 1024 * 1024 || /^(?:<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(content)) {
    throw failure('INVALID_RESOLUTION', 'Resolution exceeds the text limit or contains conflict markers');
  }
  return content;
}

function commentAnchor(view, wire, thread, start, end) {
  validateText(view, 'comment view');
  if (Buffer.byteLength(view) > 16 * 1024 * 1024) throw failure('OP_LIMIT', 'Comment view exceeds the document limit');
  const p = utf16Position(view, start?.row, start?.col), finish = utf16Position(view, end?.row, end?.col);
  if (finish <= p) throw failure('INVALID_POSITION', 'Select nonempty text for the comment');
  const selected = view.slice(p, finish);
  const op = updateComments(view, [{ id: thread, op: { p, c: selected, t: thread } }], diff(view, wire))[0].op;
  if (op.c !== selected) throw failure('UNPUBLISHED_SELECTION', 'Save and synchronize the selected text before commenting on it');
  return op;
}

function savedFormat(state) {
  const format = state.savedFormat ?? fileFormat(state.saved, state.remote.format);
  toWire(state.saved, format);
  return format;
}

function projectedText(wire, format, wireBom) {
  if (typeof wireBom !== 'boolean' || (wireBom && !wire.startsWith('\ufeff'))) {
    throw failure('INVALID_REMOTE', 'Server BOM metadata does not match the logical snapshot');
  }
  return fromWire(wireBom ? wire.slice(1) : wire, format);
}

function projectRemote(state, incoming) {
  const format = savedFormat(state);
  let before = state.remote.wire;
  if (before === undefined) {
    if (state.remote.content === incoming.content) before = incoming.content;
    else {
      if (incoming.version !== state.remote.version && /[\r\ufeff]/.test(state.remote.content)) {
        throw failure('UNKNOWN_WIRE_BASE', 'Archived remote representation needs a matching snapshot before wire conversion');
      }
      before = toWire(state.remote.content, fileFormat(state.remote.content));
    }
  }
  checkRemote({ content: before, version: state.remote.version }, incoming);
  const previousBom = state.remote.wire === undefined ? before.startsWith('\ufeff') : state.remote.wireBom ?? false;
  const wireBom = previousBom && incoming.content.startsWith('\ufeff');
  return { base: projectedText(before, format, previousBom), format,
    remote: { version: incoming.version, wire: incoming.content, wireBom,
      content: projectedText(incoming.content, format, wireBom), format,
      ...(incoming.comments === undefined ? {} : { comments: copy(incoming.comments) }) } };
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
    if (state.disk) {
      if (state.disk.content !== null) validateText(state.disk.content, 'disk baseline');
      if (state.disk.pending) state.disk.held = { reason: 'write-recovery' };
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

  bindDisk(path, content) {
    if (content !== null) validateText(content, 'disk content');
    return this._transition(async next => {
      if (next.disk) {
        if (next.disk.path !== path) throw failure('PATH_BOUND', 'Document source path changed');
        return;
      }
      if (next.editor) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Bind the workspace before attaching an editor');
      next.disk = { path, content, pending: null, held: null };
      if (content !== null && content !== next.saved) {
        const merged = await mergeText({ base: null, local: content, remote: next.saved });
        next.conflict = conflict('disk', merged);
        next.saved = next.buffer = content;
        next.savedFormat = null;
      }
    });
  }

  /** An explicit migration supplies no shared ancestor. Keep the source as an
   * independent conflict branch until the saved/native/history choices agree. */
  importBranch(branch, checkpoint, revision) {
    const captured = captureEditorCheckpoint(checkpoint), imported = copy(branch);
    validateText(imported.content, 'legacy text');
    if (Buffer.byteLength(imported.content) > 16 * 1024 * 1024
      || !['file', 'buffer'].includes(imported.origin?.kind) || typeof imported.origin.name !== 'string'
      || imported.origin.name.length > 4096) throw new TypeError('A bounded legacy branch and origin are required');
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.disk || !next.editor || next.conflict || next.pending || next.disk.pending || next.disk.held
        || next.editor?.pending || next.editor?.held || next.editor?.recovery) {
        throw failure('MIGRATION_HELD', 'Resolve existing source, upload, and editor work before importing a branch');
      }
      await this._observeEditor(next, captured);
      if (next.conflict) throw failure('MIGRATION_HELD', 'Reconcile current native edits before migration');
      next.recovery ??= {};
      next.recovery.migration = imported;
      next.conflict = conflict('migration', { reason: 'missing-base', candidate: null,
        inputs: { base: null, local: imported.content, remote: next.saved } });
    });
  }

  receiveDisk(content) {
    if (content !== null) validateText(content, 'disk content');
    return this._transition(next => this._receiveDisk(next, content));
  }

  relocateDisk(from, to, content) {
    validateText(content, 'relocated disk content');
    return this._transition(async next => {
      if (!next.disk || next.disk.path !== from) throw failure('PATH_BOUND', 'Relocation source changed');
      const proposal = next.disk.pending?.kind === 'persistent-undo';
      if ((next.disk.pending && !proposal) || (next.disk.held && !(proposal && next.disk.held.reason === 'write-recovery'))) {
        throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Resolve source recovery before relocation');
      }
      if (proposal) {
        next.recovery ??= {};
        next.recovery.relocationDisk = copy(next.disk);
        next.disk.pending = next.disk.held = null;
      }
      await this._receiveDisk(next, content);
      next.disk.path = to;
      if (next.localArchive === to) next.localArchive = null;
    });
  }

  keepLocal(content, checkpoint, revision, archive = null) {
    validateText(content, 'retained local source');
    const captured = checkpoint === undefined ? undefined : captureEditorCheckpoint(checkpoint);
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.disk || next.disk.held || (next.disk.pending && next.disk.pending.kind !== 'persistent-undo')) {
        throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Recover the source before detaching it');
      }
      if (next.editor && !captured) throw failure('STALE_EDITOR', 'Capture the current native editor before detaching');
      next.localArchive = archive;
      if (next.localOnly) {
        await this._receiveDisk(next, content);
        if (captured) await this._observeEditor(next, captured);
        return;
      }
      next.recovery ??= {};
      next.recovery.localOnly = copy({ remote: next.remote, saved: next.saved, buffer: next.buffer,
        conflict: next.conflict, pending: next.pending, disk: next.disk, editor: next.editor ?? null });
      next.localOnly = true;
      next.saved = content;
      next.savedFormat = null;
      next.buffer = captured ? currentText(captured) : content;
      next.pending = next.conflict = null;
      next.disk.content = content;
      next.disk.pending = null;
      if (captured) next.editor = { checkpoint: captured, saveBase: content, pending: null, held: null };
    });
  }

  async _receiveDisk(next, content) {
    const disk = next.disk;
    if (!disk || disk.pending) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Disk observation needs an established, unblocked baseline');
    if (disk.held?.reason === 'read-retry') disk.held = null;
    if (disk.content === content) return;
    const base = disk.content;
    disk.content = content;
    if (content === null) {
      disk.held = { reason: 'missing-file' };
      return;
    }
    if (next.conflict || disk.held) return;
    const previous = next.saved;
    const merged = await mergeText({ base, local: content, remote: next.saved });
    if (merged.status === 'conflict') next.conflict = conflict('disk', merged);
    else {
      next.saved = merged.content;
      next.savedFormat = null;
      await this._mergeBuffer(next, previous);
    }
  }

  recoverDisk(content, revision) {
    validateText(content, 'recovered disk content');
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.disk) throw failure('NO_WORKSPACE', 'Recovery requires a bound source');
      next.recovery ??= {};
      next.recovery.disk = copy(next.disk);
      next.disk.pending = null;
      next.disk.held = null;
      await this._receiveDisk(next, content);
      if (next.editor) {
        next.editor.pending = null;
        next.editor.held = { reason: 'recovery' };
      }
    });
  }

  prepareReattach(checkpoint, revision) {
    const before = captureEditorCheckpoint(checkpoint);
    return this._transition(next => {
      this._checkRevision(revision);
      if (!next.editor) throw failure('NO_EDITOR', 'No archived editor to restore');
      if (next.editor.recovery) {
        next.recovery ??= {};
        next.recovery.editor = copy(next.editor.recovery);
      }
      next.editor.recovery = { token: randomUUID(), before, target: copy(next.editor.checkpoint) };
      next.editor.held = { reason: 'recovery' };
      return { token: next.editor.recovery.token, checkpoint: next.editor.recovery.target,
        writeContent: currentText(next.editor.recovery.target, { forWrite: true }) };
    });
  }

  /** Keep a reviewed current buffer rather than importing an archived editor.
   * An independently dirty buffer has no established disk ancestor: retain it
   * as a separate branch instead of inferring which file revision it edited. */
  useEditor(checkpoint, revision, disk) {
    const captured = captureEditorCheckpoint(checkpoint);
    validateText(disk, 'observed source text');
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.disk) throw failure('NO_WORKSPACE', 'Editor adoption requires an ordinary source workspace');
      next.recovery ??= {};
      next.recovery.editorChoice = { choice: 'current', editor: copy(next.editor ?? null), buffer: next.buffer, saved: next.saved };
      const content = currentText(captured);
      const matches = content === disk || currentText(captured, { forWrite: true }) === disk;
      const merged = await mergeText({ base: matches ? content : null, local: content, remote: next.saved });
      if (merged.status === 'conflict') next.conflict ??= conflict('buffer', merged);
      next.buffer = merged.status === 'clean' ? merged.content : content;
      next.editor = { checkpoint: captured, saveBase: disk, pending: null, held: null };
    });
  }

  acceptReattach(token, checkpoint) {
    const captured = captureEditorCheckpoint(checkpoint);
    return this._transition(next => {
      const proposal = next.editor?.recovery;
      if (!proposal || proposal.token !== token
        || !isDeepStrictEqual(proposal.target.history, captured.history)
        || !isDeepStrictEqual(proposal.target.options, captured.options)) {
        throw failure('STALE_EDITOR', 'Restored history differs from the reviewed archive');
      }
      next.recovery ??= {};
      next.recovery.editor = proposal;
      next.editor.checkpoint = captured;
      next.editor.recovery = null;
      next.editor.pending = null;
      next.editor.held = null;
    });
  }

  planDiskWrite(undo) {
    const captured = copy(undo);
    return this._transition(next => {
      const disk = next.disk;
      if (!disk || disk.held || disk.pending || next.conflict || disk.content === next.saved) return null;
      disk.pending = { token: randomUUID(), before: disk.content, content: next.saved,
        ...(captured ? { kind: 'persistent-undo', undo: captured } : {}) };
      return disk.pending;
    });
  }

  rememberDiskHistory(review) {
    const captured = copy(review);
    return this._transition(next => {
      if (!next.disk || next.disk.held || captured.content !== next.saved) throw failure('STALE_DISK_WRITE', 'Persistent history target changed');
      next.disk.historyReview = captured;
    });
  }

  finishDiskWrite(token, installed) {
    return this._transition(next => {
      const disk = next.disk;
      if (!disk?.pending || disk.pending.token !== token) throw failure('STALE_DISK_WRITE', 'Disk write is no longer current');
      if (installed) {
        disk.content = disk.pending.content;
        disk.historyReview = null;
      }
      disk.pending = null;
    });
  }

  holdDisk(reason) {
    return this._transition(next => {
      if (!next.disk) throw failure('NO_WORKSPACE', 'Document has no workspace binding');
      next.disk.held = { reason };
    });
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
      next.savedFormat = null;
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
    if (editor.recovery) {
      next.recovery ??= {};
      next.recovery.editor = editor.recovery;
      editor.recovery = null;
    }
    if (!isDeepStrictEqual(editor.checkpoint, checkpoint)) {
      for (const kind of ['historyReview', 'conflictReview']) {
        if (!editor[kind]) continue;
        next.recovery ??= {};
        next.recovery[kind] = editor[kind];
        editor[kind] = null;
      }
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
      await this._saveEditor(next, captured, content);
      // Workspace saves wait for a fresh checkpoint/prepare cycle. Later typing
      // and queued saves must be delivered before observing or replacing disk.
      return next.disk ? null : this._prepareEditorUpdate(next);
    });
  }

  async _saveEditor(next, captured, content) {
    await this._observeEditor(next, captured);
    const merged = await mergeText({ base: next.editor.saveBase, local: content, remote: next.saved });
    next.editor.saveBase = content;
    next.editor.held = null;
    if (next.disk) next.disk.content = content;
    if (merged.status === 'conflict') {
      next.saved = content;
      next.conflict ??= conflict('remote', merged);
    } else {
      next.saved = merged.content;
    }
    next.savedFormat = { fileformat: captured.options.fileformat, bomb: captured.options.bomb };
  }

  beginEditorSave(checkpoint, revision, expected) {
    const captured = captureEditorCheckpoint(checkpoint);
    validateText(expected, 'expected disk text');
    const content = currentText(captured, { forWrite: true });
    return this._transition(next => {
      this._checkRevision(revision);
      if (!next.editor) throw failure('NO_EDITOR', 'Attach an editor before saving');
      if (!next.disk || next.disk.pending || next.disk.held) {
        throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Resolve the workspace hold before saving');
      }
      if (next.disk.content !== expected) throw failure('DISK_CHANGED', 'Disk baseline changed before saving');
      next.disk.pending = { token: randomUUID(), kind: 'save', before: expected, content, checkpoint: captured };
      return next.disk.pending;
    });
  }

  commitEditorSave(token) {
    return this._transition(async next => {
      const pending = next.disk?.pending;
      if (!pending || pending.kind !== 'save' || pending.token !== token) {
        throw failure('STALE_DISK_WRITE', 'Editor save is no longer current');
      }
      await this._saveEditor(next, pending.checkpoint, pending.content);
      next.disk.pending = null;
      return { status: 'written', content: pending.content };
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
    if (next.disk?.held || next.disk?.pending) return { status: 'held', reason: 'workspace-recovery' };
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
    return this._editorProposal(next, result.history);
  }

  _editorProposal(next, history, resolutions, target = { saved: next.saved, content: next.buffer }) {
    const editor = next.editor;
    editor.pending = {
      token: randomUUID(), session: next.session, history, saveBase: target.saved, content: target.content,
      ...(resolutions ? { resolutions } : {}),
    };
    return {
      status: 'ready', token: editor.pending.token, history, content: target.content,
      writeContent: currentText({ history, options: editor.checkpoint.options }, { forWrite: true }),
    };
  }

  prepareHistoryResolution(resolutions, revision) {
    const choices = copy(resolutions);
    return this._transition(async next => {
      this._checkRevision(revision);
      if (next.conflict || next.pending) throw failure('DOCUMENT_CONFLICT', 'Resolve the document or uncertain upload before its undo history');
      if (next.disk?.held || next.disk?.pending) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Resolve the workspace before its undo history');
      if (!next.editor || next.editor.held?.reason !== 'history-conflict') {
        throw failure('NO_HISTORY_CONFLICT', 'No native history conflict is held');
      }
      const result = await rebaseEditorHistory(next.editor.checkpoint, next.buffer, { resolutions: choices });
      if (Object.keys(choices).length) next.editor.historyReview = { content: next.buffer, resolutions: choices };
      if (result.status !== 'clean') return result;
      return this._editorProposal(next, result.history, choices);
    });
  }

  prepareConflictResolution(id, resolutions, revision) {
    const choices = copy(resolutions);
    return this._transition(async next => {
      this._checkRevision(revision);
      if (!next.conflict || next.conflict.id !== id) throw failure('STALE_CONFLICT', 'Conflict is no longer current');
      if (next.pending) throw failure('UPLOAD_PENDING', 'Confirm the pending upload outcome before resolving this document');
      if (!next.editor) throw failure('NO_EDITOR', 'Capture the native editor before reviewing a resolution');
      if (next.disk?.held || next.disk?.pending) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Resolve the workspace before the document');
      if (!choices || typeof choices !== 'object' || Array.isArray(choices)
        || Object.keys(choices).some(key => !['saved', 'buffer', 'history'].includes(key))) {
        throw failure('INVALID_RESOLUTION', 'Unknown document resolution choice');
      }
      if (!Object.hasOwn(choices, 'saved')) {
        const inputs = next.conflict.kind === 'migration'
          ? { base: null, local: next.recovery.migration.content, remote: next.saved }
          : next.conflict.kind === 'disk'
          ? { base: next.conflict.inputs.base, local: next.disk.content, remote: next.saved }
          : { base: next.conflict.inputs.base, local: next.saved, remote: next.remote.content };
        const merged = await mergeText(inputs);
        // A saved resolution is an explicit choice even if this reduced pair
        // merges cleanly. The review also exposes disk, current server text,
        // and the original conflict; none of those branches is silently chosen.
        return { status: 'conflict', stage: 'saved', inputs,
          candidate: merged.status === 'clean' ? merged.content : merged.candidate,
          disk: next.disk?.content ?? null, server: next.remote.content, original: next.conflict.inputs };
      }
      const saved = resolutionText(choices.saved);
      const merged = await mergeText({ base: next.editor.saveBase, local: currentText(next.editor.checkpoint), remote: saved });
      next.editor.conflictReview = { id, choices, remoteVersion: next.remote.version, saved: next.saved, disk: next.disk?.content ?? null };
      let content;
      if (merged.status === 'conflict') {
        if (!Object.hasOwn(choices, 'buffer')) return { ...merged, stage: 'buffer' };
        content = resolutionText(choices.buffer);
      } else {
        if (Object.hasOwn(choices, 'buffer')) throw failure('INVALID_RESOLUTION', 'Only a conflicting unsaved buffer needs a separate choice');
        content = merged.content;
      }
      const rebased = await rebaseEditorHistory(next.editor.checkpoint, content, { resolutions: choices.history ?? {} });
      if (rebased.status !== 'clean') return { ...rebased, stage: 'history' };
      const proposal = this._editorProposal(next, rebased.history, undefined, { saved, content });
      next.editor.pending.resolution = copy(next.editor.conflictReview);
      return proposal;
    });
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
      if (pending.resolution) {
        const review = pending.resolution;
        if (next.conflict?.id !== review.id || next.remote.version !== review.remoteVersion
          || next.saved !== review.saved || (next.disk?.content ?? null) !== review.disk || next.pending) {
          throw failure('STALE_CONFLICT', 'Document changed while its resolution was being prepared');
        }
        next.recovery ??= {};
        next.recovery.conflict = { conflict: next.conflict, checkpoint: next.editor.checkpoint,
          saved: next.saved, buffer: next.buffer, choices: review.choices };
        next.saved = pending.saveBase;
        next.savedFormat = null;
        next.buffer = pending.content;
        next.conflict = null;
        next.editor.conflictReview = null;
      }
      next.editor.checkpoint = captured;
      next.editor.saveBase = pending.saveBase;
      next.editor.pending = null;
      next.editor.held = null;
      next.editor.historyReview = null;
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

  /** Persist a message and its server anchor before the HTTP request. Native
   * selection coordinates never authorize publishing the surrounding buffer. */
  stageComment(selection) {
    const captured = copy(selection);
    return this._transition(next => {
      if (next.localOnly || next.conflict || next.remote.wire === undefined) {
        throw failure('COMMENT_UNAVAILABLE', 'Resolve the document and connect before adding a comment');
      }
      const { thread, message, view, start, end } = captured;
      if (typeof thread !== 'string' || !thread || thread.length > 128 || typeof message !== 'string'
        || !message.trim() || Buffer.byteLength(message) > 1024 * 1024) throw new TypeError('Invalid comment');
      validateText(view, 'comment view');
      next.comments ??= [];
      if (next.comments.length >= 32) throw failure('COMMENT_LIMIT', 'Resolve the retained comment drafts first');
      if (next.comments.some(draft => draft.thread === thread) || next.remote.comments?.some(range => range.id === thread)) {
        throw failure('COMMENT_EXISTS', 'This comment thread already exists');
      }
      const op = commentAnchor(view, next.remote.wire, thread, start, end);
      const draft = { token: randomUUID(), thread, message, op, version: next.remote.version, posted: false, held: null };
      next.comments.push(draft);
      return draft;
    });
  }

  reanchorComment(token, selection) {
    const captured = copy(selection);
    return this._transition(next => {
      if (next.pending?.comments?.includes(token)) throw failure('UPLOAD_PENDING', 'Confirm the pending comment before changing its anchor');
      const draft = next.comments?.find(value => value.token === token);
      if (!draft) throw failure('STALE_COMMENT', 'Comment draft is no longer current');
      if (next.localOnly || next.conflict || next.remote.wire === undefined) throw failure('COMMENT_UNAVAILABLE', 'Resolve the document before changing its anchor');
      const { view, start, end } = captured;
      const op = commentAnchor(view, next.remote.wire, draft.thread, start, end);
      draft.op = op; draft.version = next.remote.version; draft.held = null;
      return draft;
    });
  }

  confirmComment(token) {
    return this._transition(next => {
      const draft = next.comments?.find(value => value.token === token);
      if (!draft) throw failure('STALE_COMMENT', 'Comment draft is no longer current');
      draft.posted = true;
      return draft;
    });
  }

  _advanceComments(next, remote, operation) {
    for (const draft of next.comments ?? []) {
      if (draft.held || draft.version === remote.version) continue;
      const before = next.remote.wire ?? next.remote.content, after = remote.wire ?? remote.content;
      if (operation === undefined || draft.version !== next.remote.version || apply(before, operation) !== after) {
        draft.held = 'anchor-changed';
        continue;
      }
      draft.op = updateComments(before, [{ id: draft.thread, op: draft.op }], operation)
        .find(range => range.id === draft.thread).op;
      draft.version = remote.version;
    }
  }

  receiveRemote(remote, { wire = false, operation } = {}) {
    validateRemote(remote);
    const captured = copy(remote);
    return this._transition(async next => {
      if (next.localOnly) return;
      this._advanceComments(next, captured, operation);
      if (wire) {
        const projected = projectRemote(next, captured);
        next.savedFormat = projected.format;
        if (next.remote.version === captured.version) { next.remote = projected.remote; return; }
        await this._reconcile(next, projected.base, projected.remote);
        return;
      }
      checkRemote(next.remote, captured);
      if (next.remote.version === captured.version) return;
      await this._reconcile(next, next.remote.content, captured);
    });
  }

  /** Persist before returning an intent. The transport must confirm application,
   * not merely receipt/queueing, before calling acknowledge(). */
  prepareUpload(source) {
    if (source !== undefined && (typeof source !== 'string' || !source.length)) throw new TypeError('Invalid upload connection identity');
    return this._transition(next => {
      if (next.localOnly || next.conflict || next.pending
        || (next.disk && (next.disk.held || next.disk.pending || next.disk.content !== next.saved))) return null;
      let wire;
      if (next.remote.wire !== undefined) {
        const format = savedFormat(next);
        const bomb = next.remote.wireBom ?? false;
        wire = { base: next.remote.wire, content: (bomb ? '\ufeff' : '') + toWire(next.saved, format), bomb };
        next.remote.content = projectedText(next.remote.wire, format, bomb);
        next.remote.format = next.savedFormat = format;
      }
      const comments = (next.comments ?? []).filter(draft => draft.posted && !draft.held);
      if (next.saved === next.remote.content && !comments.length) return null;
      if (comments.length && source === undefined) throw failure('COMMENT_UNAVAILABLE', 'Comment publication requires an owned transport');
      const operation = source === undefined ? undefined : diff(wire?.base ?? next.remote.content, wire?.content ?? next.saved);
      if (operation) {
        validateLegacyInsertions(operation);
        const ranges = updateComments(wire?.base ?? next.remote.content,
          comments.map(draft => ({ id: draft.thread, op: draft.op })), operation);
        operation.push(...ranges.map(range => range.op));
        updateComments(wire?.base ?? next.remote.content, next.remote.comments ?? [], operation);
      }
      next.pending = {
        token: randomUUID(), session: next.session, status: 'unacknowledged',
        base: next.remote.content, content: next.saved, version: next.remote.version,
        ...(wire ? { wire } : {}),
        ...(comments.length ? { comments: comments.map(draft => draft.token) } : {}),
        ...(source === undefined ? {} : { source, operation }),
      };
      return next.pending;
    });
  }

  acknowledge(token, remote, { wire = false, operation } = {}) {
    validateRemote(remote);
    const captured = copy(remote);
    return this._transition(async next => {
      const pending = next.pending;
      if (!pending || pending.token !== token) throw failure('STALE_ACK', 'Acknowledgement does not match the pending upload');
      if (pending.session !== next.session || pending.status === 'uncertain') {
        throw failure('UNCERTAIN_ACK', 'This upload needs recovery before it can be acknowledged');
      }
      const projected = wire ? projectRemote(next, captured) : null;
      if (!wire) checkRemote(next.remote, captured);
      if (captured.version <= pending.version) throw failure('INVALID_REMOTE', 'Acknowledgement must advance the submitted version');
      // Use what was actually submitted as the ancestor. Newer saves remain a
      // distinct branch even when the server transformed the submitted operation.
      const ancestor = projected && pending.wire ? projectedText(pending.wire.content, projected.format, pending.wire.bomb ?? false) : pending.content;
      if (pending.comments) next.comments = next.comments.filter(draft => !pending.comments.includes(draft.token));
      this._advanceComments(next, captured, operation);
      if (projected) next.savedFormat = projected.format;
      await this._reconcile(next, ancestor, projected?.remote ?? captured);
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

  markQueued(token) {
    return this._transition(next => {
      if (!next.pending || next.pending.token !== token) throw failure('STALE_ACK', 'Upload is no longer pending');
      next.pending.queued = true;
    });
  }

  recoverUpload(token, remote, updates, { queueDrained = false, wire = false } = {}) {
    validateRemote(remote);
    if (typeof queueDrained !== 'boolean') throw new TypeError('Queue-draining contract must be explicit');
    const captured = copy(remote), history = copy(updates);
    return this._transition(async next => {
      const pending = next.pending;
      if (!pending || pending.token !== token) throw failure('STALE_ACK', 'Upload is no longer pending');
      const projected = wire ? projectRemote(next, captured) : null;
      if (!wire) checkRemote(next.remote, captured);
      const logical = projected && pending.wire ? { ...pending, ...pending.wire } : pending;
      const outcome = proveUpload(logical, captured, history, queueDrained);
      next.recovery ??= {};
      next.recovery.upload = { pending: copy(pending), remote: captured, updates: history, outcome, queueDrained };
      if (next.conflict?.kind === 'uncertain' && next.conflict.reason === 'uncertain-ack') next.conflict = null;
      if (outcome === 'applied' && pending.comments) {
        next.comments = next.comments.filter(draft => !pending.comments.includes(draft.token));
      }
      const remaining = history.filter(update => update.v >= next.remote.version);
      const originalRemote = next.remote;
      let commentBase = next.remote;
      for (const update of remaining) {
        const content = apply(commentBase.wire ?? commentBase.content, update.op);
        const target = { content, wire: content, version: update.v + 1 };
        next.remote = commentBase;
        this._advanceComments(next, target, update.op);
        commentBase = target;
      }
      next.remote = originalRemote;
      const ancestor = outcome === 'applied' ? logical.content : logical.base;
      if (projected) next.savedFormat = projected.format;
      await this._reconcile(next, projected ? projectedText(ancestor, projected.format, pending.wire?.bomb ?? false) : ancestor, projected?.remote ?? captured);
      next.pending = null;
    });
  }

  /** An explicit review may retire uncertainty only after a durable queue receipt and
   * a typed join which drained the server queue. It opens a separate text conflict; no old intent
   * is replayed and no candidate is accepted by this decision. */
  reviewUnknown(token, revision, proof) {
    const captured = copy(proof);
    return this._transition(next => {
      this._checkRevision(revision);
      if (!next.pending || next.pending.token !== token || next.pending.status !== 'uncertain') {
        throw failure('STALE_UPLOAD_REVIEW', 'The uncertain operation changed; review it again');
      }
      if (!captured?.queueDrained || !next.pending.queued) {
        throw failure('QUEUE_NOT_DRAINED', 'A durable queue receipt and a queue-draining server snapshot are both required');
      }
      if (captured.version !== next.remote.version || captured.content !== (next.remote.wire ?? next.remote.content)) {
        throw failure('STALE_UPLOAD_REVIEW', 'The remote snapshot changed after queue inspection');
      }
      next.recovery ??= {};
      next.recovery.uploadDecision = { pending: copy(next.pending), remote: copy(next.remote),
        conflict: copy(next.conflict), queueDrained: true };
      for (const draft of next.comments ?? []) {
        if (next.pending.comments?.includes(draft.token)) draft.held = 'outcome-unknown';
      }
      next.pending = null;
      next.conflict = conflict('remote', { reason: 'reviewed-uncertainty', candidate: null,
        inputs: { base: null, local: next.saved, remote: next.remote.content } });
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
      next.savedFormat = null;
      this._edit(next, content);
      next.conflict = null;
    });
  }
}

module.exports = { DocumentEngine };
