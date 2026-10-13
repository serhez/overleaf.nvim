'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SnapshotStore } = require('../../../node/sync/store');
const { DocumentEngine } = require('../../../node/sync/engine');
const { editorText } = require('../../../node/sync/codec');

const base = 'introduction\nseparator\nconclusion\n';

// The engine treats Neovim's native undo bytes as opaque recovery data. Lua
// integration tests verify their native import and metadata separately.
function editorCheckpoint(contents, current = contents.length - 1) {
  return {
    history: {
      current, preferred: contents.length - 1,
      nodes: contents.map((content, seq) => ({ seq, parent: seq ? seq - 1 : null, content, empty: content === '' })),
    },
    undo: contents.length > 1 ? Buffer.from('opaque native undo fixture').toString('base64') : null,
    tree: { seq_cur: current, seq_last: contents.length - 1 },
    options: { endofline: false, fixendofline: false, bomb: false, fileformat: 'unix', fileencoding: '', binary: false, undolevels: 1000 },
  };
}
// Existing cases use literal joined lines with no final EOL. Explicit saved
// bytes model the frozen disk observation supplied by the workspace adapter.
function saveEditor(engine, checkpoint, revision) {
  const node = checkpoint.history.nodes.find(n => n.seq === checkpoint.history.current);
  return engine.saveEditor(checkpoint, revision, editorText({ ...node, options: checkpoint.options }, { forWrite: true }));
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-engine-test-'));
  const store = await SnapshotStore.open(directory);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const engine = await DocumentEngine.open(store, 'doc', { content: base, version: 1 });
  return { engine, store };
}

test('migration retains an independent branch without saving, publishing, or replacing native edits', async t => {
  const { engine, store } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const native = editorCheckpoint([base, 'UNSAVED ' + base]);
  await engine.checkpointEditor(native, engine.snapshot().revision);
  const before = engine.snapshot();
  await engine.importBranch({ content: 'legacy independent text', origin: { kind: 'file', name: '/old/Paper/main.tex' } },
    native, before.revision);
  const after = engine.snapshot();
  assert.equal(after.conflict.kind, 'migration');
  assert.equal(after.conflict.inputs.base, null);
  assert.equal(after.saved, before.saved);
  assert.equal(after.buffer, before.buffer);
  assert.deepEqual(after.editor.checkpoint, native);
  assert.equal(after.recovery.migration.content, 'legacy independent text');
  assert.equal(await engine.prepareUpload(), null);
  const review = await engine.prepareConflictResolution(after.conflict.id, {}, engine.snapshot().revision);
  assert.equal(review.inputs.local, 'legacy independent text');
  assert.equal(review.inputs.remote, base);
  const reopened = await DocumentEngine.open(store, 'doc');
  assert.equal(reopened.snapshot().recovery.migration.content, 'legacy independent text');
  assert.equal(reopened.snapshot().saved, base);
});

test('never publishes a buffer checkpoint before it is saved', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('unsaved text', engine.snapshot().revision);
  assert.equal(await engine.prepareUpload(), null);
  assert.equal(engine.snapshot().buffer, 'unsaved text');
  assert.equal(engine.snapshot().saved, base);
});

test('rebases native lines using exact DOS text, Unicode, and final-newline metadata', async t => {
  const { store } = await fixture(t);
  const original = 'intro\r\nseparator\r\né😀\r\n';
  const engine = await DocumentEngine.open(store, 'dos', { content: original, version: 1 });
  const checkpoint = editorCheckpoint(['intro\nseparator\né😀']);
  checkpoint.options.fileformat = 'dos';
  checkpoint.options.endofline = true;
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  await engine.receiveRemote({ content: original.replace('é😀', 'THEIR é😀'), version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(update.status, 'ready');
  assert.equal(update.content, original.replace('é😀', 'THEIR é😀'));
  assert.equal(update.history.nodes[0].content, 'intro\nseparator\nTHEIR é😀');
  await engine.acceptEditorUpdate(update.token, { ...checkpoint, history: update.history });
  assert.equal(await engine.prepareEditorUpdate(engine.snapshot().revision), null);
});

test('empty files and blank lines are distinct native observations', async t => {
  const { store } = await fixture(t);
  const empty = editorCheckpoint(['']);
  empty.options.endofline = true;
  const engine = await DocumentEngine.open(store, 'blank', { content: '\n', version: 1 });
  await assert.rejects(engine.checkpointEditor(empty, engine.snapshot().revision), { code: 'STALE_EDITOR' });
  empty.history.nodes[0].empty = false;
  await engine.checkpointEditor(empty, engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, '\n');
});

test('normal saves publish exact frozen disk text including fixendofline without changing the editor view', async t => {
  const { store } = await fixture(t);
  const engine = await DocumentEngine.open(store, 'noeol', { content: 'text', version: 1 });
  const checkpoint = editorCheckpoint(['text']);
  checkpoint.options.fixendofline = true;
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  await engine.saveEditor(checkpoint, engine.snapshot().revision, 'text\n');
  assert.equal(engine.snapshot().buffer, 'text');
  assert.equal((await engine.prepareUpload()).content, 'text\n');
});

test('rejects disk text that cannot be attributed to the frozen native save', async t => {
  const { engine } = await fixture(t);
  const checkpoint = editorCheckpoint([base]);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  const before = engine.snapshot();
  assert.throws(() => engine.saveEditor(checkpoint, before.revision, 'external or custom write'), { code: 'SAVE_MISMATCH' });
  assert.throws(() => engine.saveEditor(checkpoint, before.revision), /saved/i);
  assert.deepEqual(engine.snapshot(), before);
});

test('option-only edits stay unsaved, and unrepresentable incoming options hold the native import', async t => {
  const { store } = await fixture(t);
  const engine = await DocumentEngine.open(store, 'options', { content: 'text\n', version: 1 });
  const checkpoint = editorCheckpoint(['text']);
  checkpoint.options.endofline = true;
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  const changed = structuredClone(checkpoint);
  changed.options.bomb = true;
  await engine.checkpointEditor(changed, engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, '\ufefftext\n');
  assert.equal(await engine.prepareUpload(), null);

  const other = await DocumentEngine.open(store, 'incoming-options', { content: 'text\n', version: 1 });
  await other.checkpointEditor(checkpoint, other.snapshot().revision);
  await other.receiveRemote({ content: 'text', version: 2 });
  assert.deepEqual(await other.prepareEditorUpdate(other.snapshot().revision), { status: 'held', reason: 'text-options' });
  assert.deepEqual(other.snapshot().editor.checkpoint, checkpoint);
  assert.equal(other.snapshot().buffer, 'text');
});

test('persists native editor checkpoints without publishing unsaved edits', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const checkpoint = editorCheckpoint([base, 'MY ' + base]);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  assert.deepEqual((await store.read('doc')).state.editor.checkpoint, checkpoint);
  assert.equal(engine.snapshot().buffer, 'MY ' + base);
  assert.equal(await engine.prepareUpload(), null);
  checkpoint.history.nodes[1].content = 'mutated caller';
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[1].content, 'MY ' + base);
  for (const action of [
    () => engine.edit('bypass native history', engine.snapshot().revision),
    () => engine.undo(engine.snapshot().revision),
    () => engine.redo(engine.snapshot().revision),
    () => engine.save('bypass editor baseline', engine.snapshot().revision),
  ]) await assert.rejects(action(), { code: 'EDITOR_ATTACHED' });
});

test('holds incoming buffer changes durably and retries with fresh history after a normal save', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(update.status, 'ready');
  assert.equal((await store.read('doc')).state.editor.pending.token, update.token);
  await engine.holdEditorUpdate(update.token, 'undo-metadata');
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[0].content, base);
  assert.equal((await engine.prepareEditorUpdate(engine.snapshot().revision)).status, 'held');

  // More local typing and a newer colleague revision arrive while held.
  const local = 'MY ' + base;
  await engine.checkpointEditor(editorCheckpoint([base, local]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR latest conclusion'), version: 3 });
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[1].content, local);
  assert.equal(engine.snapshot().buffer, local.replace('conclusion', 'THEIR latest conclusion'));
  const retry = await saveEditor(engine, editorCheckpoint([base, local]), engine.snapshot().revision);
  assert.equal(retry.status, 'ready');
  assert.notEqual(retry.token, update.token);
  assert.equal(retry.history.nodes[0].content, base.replace('conclusion', 'THEIR latest conclusion'));
  assert.equal(retry.history.nodes[1].content, local.replace('conclusion', 'THEIR latest conclusion'));
  assert.equal((await engine.prepareUpload()).content, local.replace('conclusion', 'THEIR latest conclusion'));

  const installed = editorCheckpoint(retry.history.nodes.map(node => node.content));
  installed.options = Object.fromEntries(Object.entries(installed.options).reverse());
  await engine.acceptEditorUpdate(retry.token, installed);
  assert.equal(engine.snapshot().editor.pending, null);
  assert.equal(engine.snapshot().editor.held, null);
  assert.deepEqual(engine.snapshot().editor.checkpoint, installed);
  await assert.rejects(engine.holdEditorUpdate(update.token, 'undo-metadata'), { code: 'STALE_EDITOR_UPDATE' });
});

test('a fresh save retries a held update after restart without guessing whether an import completed', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  const recovered = await DocumentEngine.open(store, 'doc');
  await assert.rejects(recovered.acceptEditorUpdate(update.token, editorCheckpoint([base])), { code: 'STALE_EDITOR_UPDATE' });
  assert.equal(recovered.snapshot().editor.held.reason, 'recovery');
  assert.equal(recovered.snapshot().editor.checkpoint.history.nodes[0].content, base);
  const retry = await saveEditor(recovered, editorCheckpoint([base]), recovered.snapshot().revision);
  assert.equal(retry.status, 'ready');
  assert.equal(retry.history.nodes[0].content, base.replace('conclusion', 'THEIR conclusion'));
});

test('an editor import acknowledgement cannot discard a newer incoming revision', async (t) => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const first = base.replace('conclusion', 'THEIR conclusion');
  await engine.receiveRemote({ content: first, version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  const latest = base.replace('conclusion', 'THEIR latest conclusion');
  await engine.receiveRemote({ content: latest, version: 3 });
  await engine.acceptEditorUpdate(update.token, editorCheckpoint([first]));
  assert.equal(engine.snapshot().buffer, latest);
  const next = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(next.history.nodes[0].content, latest);
});

test('saving an intentional deletion of an installed incoming edit does not resurrect that edit', async (t) => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const incoming = base.replace('conclusion', 'THEIR conclusion');
  await engine.receiveRemote({ content: incoming, version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  await engine.acceptEditorUpdate(update.token, editorCheckpoint([incoming]));
  await saveEditor(engine, editorCheckpoint([incoming, base]), engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, base);
  assert.equal((await engine.prepareUpload()).content, base);
});

test('new local checkpoints invalidate old import proposals and preserve both branches on overlap', async (t) => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  const local = base.replace('conclusion', 'MY conclusion');
  await engine.checkpointEditor(editorCheckpoint([base, local]), engine.snapshot().revision);
  await assert.rejects(engine.acceptEditorUpdate(update.token, editorCheckpoint([base])), { code: 'STALE_EDITOR_UPDATE' });
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[1].content, local);
  assert.equal(engine.snapshot().conflict.inputs.local, local);
  assert.equal(engine.snapshot().conflict.inputs.remote, base.replace('conclusion', 'THEIR conclusion'));
  assert.equal(await engine.prepareUpload(), null);
});

test('an undo-branch conflict holds the complete proposal and preserves native recovery bytes', async (t) => {
  const { engine } = await fixture(t);
  const checkpoint = editorCheckpoint([base.replace('conclusion', 'OLD conclusion'), base]);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const held = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(held.status, 'held');
  assert.equal(held.reason, 'history-conflict');
  assert.equal(engine.snapshot().editor.pending, null);
  assert.deepEqual(engine.snapshot().editor.checkpoint, checkpoint);
});

test('failed checkpoint persistence exposes no import and leaves a retryable durable revision', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const before = engine.snapshot();
  const failure = t.mock.method(store, 'write', async () => { throw new Error('disk full'); });
  await assert.rejects(engine.prepareEditorUpdate(before.revision), /disk full/);
  assert.deepEqual(engine.snapshot(), before);
  failure.mock.restore();
  assert.equal((await engine.prepareEditorUpdate(before.revision)).status, 'ready');
});

test('rejects stale or malformed editor captures and acknowledgements without changing recovery state', async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.checkpointEditor(editorCheckpoint(['unrelated']), engine.snapshot().revision), { code: 'STALE_EDITOR' });
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const stale = engine.snapshot().revision;
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  await assert.rejects(engine.checkpointEditor(editorCheckpoint([base]), stale), { code: 'STALE_REVISION' });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  const before = engine.snapshot();
  await assert.rejects(engine.acceptEditorUpdate(update.token, editorCheckpoint(['wrong text'])), { code: 'STALE_EDITOR' });
  const malformed = editorCheckpoint([base, 'local']);
  malformed.undo = null;
  assert.throws(() => engine.checkpointEditor(malformed, before.revision));
  assert.deepEqual(engine.snapshot(), before);
});

test('native save A, unsaved B, and incoming C publish only saved A plus C', async (t) => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const a = 'A ' + base;
  const b = 'A with unsaved B ' + base;
  await saveEditor(engine, editorCheckpoint([base, a]), engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.checkpointEditor(editorCheckpoint([base, a, b]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'C conclusion'), version: 2 });
  const saved = a.replace('conclusion', 'C conclusion');
  await engine.acknowledge(upload.token, { content: saved, version: 3 });
  assert.equal(engine.snapshot().saved, saved);
  assert.equal(await engine.prepareUpload(), null);
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(update.history.nodes[2].content, b.replace('conclusion', 'C conclusion'));
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[2].content, b);
});

test('reopening a held update retains its reason and accepts a fresh save checkpoint', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  await engine.holdEditorUpdate(update.token, 'undo-metadata');
  const recovered = await DocumentEngine.open(store, 'doc');
  assert.equal(recovered.snapshot().editor.held.reason, 'undo-metadata');
  const retry = await saveEditor(recovered, editorCheckpoint([base, 'MY ' + base]), recovered.snapshot().revision);
  assert.equal(retry.history.nodes[1].content, ('MY ' + base).replace('conclusion', 'THEIR conclusion'));
});

test('a failed normal-save checkpoint preserves the prior pending revision for recovery', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  const before = engine.snapshot();
  const failure = t.mock.method(store, 'write', async () => { throw new Error('disk full'); });
  await assert.rejects(saveEditor(engine, editorCheckpoint([base, 'MY ' + base]), before.revision), /disk full/);
  assert.deepEqual(engine.snapshot(), before);
  assert.equal((await store.read('doc')).state.saved, before.saved);
  failure.mock.restore();
  assert.equal((await saveEditor(engine, editorCheckpoint([base, 'MY ' + base]), before.revision)).status, 'ready');
});

test('save A, type unsaved B, and receive C publishes only A plus C', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('A introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.edit('A introduction with unsaved B\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'introduction\nseparator\nC conclusion\n', version: 2 });
  const upload = await engine.prepareUpload();
  assert.equal(upload.content, 'A introduction\nseparator\nC conclusion\n');
  assert.equal(upload.base, 'introduction\nseparator\nC conclusion\n');
  assert.equal(upload.version, 2);
  assert.equal(engine.snapshot().buffer, 'A introduction with unsaved B\nseparator\nC conclusion\n');
  await engine.acknowledge(upload.token, { content: upload.content, version: 3 });
  assert.equal(await engine.prepareUpload(), null);
  assert.match(engine.snapshot().buffer, /unsaved B/);
});

test('persists an upload intent before exposing it to the transport', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  assert.deepEqual((await store.read('doc')).state.pending, upload);
  assert.equal(await engine.prepareUpload(), null, 'only one upload can be in flight');
});

test('later saves survive an acknowledgement for an earlier save', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('saved A', engine.snapshot().revision);
  const a = await engine.prepareUpload();
  await engine.save('saved A and B', engine.snapshot().revision);
  await engine.acknowledge(a.token, { content: a.content, version: 2 });
  const b = await engine.prepareUpload();
  assert.equal(b.content, 'saved A and B');
  assert.equal(b.base, 'saved A');
});

test('remote changes during an upload survive its confirmed acknowledgement', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('A introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.receiveRemote({ content: 'introduction\nseparator\nC conclusion\n', version: 2 });
  await engine.acknowledge(upload.token, { content: 'A introduction\nseparator\nC conclusion\n', version: 3 });
  assert.equal(engine.snapshot().saved, 'A introduction\nseparator\nC conclusion\n');
  assert.equal(await engine.prepareUpload(), null);
});

test('overlapping saved and remote edits stop publishing and preserve both branches', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('my paragraph', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'their paragraph', version: 2 });
  const state = engine.snapshot();
  assert.equal(state.saved, 'my paragraph');
  assert.equal(state.remote.content, 'their paragraph');
  assert.equal(state.conflict.kind, 'remote');
  assert.equal(state.conflict.inputs.base, base);
  assert.equal(await engine.prepareUpload(), null);
});

test('overlapping unsaved and incoming edits preserve the unsaved buffer', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('my unsaved paragraph', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'their paragraph', version: 2 });
  assert.equal(engine.snapshot().buffer, 'my unsaved paragraph');
  assert.equal(engine.snapshot().conflict.kind, 'buffer');
  assert.equal(await engine.prepareUpload(), null);
});

test('a restarted pending upload is uncertain and cannot be automatically retried', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  const recovered = await DocumentEngine.open(store, 'doc');
  assert.equal(recovered.snapshot().pending.token, upload.token);
  assert.equal(recovered.snapshot().conflict.kind, 'uncertain');
  await recovered.receiveRemote({ content: 'saved plus a colleague edit', version: 3 });
  assert.equal(await recovered.prepareUpload(), null);
  await assert.rejects(recovered.acknowledge(upload.token, { content: 'saved', version: 2 }), { code: 'UNCERTAIN_ACK' });
  assert.equal(recovered.snapshot().saved, 'saved');
});

test('an old engine instance cannot acknowledge over a recovered session', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  const recovered = await DocumentEngine.open(store, 'doc');
  await assert.rejects(engine.acknowledge(upload.token, { content: 'saved', version: 2 }), { code: 'STALE_REVISION' });
  const { revision, ...state } = recovered.snapshot();
  assert.deepEqual(await store.read('doc'), { revision, state });
});

test('rejects stale buffer snapshots rather than overwriting an incorporated remote edit', async (t) => {
  const { engine } = await fixture(t);
  const revision = engine.snapshot().revision;
  await engine.receiveRemote({ content: 'remote', version: 2 });
  await assert.rejects(engine.edit('captured earlier', revision), { code: 'STALE_REVISION' });
  assert.equal(engine.snapshot().buffer, 'remote');
});

test('rejects out-of-order or inconsistent remote snapshots', async (t) => {
  const { engine } = await fixture(t);
  await engine.receiveRemote({ content: 'remote', version: 3 });
  await assert.rejects(engine.receiveRemote({ content: 'old', version: 2 }), { code: 'STALE_REMOTE' });
  await assert.rejects(engine.receiveRemote({ content: 'different', version: 3 }), { code: 'INVALID_REMOTE' });
  assert.equal(engine.snapshot().remote.content, 'remote');
});

test('resolving a conflict requires the revisions the user actually reviewed', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('local', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'remote', version: 2 });
  const conflict = engine.snapshot();
  await engine.receiveRemote({ content: 'remote newer', version: 3 });
  await assert.rejects(engine.resolve(conflict.conflict.id, 'resolved', conflict.revision), { code: 'STALE_REVISION' });
  assert.equal(engine.snapshot().conflict.id, conflict.conflict.id);
  await engine.resolve(conflict.conflict.id, 'reviewed resolution', engine.snapshot().revision);
  assert.equal((await engine.prepareUpload()).content, 'reviewed resolution');
});

test('failed persistence does not expose a new upload or forget saved work', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const failing = t.mock.method(store, 'write', async () => { throw new Error('disk full'); });
  await assert.rejects(engine.prepareUpload(), /disk full/);
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().saved, 'saved');
  failing.mock.restore();
  assert.equal((await engine.prepareUpload()).content, 'saved');
});

test('returns detached snapshots that cannot mutate engine state', async (t) => {
  const { engine } = await fixture(t);
  engine.snapshot().remote.content = 'mutated';
  assert.equal(engine.snapshot().remote.content, base);
});

test('cannot resolve past an upload whose acceptance is still unknown', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.markUncertain(upload.token);
  const state = engine.snapshot();
  await assert.rejects(engine.resolve(state.conflict.id, 'chosen resolution', state.revision), { code: 'UPLOAD_PENDING' });
  assert.equal(engine.snapshot().pending.token, upload.token);
  assert.equal(await engine.prepareUpload(), null);
});

test('duplicate or unrelated acknowledgements cannot change the remote baseline', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('saved', engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await assert.rejects(engine.acknowledge('wrong', { content: 'wrong', version: 2 }), { code: 'STALE_ACK' });
  await engine.acknowledge(upload.token, { content: 'saved', version: 2 });
  await assert.rejects(engine.acknowledge(upload.token, { content: 'wrong', version: 3 }), { code: 'STALE_ACK' });
  assert.equal(engine.snapshot().remote.content, 'saved');
});

test('saving resolution markers cannot resume publishing', async (t) => {
  const { engine } = await fixture(t);
  await engine.save('local', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'remote', version: 2 });
  const state = engine.snapshot();
  await assert.rejects(engine.resolve(state.conflict.id, state.conflict.candidate, state.revision), { code: 'UNRESOLVED_CONFLICT' });
  assert.equal(await engine.prepareUpload(), null);
});

test('undo and redo preserve a colleague edit arriving after a local edit', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'introduction\nseparator\nTHEIR conclusion\n', version: 2 });
  assert.equal(await engine.undo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, 'introduction\nseparator\nTHEIR conclusion\n');
  assert.equal(await engine.undo(engine.snapshot().revision), false, 'remote edits are not undo entries');
  assert.equal(await engine.redo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, 'MY introduction\nseparator\nTHEIR conclusion\n');
  assert.equal(await engine.redo(engine.snapshot().revision), false);
});

test('incoming edits preserve redo and redo incorporates the latest remote text', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.undo(engine.snapshot().revision);
  await engine.receiveRemote({ content: 'introduction\nseparator\nTHEIR conclusion\n', version: 2 });
  await engine.redo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'MY introduction\nseparator\nTHEIR conclusion\n');
});

test('saved and acknowledged local changes remain undoable without publishing the undo', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.save(engine.snapshot().buffer, engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.acknowledge(upload.token, { content: upload.content, version: 2 });
  await engine.receiveRemote({ content: 'MY introduction\nseparator\nTHEIR conclusion\n', version: 3 });
  await engine.undo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'introduction\nseparator\nTHEIR conclusion\n');
  assert.equal(engine.snapshot().saved, 'MY introduction\nseparator\nTHEIR conclusion\n');
  assert.equal(await engine.prepareUpload(), null, 'undo remains unsaved until an explicit save');
  await engine.save(engine.snapshot().buffer, engine.snapshot().revision);
  assert.equal((await engine.prepareUpload()).content, 'introduction\nseparator\nTHEIR conclusion\n');
});

test('an overlapping undo preserves the colleague text and keeps its history entry', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.save(engine.snapshot().buffer, engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.acknowledge(upload.token, { content: upload.content, version: 2 });
  await engine.receiveRemote({ content: 'MY introduction expanded by colleague\nseparator\nconclusion\n', version: 3 });
  const before = engine.snapshot();
  await assert.rejects(engine.undo(before.revision), { code: 'UNDO_CONFLICT' });
  assert.deepEqual(engine.snapshot(), before, 'ambiguous undo changes neither text nor history');
  await engine.receiveRemote({ content: upload.content, version: 4 });
  await engine.undo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, base);
});

test('an overlapping redo preserves incoming text and remains available', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.undo(engine.snapshot().revision);
  await engine.receiveRemote({ content: 'THEIR introduction\nseparator\nconclusion\n', version: 2 });
  const before = engine.snapshot();
  await assert.rejects(engine.redo(before.revision), { code: 'UNDO_CONFLICT' });
  assert.deepEqual(engine.snapshot(), before);
  await engine.receiveRemote({ content: base, version: 3 });
  await engine.redo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'MY introduction\nseparator\nconclusion\n');
});

test('multiple local undo units survive interleaved incoming changes', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'introduction\nseparator\nTHEIR conclusion\n', version: 2 });
  await engine.edit('MY expanded introduction\nseparator\nTHEIR conclusion\n', engine.snapshot().revision);
  await engine.undo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'MY introduction\nseparator\nTHEIR conclusion\n');
  await engine.undo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'introduction\nseparator\nTHEIR conclusion\n');
  await engine.redo(engine.snapshot().revision);
  await engine.redo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'MY expanded introduction\nseparator\nTHEIR conclusion\n');
});

test('a new local edit clears redo but a duplicate checkpoint does not', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('first', engine.snapshot().revision);
  await engine.undo(engine.snapshot().revision);
  await engine.edit(base, engine.snapshot().revision);
  assert.equal(await engine.redo(engine.snapshot().revision), true);
  await engine.undo(engine.snapshot().revision);
  await engine.edit('second', engine.snapshot().revision);
  assert.equal(await engine.redo(engine.snapshot().revision), false);
  await engine.undo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, base);
  assert.equal(await engine.undo(engine.snapshot().revision), false);
});

test('undo and redo reject stale editor revisions and preserve history', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  const revision = engine.snapshot().revision;
  await engine.receiveRemote({ content: 'introduction\nseparator\nTHEIR conclusion\n', version: 2 });
  await assert.rejects(engine.undo(revision), { code: 'STALE_REVISION' });
  await engine.undo(engine.snapshot().revision);
  await assert.rejects(engine.redo(revision), { code: 'STALE_REVISION' });
  await engine.redo(engine.snapshot().revision);
  assert.equal(engine.snapshot().buffer, 'MY introduction\nseparator\nTHEIR conclusion\n');
});

test('undo persistence failure leaves text and history available for retry', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.edit('local', engine.snapshot().revision);
  const before = engine.snapshot();
  const failing = t.mock.method(store, 'write', async () => { throw new Error('disk full'); });
  await assert.rejects(engine.undo(before.revision), /disk full/);
  assert.deepEqual(engine.snapshot(), before);
  failing.mock.restore();
  await engine.undo(before.revision);
  assert.equal(engine.snapshot().buffer, base);
});

test('local undo and redo history survive reopening recovery state', async (t) => {
  const { engine, store } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.receiveRemote({ content: 'introduction\nseparator\nTHEIR conclusion\n', version: 2 });
  const reopened = await DocumentEngine.open(store, 'doc');
  await reopened.undo(reopened.snapshot().revision);
  assert.equal(reopened.snapshot().buffer, 'introduction\nseparator\nTHEIR conclusion\n');
  const reopenedAgain = await DocumentEngine.open(store, 'doc');
  await reopenedAgain.redo(reopenedAgain.snapshot().revision);
  assert.equal(reopenedAgain.snapshot().buffer, 'MY introduction\nseparator\nTHEIR conclusion\n');
});

test('identical independent edits undo once and redo once without duplicate removal', async (t) => {
  const { engine } = await fixture(t);
  const identical = 'SAME introduction\nseparator\nconclusion\n';
  await engine.edit(identical, engine.snapshot().revision);
  await engine.receiveRemote({ content: identical, version: 2 });
  assert.equal(await engine.undo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, base);
  const undone = engine.snapshot();
  assert.equal(await engine.undo(undone.revision), false);
  assert.deepEqual(engine.snapshot(), undone);
  assert.equal(await engine.prepareUpload(), null, 'undo is not published before saving');
  assert.equal(await engine.redo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, identical);
  const redone = engine.snapshot();
  assert.equal(await engine.redo(redone.revision), false);
  assert.deepEqual(engine.snapshot(), redone);
});

test('already reverted local text consumes its undo entry without removing it twice', async (t) => {
  const { engine } = await fixture(t);
  await engine.edit('MY introduction\nseparator\nconclusion\n', engine.snapshot().revision);
  await engine.save(engine.snapshot().buffer, engine.snapshot().revision);
  const upload = await engine.prepareUpload();
  await engine.acknowledge(upload.token, { content: upload.content, version: 2 });
  await engine.receiveRemote({ content: base, version: 3 });
  assert.equal(await engine.undo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, base);
  assert.equal(await engine.undo(engine.snapshot().revision), false);
  assert.equal(await engine.redo(engine.snapshot().revision), true);
  assert.equal(engine.snapshot().buffer, base, 'redo reverses only what undo actually changed');
});


test('explicit disk recovery preserves unsaved checkpoints and reconciles the inspected saved branch', async t => {
  const { engine } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  const edited = 'MY ' + base;
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  await engine.checkpointEditor(editorCheckpoint([base, edited]), engine.snapshot().revision);
  const pending = await engine.beginEditorSave(editorCheckpoint([base, edited]), engine.snapshot().revision, base);
  await engine.holdDisk('write-recovery');
  const before = engine.snapshot();
  await engine.recoverDisk(edited, before.revision);
  const state = engine.snapshot();
  assert.equal(state.disk.pending, null);
  assert.equal(state.disk.held, null);
  assert.equal(state.disk.content, edited);
  assert.equal(state.saved, edited);
  assert.equal(state.buffer, edited);
  assert.deepEqual(state.editor.checkpoint, before.editor.checkpoint);
  assert.equal(state.editor.held.reason, 'recovery');
  assert.deepEqual(state.recovery.disk.pending, pending);
  await assert.rejects(engine.recoverDisk(base, before.revision), { code: 'STALE_REVISION' });
});

test('recovering disk does not clear an uncertain upload', async t => {
  const { engine } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  await engine.edit('SAVED ' + base, engine.snapshot().revision);
  await engine.save('SAVED ' + base, engine.snapshot().revision);
  const disk = await engine.planDiskWrite();
  await engine.finishDiskWrite(disk.token, true);
  const upload = await engine.prepareUpload();
  await engine.markUncertain(upload.token);
  await engine.holdDisk('write-recovery');
  const before = engine.snapshot();
  await engine.recoverDisk(before.disk.content, before.revision);
  const after = engine.snapshot();
  assert.deepEqual(after.pending, before.pending);
  assert.deepEqual(after.conflict, before.conflict);
  assert.equal(after.saved, before.saved);
});


test('reattachment preserves both native histories before restoring an archived editor', async t => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const archived = editorCheckpoint([base, 'UNSAVED ' + base]);
  await engine.checkpointEditor(archived, engine.snapshot().revision);
  const current = editorCheckpoint(['independent disk', 'independent buffer']);
  const proposal = await engine.prepareReattach(current, engine.snapshot().revision);
  assert.deepEqual(proposal.checkpoint, archived);
  assert.deepEqual(engine.snapshot().editor.recovery.before, current);
  assert.deepEqual(engine.snapshot().editor.checkpoint, archived);
  await engine.receiveRemote({ content: base.replace('conclusion', 'REMOTE conclusion'), version: 2 });
  await engine.acceptReattach(proposal.token, archived);
  assert.deepEqual(engine.snapshot().editor.checkpoint, archived);
  assert.equal(engine.snapshot().buffer, ('UNSAVED ' + base).replace('conclusion', 'REMOTE conclusion'));
  assert.equal(engine.snapshot().saved, base.replace('conclusion', 'REMOTE conclusion'));
  assert.equal(engine.snapshot().editor.held, null);
  assert.deepEqual(engine.snapshot().recovery.editor.before, current);
});

test('choosing the current file retains the displaced archive and never publishes its unsaved text', async t => {
  const { engine } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  await engine.edit('archived unsaved', engine.snapshot().revision);
  const archived = editorCheckpoint([base, 'archived unsaved']);
  await engine.checkpointEditor(archived, engine.snapshot().revision);
  const current = editorCheckpoint([base]);
  await engine.useEditor(current, engine.snapshot().revision, base);
  const state = engine.snapshot();
  assert.deepEqual(state.editor.checkpoint, current);
  assert.deepEqual(state.recovery.editorChoice.editor.checkpoint, archived);
  assert.equal(state.recovery.editorChoice.buffer, 'archived unsaved');
  assert.equal(state.buffer, base);
  assert.equal(state.saved, base);
  assert.equal(await engine.prepareUpload(), null);
});

test('an independently dirty existing buffer attaches as an unresolved branch without replacing disk or remote', async t => {
  const { engine } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  const dirty = editorCheckpoint(['previous disk', 'current unsaved']);
  await engine.useEditor(dirty, engine.snapshot().revision, base);
  const state = engine.snapshot();
  assert.deepEqual(state.editor.checkpoint, dirty);
  assert.equal(state.buffer, 'current unsaved');
  assert.equal(state.saved, base);
  assert.equal(state.disk.content, base);
  assert.equal(state.conflict.reason, 'missing-base');
  assert.equal(state.conflict.inputs.local, 'current unsaved');
  assert.equal(await engine.prepareUpload(), null);
});

test('using the current editor keeps later remote text available for native rebase and rejects stale decisions', async t => {
  const { engine } = await fixture(t);
  await engine.bindDisk('main.tex', base);
  const stale = engine.snapshot().revision;
  const incoming = base.replace('conclusion', 'THEIR conclusion');
  await engine.receiveRemote({ content: incoming, version: 2 });
  await assert.rejects(engine.useEditor(editorCheckpoint([base]), stale, base), { code: 'STALE_REVISION' });
  await engine.useEditor(editorCheckpoint([base]), engine.snapshot().revision, base);
  assert.equal(engine.snapshot().buffer, incoming);
  assert.equal(engine.snapshot().saved, incoming);
  const update = await engine.prepareEditorUpdate(engine.snapshot().revision);
  assert.equal(update.content, incoming);
});

test('reattachment rejects a changed target or stale token and retains both recovery histories', async t => {
  const { engine } = await fixture(t);
  const archived = editorCheckpoint([base]);
  await engine.checkpointEditor(archived, engine.snapshot().revision);
  const before = editorCheckpoint(['disk']);
  const proposal = await engine.prepareReattach(before, engine.snapshot().revision);
  await assert.rejects(engine.acceptReattach(proposal.token, editorCheckpoint(['wrong'])), { code: 'STALE_EDITOR' });
  assert.deepEqual(engine.snapshot().editor.recovery.before, before);
  await assert.rejects(engine.acceptReattach('wrong', archived), { code: 'STALE_EDITOR' });
  await engine.acceptReattach(proposal.token, archived);
  await assert.rejects(engine.acceptReattach(proposal.token, archived), { code: 'STALE_EDITOR' });
});


test('an explicitly retried restoration retains the earlier interrupted proposal across restart', async t => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const first = await engine.prepareReattach(editorCheckpoint(['first reopening']), engine.snapshot().revision);
  const reopened = await DocumentEngine.open(store, 'doc');
  const second = await reopened.prepareReattach(editorCheckpoint(['second reopening']), reopened.snapshot().revision);
  assert.deepEqual(reopened.snapshot().recovery.editor.before, editorCheckpoint(['first reopening']));
  assert.deepEqual(reopened.snapshot().editor.recovery.before, editorCheckpoint(['second reopening']));
  await assert.rejects(reopened.acceptReattach(first.token, first.checkpoint), { code: 'STALE_EDITOR' });
  await reopened.acceptReattach(second.token, second.checkpoint);
  assert.equal(reopened.snapshot().buffer, base);
});


test('a newer editor observation invalidates an unconfirmed restoration token', async t => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const proposal = await engine.prepareReattach(editorCheckpoint(['disk']), engine.snapshot().revision);
  const newer = editorCheckpoint([base, 'new local edits']);
  await engine.checkpointEditor(newer, engine.snapshot().revision);
  await assert.rejects(engine.acceptReattach(proposal.token, proposal.checkpoint), { code: 'STALE_EDITOR' });
  assert.deepEqual(engine.snapshot().editor.checkpoint, newer);
  assert.deepEqual(engine.snapshot().recovery.editor.before, editorCheckpoint(['disk']));
});

test('reviewed history conflict choices create a durable whole-tree proposal without publishing unsaved text', async t => {
  const { engine, store } = await fixture(t);
  const checkpoint = editorCheckpoint([base.replace('conclusion', 'OLD conclusion'), base]);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  const target = base.replace('conclusion', 'THEIR conclusion');
  await engine.receiveRemote({ content: target, version: 2 });
  await engine.prepareEditorUpdate(engine.snapshot().revision);
  const revision = engine.snapshot().revision;
  const unresolved = await engine.prepareHistoryResolution({}, revision);
  assert.equal(unresolved.status, 'conflict');
  assert.equal(unresolved.seq, 0);
  assert.equal(engine.snapshot().revision, revision);
  const resolved = base.replace('conclusion', 'OLD with THEIR conclusion');
  const proposal = await engine.prepareHistoryResolution({ 0: resolved }, revision);
  assert.equal(proposal.status, 'ready');
  assert.deepEqual(engine.snapshot().editor.checkpoint, checkpoint);
  const durable = (await store.read('doc')).state.editor.pending;
  assert.deepEqual(durable.resolutions, { 0: resolved });
  await engine.acceptEditorUpdate(proposal.token, { ...checkpoint, history: proposal.history });
  assert.equal(engine.snapshot().editor.held, null);
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[0].content, resolved);
  assert.equal(engine.snapshot().saved, target);
  assert.equal(await engine.prepareUpload(), null);
});

test('history resolution refuses stale reviews and cannot bypass document conflicts or uncertainty', async t => {
  const { engine } = await fixture(t);
  const checkpoint = editorCheckpoint([base.replace('conclusion', 'OLD conclusion'), base]);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR conclusion'), version: 2 });
  await engine.prepareEditorUpdate(engine.snapshot().revision);
  const revision = engine.snapshot().revision;
  await engine.receiveRemote({ content: base.replace('conclusion', 'NEW THEIR conclusion'), version: 3 });
  await assert.rejects(engine.prepareHistoryResolution({ 0: 'choice' }, revision), { code: 'STALE_REVISION' });
  const changed = editorCheckpoint([base.replace('conclusion', 'OLD conclusion'), base.replace('conclusion', 'MY conclusion')]);
  await saveEditor(engine, changed, engine.snapshot().revision);
  assert.ok(engine.snapshot().conflict);
  const before = engine.snapshot();
  await assert.rejects(engine.prepareHistoryResolution({ 0: 'choice' }, before.revision), { code: 'DOCUMENT_CONFLICT' });
  assert.deepEqual(engine.snapshot(), before);
});

test('document resolution keeps saved and unsaved text separate and verifies the entire native history before acceptance', async t => {
  const { engine, store } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const local = base.replace('introduction', 'MY introduction');
  await saveEditor(engine, editorCheckpoint([base, local]), engine.snapshot().revision);
  const unsaved = local.replace('conclusion', 'UNSAVED conclusion');
  const captured = editorCheckpoint([base, local, unsaved]);
  await engine.checkpointEditor(captured, engine.snapshot().revision);
  const remote = base.replace('introduction', 'THEIR introduction');
  await engine.receiveRemote({ content: remote, version: 2 });
  const conflict = engine.snapshot().conflict;
  const review = await engine.prepareConflictResolution(conflict.id, {}, engine.snapshot().revision);
  assert.equal(review.stage, 'saved');
  assert.equal(review.inputs.local, local);
  assert.equal(review.inputs.remote, remote);
  assert.equal(engine.snapshot().saved, local);
  const saved = base.replace('introduction', 'RESOLVED introduction');
  const historical = await engine.prepareConflictResolution(conflict.id, { saved }, engine.snapshot().revision);
  assert.equal(historical.stage, 'history');
  assert.equal(historical.seq, 0);
  assert.equal((await store.read('doc')).state.editor.conflictReview.choices.saved, saved);
  assert.deepEqual(engine.snapshot().editor.checkpoint, captured);
  const proposal = await engine.prepareConflictResolution(conflict.id, { saved, history: { 0: remote } }, engine.snapshot().revision);
  assert.equal(proposal.status, 'ready');
  assert.equal(proposal.content, saved.replace('conclusion', 'UNSAVED conclusion'));
  assert.equal(engine.snapshot().saved, local, 'reviewing a candidate must not publish it');
  await engine.acceptEditorUpdate(proposal.token, { ...captured, history: proposal.history });
  assert.equal(engine.snapshot().conflict, null);
  assert.equal(engine.snapshot().saved, saved);
  assert.equal(engine.snapshot().buffer, proposal.content);
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes[0].content, remote);
  assert.equal(engine.snapshot().recovery.conflict.conflict.id, conflict.id);
  assert.equal((await engine.prepareUpload()).content, saved);
});

test('document resolution requests an explicit dirty-buffer choice when saved resolution overlaps unsaved text', async t => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const local = base.replace('introduction', 'LOCAL');
  await saveEditor(engine, editorCheckpoint([base, local]), engine.snapshot().revision);
  const current = base.replace('introduction', 'UNSAVED LOCAL');
  await engine.checkpointEditor(editorCheckpoint([base, local, current]), engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('introduction', 'REMOTE'), version: 2 });
  const id = engine.snapshot().conflict.id;
  const saved = base.replace('introduction', 'RESOLVED');
  const proposal = await engine.prepareConflictResolution(id, { saved }, engine.snapshot().revision);
  assert.equal(proposal.stage, 'buffer');
  assert.equal(proposal.inputs.local, current);
  assert.equal(proposal.inputs.remote, saved);
  assert.equal(engine.snapshot().saved, local);
  assert.equal(engine.snapshot().editor.checkpoint.history.nodes.at(-1).content, current);
});

test('document resolution rejects stale remote revisions after preparation and retains the unresolved originals', async t => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const local = base.replace('introduction', 'LOCAL');
  await saveEditor(engine, editorCheckpoint([base, local]), engine.snapshot().revision);
  const remote = base.replace('introduction', 'REMOTE');
  await engine.receiveRemote({ content: remote, version: 2 });
  const id = engine.snapshot().conflict.id;
  const proposal = await engine.prepareConflictResolution(id, { saved: remote, history: { 0: remote } }, engine.snapshot().revision);
  assert.equal(proposal.status, 'ready');
  await engine.receiveRemote({ content: remote + 'NEWER', version: 3 });
  const before = engine.snapshot();
  await assert.rejects(engine.acceptEditorUpdate(proposal.token, { ...before.editor.checkpoint, history: proposal.history }), { code: 'STALE_CONFLICT' });
  assert.deepEqual(engine.snapshot(), before);
  await assert.rejects(engine.prepareConflictResolution(id, { saved: '<<<<<<< LOCAL' }, before.revision), { code: 'INVALID_RESOLUTION' });
});

test('native conflict resolution cannot retire an unconfirmed submission', async t => {
  const { engine } = await fixture(t);
  await engine.checkpointEditor(editorCheckpoint([base]), engine.snapshot().revision);
  const local = base.replace('introduction', 'LOCAL');
  await saveEditor(engine, editorCheckpoint([base, local]), engine.snapshot().revision);
  const pending = await engine.prepareUpload('old-connection');
  await engine.markUncertain(pending.token);
  const before = engine.snapshot();
  await assert.rejects(engine.prepareConflictResolution(before.conflict.id, { saved: local }, before.revision), { code: 'UPLOAD_PENDING' });
  assert.deepEqual(engine.snapshot(), before);
});

test('partial native history choices survive reopening without changing the archived native tree', async t => {
  const { engine, store } = await fixture(t);
  const checkpoint = editorCheckpoint([base.replace('conclusion', 'OLD'), base, base.replace('conclusion', 'ALTERNATE')], 1);
  await engine.checkpointEditor(checkpoint, engine.snapshot().revision);
  await engine.receiveRemote({ content: base.replace('conclusion', 'THEIR'), version: 2 });
  await engine.prepareEditorUpdate(engine.snapshot().revision);
  const choices = { 0: base.replace('conclusion', 'OLD with THEIR') };
  const partial = await engine.prepareHistoryResolution(choices, engine.snapshot().revision);
  assert.equal(partial.status, 'conflict');
  assert.equal(partial.seq, 2);
  const reopened = await DocumentEngine.open(store, 'doc');
  assert.deepEqual(reopened.snapshot().editor.checkpoint, checkpoint);
  assert.deepEqual(reopened.snapshot().editor.historyReview.resolutions, choices);
  assert.equal(reopened.snapshot().editor.pending, null);
});
