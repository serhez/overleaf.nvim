'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SyncSession } = require('../../../node/sync/session');
const { SnapshotStore } = require('../../../node/sync/store');

async function fixture(t, projectId = 'project') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-session-test-')));
  const options = { root, server: 'https://example.test/', projectId };
  const session = await SyncSession.open(options);
  const sessions = [session];
  t.after(async () => {
    for (const owned of sessions) await owned.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { session, options, track: owned => { sessions.push(owned); return owned; } };
}

test('isolates recovery by server/project identity and keeps display names out of paths', async t => {
  const { session, options, track } = await fixture(t, '../../outside');
  const other = track(await SyncSession.open({ ...options, server: 'https://other.test' }));
  assert.notEqual(session.directory, other.directory);
  assert.equal(path.dirname(session.directory), options.root);
  await assert.rejects(SyncSession.open({ ...options, server: 'https://example.test' }), { code: 'WORKSPACE_BUSY' });
  const a = await session.document({ document: 'doc', action: 'open', initial: { content: 'a', version: 1 } });
  const b = await other.document({ document: 'doc', action: 'open', initial: { content: 'b', version: 1 } });
  assert.equal(a.session, session.id);
  assert.equal(a.document, 'doc');
  assert.equal(a.state.buffer, 'a');
  assert.equal(b.state.buffer, 'b');
});

test('project lock review is read-only, scoped by identity, and refuses an active session', async t => {
  const { session, options } = await fixture(t);
  const review = await SyncSession.inspectLocks(options);
  assert.equal(review.directory, session.directory);
  assert.equal(review.locks.length, 1);
  assert.equal(review.locks[0].label, 'project');
  assert.equal(review.locks[0].inspection.state, 'active');
  await assert.rejects(SyncSession.recoverLocks(review), { code: 'WRITER_ACTIVE' });
  const other = await SyncSession.inspectLocks({ ...options, projectId: 'not-opened' });
  assert.deepEqual(other.locks, []);
  await assert.rejects(fs.stat(other.directory), { code: 'ENOENT' });
});

test('project metadata persists identity and a cached tree for offline reopening', async t => {
  const { session, options, track } = await fixture(t);
  const project = { name: 'Paper', tree: [{ id: 'doc', path: 'chapters/main.tex', type: 'doc' }],
    data: { rootDoc_id: 'doc' } };
  await session.project(project);
  project.tree[0].path = 'mutated.tex';
  assert.equal((await session.describe()).project.tree[0].path, 'chapters/main.tex');
  await session.close();
  const reopened = track(await SyncSession.open(options));
  assert.deepEqual(await reopened.project(), { name: 'Paper', tree: [{ id: 'doc', path: 'chapters/main.tex', type: 'doc' }],
    data: { rootDoc_id: 'doc' } });
  await assert.rejects(reopened.project({ name: 'invalid', tree: [{ id: 'doc', path: '../outside', type: 'doc' }] }));
  assert.equal((await reopened.project()).name, 'Paper');
});

test('cached project discovery is scoped to the server and does not require taking a writer lock', async t => {
  const { session, options, track } = await fixture(t);
  await session.project({ name: 'Paper', tree: [] });
  const other = track(await SyncSession.open({ ...options, projectId: 'other', server: 'https://other.test' }));
  await other.project({ name: 'Other server', tree: [] });
  assert.deepEqual(await SyncSession.listProjects({ root: options.root, server: options.server }), [
    { projectId: 'project', server: 'https://example.test', name: 'Paper', sourceRoot: null },
  ]);
  assert.equal((await SnapshotStore.inspectLock(session.directory)).state, 'active');
  assert.deepEqual(await SyncSession.listProjects({ root: path.join(options.root, 'missing'), server: options.server }), []);
  await assert.rejects(fs.stat(path.join(options.root, 'missing')), { code: 'ENOENT' });
});

test('failed project metadata loading releases both project and source owners', async t => {
  const { session, options, track } = await fixture(t);
  await session.close();
  const sourceRoot = path.join(options.root, 'sources');
  await fs.mkdir(sourceRoot);
  const read = SnapshotStore.prototype.read;
  const injected = t.mock.method(SnapshotStore.prototype, 'read', async function(key) {
    if (key === JSON.stringify(['project'])) throw Object.assign(new Error('fixture read failure'), { code: 'EIO' });
    return read.call(this, key);
  });
  await assert.rejects(SyncSession.open({ ...options, sourceRoot }), { code: 'EIO' });
  injected.mock.restore();
  const reopened = track(await SyncSession.open({ ...options, sourceRoot }));
  assert.equal((await reopened.describe()).sourceRoot, sourceRoot);
});

test('explicit project recovery releases both dead writers while retaining source and document state', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-project-recovery-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { root: path.join(directory, 'recovery'), sourceRoot: path.join(directory, 'source'),
    server: 'https://example.test', projectId: 'project' };
  await fs.mkdir(options.sourceRoot);
  await promisify(execFile)(process.execPath, ['-e', `
    const { SyncSession } = require(process.argv[1]);
    SyncSession.open(JSON.parse(process.argv[2])).then(async session => {
      await session.document({ action: 'open', document: 'doc', path: 'main.tex', initial: { content: 'retained source', version: 1 } });
      process.exit(0);
    });`, require.resolve('../../../node/sync/session'), JSON.stringify(options)]);
  const review = await SyncSession.inspectLocks(options);
  assert.deepEqual(review.locks.map(lock => lock.label), ['project', 'workspace']);
  assert.ok(review.locks.every(lock => lock.inspection.state === 'stale'));
  await assert.rejects(SyncSession.open(options), { code: 'WORKSPACE_BUSY' });
  const result = await SyncSession.recoverLocks(review);
  assert.equal(result.retained.length, 2);
  const reopened = await SyncSession.open(options);
  try {
    const doc = await reopened.document({ action: 'open', document: 'doc', path: 'main.tex' });
    assert.equal(doc.state.saved, 'retained source');
    assert.equal(await fs.readFile(path.join(options.sourceRoot, 'main.tex'), 'utf8'), 'retained source');
  } finally { await reopened.close(); }
});

test('project recovery checks every owner before releasing the first stale lock', async t => {
  const { session, options } = await fixture(t);
  await session.close();
  await promisify(execFile)(process.execPath, ['-e', `
    require(process.argv[1]).SnapshotStore.open(process.argv[2]).then(() => process.exit(0));
  `, require.resolve('../../../node/sync/store'), session.directory]);
  const workspace = await SnapshotStore.open(path.join(session.directory, 'workspace'));
  try {
    const review = await SyncSession.inspectLocks(options);
    assert.deepEqual(review.locks.map(lock => lock.inspection.state), ['stale', 'active']);
    await assert.rejects(SyncSession.recoverLocks(review), { code: 'WRITER_ACTIVE' });
    assert.equal((await SnapshotStore.inspectLock(session.directory)).state, 'stale');
    await workspace.write('owned', { saved: 'still active' }, 0);
  } finally { await workspace.close(); }
});

test('serializes each document including opening it and rejects duplicate opens', async t => {
  const { session } = await fixture(t);
  const opening = session.document({ document: 'doc', action: 'open', initial: { content: 'a', version: 1 } });
  const incoming = session.document({ document: 'doc', action: 'remote', remote: { content: 'b', version: 2 } });
  await opening;
  const reply = await incoming;
  assert.equal(reply.state.buffer, 'b');
  await assert.rejects(session.document({ document: 'doc', action: 'open' }), { code: 'DOCUMENT_OPEN' });
  await assert.rejects(session.document({ document: 'unknown', action: 'state' }), { code: 'DOCUMENT_NOT_OPEN' });
  await assert.rejects(session.document({ document: 'doc', action: 'constructor' }), { code: 'UNKNOWN_ACTION' });
});

test('project description lists durable source bindings without fetching or rewriting their contents', async t => {
  const { options, track } = await fixture(t);
  const sourceRoot = path.join(options.root, 'sources');
  await fs.mkdir(sourceRoot);
  const session = track(await SyncSession.open({ ...options, projectId: 'workspace', sourceRoot }));
  await session.document({ action: 'open', document: 'doc', path: 'chapters/main.tex', initial: { content: 'saved source', version: 1 } });
  await session.close();
  const filename = path.join(sourceRoot, 'chapters/main.tex');
  await fs.writeFile(filename, 'independent external edit');
  const reopened = track(await SyncSession.open({ ...options, projectId: 'workspace', sourceRoot }));
  const description = await reopened.describe();
  assert.equal(description.sourceRoot, sourceRoot);
  assert.deepEqual(description.sources, [{ document: 'doc', path: 'chapters/main.tex' }]);
  assert.equal(await fs.readFile(filename, 'utf8'), 'independent external edit');
});

test('closing drains accepted document work before releasing writer ownership', async t => {
  const { session, options, track } = await fixture(t);
  const opening = session.document({ document: 'doc', action: 'open', initial: { content: 'a', version: 1 } });
  const incoming = session.document({ document: 'doc', action: 'remote', remote: { content: 'b', version: 2 } });
  const closing = session.close();
  await assert.rejects(session.document({ document: 'doc', action: 'state' }), { code: 'SESSION_CLOSED' });
  await Promise.all([opening, incoming, closing]);
  const reopened = track(await SyncSession.open(options));
  assert.notEqual(reopened.id, session.id);
  const reply = await reopened.document({ document: 'doc', action: 'open' });
  assert.equal(reply.state.buffer, 'b');
  assert.equal(reply.state.remoteVersion, 2);
});

test('rejects stale revisions while continuing later valid requests', async t => {
  const { session } = await fixture(t);
  const opened = await session.document({ document: 'doc', action: 'open', initial: { content: 'a', version: 1 } });
  await session.document({ document: 'doc', action: 'remote', remote: { content: 'b', version: 2 } });
  await assert.rejects(session.document({ document: 'doc', action: 'prepare', revision: opened.revision }), { code: 'STALE_REVISION' });
  const state = await session.document({ document: 'doc', action: 'state' });
  assert.equal(state.state.buffer, 'b');
  assert.equal(state.result, null);
});

test('captures queued inputs before callers can mutate them', async t => {
  const { session } = await fixture(t);
  const params = { document: 'doc', action: 'open', initial: { content: 'original', version: 1 } };
  const pending = session.document(params);
  params.initial.content = 'mutated';
  assert.equal((await pending).state.buffer, 'original');
});

test('save RPC validates exact base64 bytes and rejects malformed UTF-8 without changing state', async t => {
  const { session } = await fixture(t);
  const open = await session.document({ document: 'doc', action: 'open', initial: { content: 'é😀', version: 1 } });
  const checkpoint = {
    history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content: 'é😀', empty: false }] },
    tree: { seq_cur: 0, seq_last: 0 }, undo: null,
    options: { endofline: false, fixendofline: true, fileformat: 'unix', fileencoding: '', binary: false, bomb: false, undolevels: 1000 },
  };
  const attached = await session.document({ document: 'doc', action: 'checkpoint', checkpoint, revision: open.revision });
  const params = { document: 'doc', action: 'save', checkpoint, revision: attached.revision };
  for (const bytes of [undefined, '!invalid!', '/w==']) {
    await assert.rejects(session.document({ ...params, bytes }));
    assert.deepEqual((await session.document({ document: 'doc', action: 'state' })).state, attached.state);
  }
  const saved = await session.document({ ...params, bytes: Buffer.from('é😀\n').toString('base64') });
  assert.equal(saved.state.saved, 'é😀\n');
  assert.equal(saved.state.buffer, 'é😀');
});

function connection(options, content = 'base', version = 1) {
  const listeners = new Map();
  const sent = [];
  return {
    projectId: options.projectId, server: options.server.replace(/\/+$/, ''),
    connected: true, publicId: 'connection-1', listeners, sent,
    observeDocument(id, handlers) { listeners.set(id, handlers); return () => listeners.delete(id); },
    async joinDoc() { return { lines: content.split('\n'), version, updates: [] }; },
    sendUpdate(update) { sent.push(update); return new Promise(() => {}); },
  };
}

async function saveText(session, document, text) {
  const checkpoint = {
    history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content: text, empty: false }] },
    tree: { seq_cur: 0, seq_last: 0 }, undo: null,
    options: { endofline: false, fixendofline: false, fileformat: 'unix', fileencoding: '', binary: false, bomb: false, undolevels: 1000 },
  };
  let state = await session.document({ document, action: 'state' });
  if (!state.state.editorAttached) {
    const initial = structuredClone(checkpoint);
    initial.history.nodes[0].content = state.state.buffer;
    state = await session.document({ document, action: 'checkpoint', checkpoint: initial, revision: state.revision });
  }
  return session.document({ document, action: 'save', checkpoint, revision: state.revision, bytes: Buffer.from(text).toString('base64') });
}

test('session transport publishes saved revisions and drains applied events through the document queue', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const socket = connection(options);
  await session.connectDocument('doc', socket);
  await saveText(session, 'doc', 'saved base');
  await session.transportIdle('doc');
  assert.equal(socket.sent.length, 1);
  let state = await session.document({ document: 'doc', action: 'state' });
  assert.equal(state.state.transport.state, 'uploading');
  assert.equal(state.state.remoteVersion, 1);
  await socket.listeners.get('doc').applied({ doc: 'doc', v: 1 });
  state = await session.document({ document: 'doc', action: 'snapshot' });
  assert.equal(state.result.pending, null);
  assert.equal(state.result.remote.content, 'saved base');
  assert.equal(state.state.transport.state, 'idle');
});

test('a stalled document join never blocks local saves or project closure; its late result is ignored', async t => {
  const { session, options, track } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const socket = connection(options);
  let finishJoin, started;
  const beginning = new Promise(resolve => { started = resolve; });
  socket.joinDoc = () => { started(); return new Promise(resolve => { finishJoin = resolve; }); };
  const joining = session.connectDocument('doc', socket);
  await beginning;
  const observer = socket.listeners.get('doc');
  await saveText(session, 'doc', 'saved offline');
  await session.close();
  assert.equal(socket.listeners.size, 0);
  finishJoin({ lines: ['obsolete'], version: 2, updates: [] });
  await joining;
  await observer.applied({ doc: 'doc', v: 2, op: [{ p: 0, i: 'obsolete' }] });
  const reopened = track(await SyncSession.open(options));
  const reply = await reopened.document({ document: 'doc', action: 'open' });
  assert.equal(reply.state.saved, 'saved offline');
  assert.equal(reply.state.remoteVersion, 1);
  assert.equal(socket.sent.length, 0);
});

test('replacing a connection rejects old events and retains unacknowledged saves across close', async t => {
  const { session, options, track } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const first = connection(options);
  await session.connectDocument('doc', first);
  await saveText(session, 'doc', 'saved base');
  await session.transportIdle('doc');
  const old = first.listeners.get('doc');
  const second = connection(options);
  second.publicId = 'connection-2';
  await session.connectDocument('doc', second);
  await old.applied({ doc: 'doc', v: 1 });
  let state = await session.document({ document: 'doc', action: 'snapshot' });
  assert.equal(state.result.pending.source, 'connection-1');
  assert.equal(state.result.pending.status, 'uncertain');
  assert.equal(second.sent.length, 0);
  await session.close();
  const reopened = track(await SyncSession.open(options));
  await reopened.document({ document: 'doc', action: 'open' });
  state = await reopened.document({ document: 'doc', action: 'snapshot' });
  assert.equal(state.result.saved, 'saved base');
  assert.equal(state.result.pending.status, 'uncertain');
});

test('explicit unknown-outcome review retires no intent until a fresh drained snapshot and preserves every branch', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const first = connection(options);
  first.sendUpdate = async update => { first.sent.push(update); };
  await session.connectDocument('doc', first);
  await saveText(session, 'doc', 'saved base'); await session.transportIdle('doc');
  const socket = connection(options, 'saved base', 10); socket.publicId = 'new-connection';
  socket.joinDoc = async () => ({ lines: ['saved base'], version: 10, updates: [], queueDrained: true });
  await session.connectDocument('doc', socket);
  const before = (await session.document({ document: 'doc', action: 'snapshot' })).result;
  const review = await session.reviewUpload({ document: 'doc' });
  assert.equal(review.canRetire, true);
  assert.equal(review.pending.token, before.pending.token);
  assert.equal(socket.sent.length, 0);
  const accepted = await session.reviewUpload({ document: 'doc', review, accept: true });
  assert.equal(accepted.status, 'review-required');
  const after = (await session.document({ document: 'doc', action: 'snapshot' })).result;
  assert.equal(after.pending, null);
  assert.equal(after.conflict.kind, 'remote');
  assert.equal(after.conflict.inputs.base, null);
  assert.equal(after.saved, before.saved);
  assert.equal(after.buffer, before.buffer);
  assert.deepEqual(after.editor.checkpoint, before.editor.checkpoint);
  assert.equal(after.recovery.uploadDecision.pending.token, before.pending.token);
  assert.equal(socket.sent.length, 0, 'retiring uncertainty does not resend or accept text');
});

test('unknown-outcome decisions reject a newer remote head and servers without a drained-queue contract', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const first = connection(options);
  first.sendUpdate = async update => { first.sent.push(update); };
  await session.connectDocument('doc', first);
  await saveText(session, 'doc', 'saved base'); await session.transportIdle('doc');
  const socket = connection(options); socket.publicId = 'new-connection';
  let version = 10, drained = true;
  socket.joinDoc = async () => ({ lines: ['peer base'], version, updates: [], queueDrained: drained });
  await session.connectDocument('doc', socket);
  let review = await session.reviewUpload({ document: 'doc' });
  version++;
  await assert.rejects(session.reviewUpload({ document: 'doc', review, accept: true }), { code: 'STALE_UPLOAD_REVIEW' });
  assert.ok((await session.document({ document: 'doc', action: 'snapshot' })).result.pending);
  drained = false;
  review = await session.reviewUpload({ document: 'doc' });
  assert.equal(review.canRetire, false);
  await assert.rejects(session.reviewUpload({ document: 'doc', review, accept: true }), { code: 'QUEUE_NOT_DRAINED' });
  assert.ok((await session.document({ document: 'doc', action: 'snapshot' })).result.pending);
  assert.equal(socket.sent.length, 0);
});

test('a drained snapshot without the original queue receipt cannot retire an uncertain submission', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  await session.connectDocument('doc', connection(options));
  await saveText(session, 'doc', 'saved base'); await session.transportIdle('doc');
  const socket = connection(options); socket.publicId = 'new-connection';
  socket.joinDoc = async () => ({ lines: ['base'], version: 10, updates: [], queueDrained: true });
  await session.connectDocument('doc', socket);
  const review = await session.reviewUpload({ document: 'doc' });
  assert.equal(review.canRetire, false);
  await assert.rejects(session.reviewUpload({ document: 'doc', review, accept: true }), { code: 'QUEUE_NOT_DRAINED' });
  assert.ok((await session.document({ document: 'doc', action: 'snapshot' })).result.pending);
  assert.equal(socket.sent.length, 0);
});

test('transport identity checks refuse another server, project, or unconnected socket before joining', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  for (const mismatch of [{ projectId: 'other' }, { server: 'https://other.test' }, { connected: false }, { publicId: undefined }]) {
    const socket = Object.assign(connection(options), mismatch);
    await assert.rejects(session.connectDocument('doc', socket), { code: 'CONNECTION_MISMATCH' });
    assert.equal(socket.listeners.size, 0);
    assert.equal(socket.sent.length, 0);
  }
});

test('events received while joining are replayed after the snapshot and manual remote injection is excluded', async t => {
  const { session, options } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  const socket = connection(options);
  socket.joinDoc = async () => {
    await socket.listeners.get('doc').applied({ doc: 'doc', v: 1, op: [{ p: 0, i: 'peer ' }] });
    return { lines: ['base'], version: 1, updates: [] };
  };
  await session.connectDocument('doc', socket);
  const reply = await session.document({ document: 'doc', action: 'state' });
  assert.equal(reply.state.saved, 'peer base');
  await assert.rejects(session.document({ document: 'doc', action: 'remote', remote: { content: 'fake', version: 3 } }), { code: 'TRANSPORT_OWNED' });
});

test('closing during connection replacement drains the retiring upload before releasing the store', async t => {
  const { session, options, track } = await fixture(t);
  await session.document({ document: 'doc', action: 'open', initial: { content: 'base', version: 1 } });
  await session.connectDocument('doc', connection(options));
  await saveText(session, 'doc', 'saved base');
  await session.transportIdle('doc');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = session._store.write.bind(session._store);
  const mock = t.mock.method(session._store, 'write', async (...args) => {
    if (args[1].pending?.status === 'uncertain') { entered(); await gate; }
    return write(...args);
  });
  const replacement = session.connectDocument('doc', connection(options));
  await started;
  let closed = false;
  const closing = session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await Promise.all([replacement, closing]);
  mock.mock.restore();
  const reopened = track(await SyncSession.open(options));
  await reopened.document({ document: 'doc', action: 'open' });
  const state = await reopened.document({ document: 'doc', action: 'snapshot' });
  assert.equal(state.result.pending.status, 'uncertain');
  assert.equal(state.result.saved, 'saved base');
});
