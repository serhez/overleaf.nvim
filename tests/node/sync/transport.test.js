'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SnapshotStore } = require('../../../node/sync/store');
const { DocumentEngine } = require('../../../node/sync/engine');
const { DocumentTransport } = require('../../../node/sync/transport');
const { apply } = require('../../../node/sync/ot');

const base = 'intro\nseparator\nending';
async function fixture(t, initial = base) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-transport-'));
  const store = await SnapshotStore.open(directory);
  const engine = await DocumentEngine.open(store, 'doc', { content: initial, version: 3 });
  const sent = [], changes = [], queued = [];
  const transport = new DocumentTransport(engine, {
    document: 'doc', source: 'connection-one',
    send(update) {
      sent.push(structuredClone(update));
      return new Promise((resolve, reject) => queued.push({ resolve, reject }));
    },
    onChange: state => changes.push(state),
  });
  await transport.join({ content: initial, version: 3 });
  const transports = [transport];
  t.after(async () => { for (const owned of transports) await owned.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const save = async text => { await engine.edit(text, engine.snapshot().revision); await engine.save(text, engine.snapshot().revision); };
  return { engine, transport, sent, queued, changes, store, save, track: owned => { transports.push(owned); return owned; } };
}

test('joined comment ranges follow peer edits and acknowledged saves without becoming local undo edits', async t => {
  const { engine, transport, save, store } = await fixture(t, 'é😀 abc');
  await transport.join({ content: 'é😀 abc', version: 3, ranges: {
    comments: [{ id: 'thread', op: { p: 4, c: 'abc', t: 'thread' } }],
  } });
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: 4, i: 'prefix ' }], meta: { source: 'peer' } });
  assert.deepEqual(engine.snapshot().remote.comments, [{ id: 'thread', op: { p: 11, c: 'abc', t: 'thread' } }]);
  await save('LOCAL é😀 prefix abc');
  await engine.edit('UNSAVED LOCAL é😀 prefix abc', engine.snapshot().revision);
  await transport.publish();
  await transport.receive({ doc: 'doc', v: 4 });
  assert.deepEqual(engine.snapshot().remote.comments, [{ id: 'thread', op: { p: 17, c: 'abc', t: 'thread' } }]);
  const history = engine.snapshot().history;
  await transport.receive({ doc: 'doc', v: 5, op: [{ p: 6, c: 'é😀', t: 'second' }], meta: { source: 'peer' } });
  assert.deepEqual(engine.snapshot().history, history);
  assert.equal(engine.snapshot().buffer, 'UNSAVED LOCAL é😀 prefix abc');
  assert.equal(engine.snapshot().remote.comments[1].op.c, 'é😀');
  assert.deepEqual((await store.read('doc')).state.remote.comments, engine.snapshot().remote.comments);
});

test('malformed joined comment ranges cannot replace the previous remote snapshot', async t => {
  const { engine, transport } = await fixture(t);
  const before = engine.snapshot();
  await assert.rejects(transport.join({ content: 'different', version: 4, ranges: {
    comments: [{ id: 'thread', op: { p: 100, c: 'bad', t: 'thread' } }],
  } }), { code: 'INVALID_RANGES' });
  assert.deepEqual(engine.snapshot(), before);
});

test('comment drafts publish only their anchor after HTTP confirmation and survive peer edits and queued callbacks', async t => {
  const { engine, transport, sent, queued, store } = await fixture(t, 'é😀 abc');
  const draft = await engine.stageComment({ thread: 'thread', message: 'Review', view: 'UNSAVED é😀 abc',
    start: { row: 0, col: 15 }, end: { row: 0, col: 18 } });
  assert.equal((await store.read('doc')).state.comments[0].message, 'Review');
  await transport.publish();
  assert.equal(sent.length, 0);
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: 4, i: 'peer ' }] });
  await engine.edit('UNSAVED é😀 peer abc', engine.snapshot().revision);
  await engine.confirmComment(draft.token);
  await transport.publish();
  assert.deepEqual(sent[0].op, [{ p: 9, c: 'abc', t: 'thread' }]);
  assert.equal(apply('é😀 peer abc', sent[0].op), 'é😀 peer abc');
  queued[0].resolve(); await transport.idle();
  assert.equal(engine.snapshot().comments.length, 1);
  await transport.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().comments.length, 0);
  assert.equal(engine.snapshot().remote.comments[0].op.p, 9);
  assert.equal(engine.snapshot().buffer, 'UNSAVED é😀 peer abc');
});

test('comments cannot anchor unsaved selected text or bypass a conflict', async t => {
  const { engine } = await fixture(t, 'abc');
  await assert.rejects(engine.stageComment({ thread: 'thread', message: 'Review', view: 'NEW abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } }), { code: 'UNPUBLISHED_SELECTION' });
  assert.equal(engine.snapshot().comments?.length ?? 0, 0);
  await engine.stageComment({ thread: 'thread', message: 'Review', view: 'abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } });
  await assert.rejects(engine.stageComment({ thread: 'thread', message: 'Duplicate', view: 'abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } }), { code: 'COMMENT_EXISTS' });
});

test('comment uploads share the saved-text slot and are recovered by exact applied history', async t => {
  const { engine, transport, sent, save, track } = await fixture(t, 'abc');
  const draft = await engine.stageComment({ thread: 'thread', message: 'Review', view: 'abc',
    start: { row: 0, col: 1 }, end: { row: 0, col: 3 } });
  await engine.confirmComment(draft.token);
  await save('SAVED abc');
  await engine.edit('UNSAVED SAVED abc', engine.snapshot().revision);
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal(apply('abc', sent[0].op), 'SAVED abc');
  assert.deepEqual(sent[0].op.at(-1), { p: 7, c: 'bc', t: 'thread' });
  await transport.close();
  const reconnect = track(new DocumentTransport(engine, { document: 'doc', source: 'two', send: () => { throw Error('No retry'); } }));
  await reconnect.join({ content: 'SAVED abc', version: 4, ranges: {
    comments: [{ id: 'thread', op: { p: 7, c: 'bc', t: 'thread' } }],
  }, updates: [{ v: 3, op: sent[0].op, meta: { source: 'connection-one' } }] });
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().comments.length, 0);
  assert.equal(engine.snapshot().buffer, 'UNSAVED SAVED abc');
});

test('a rejoin without exact operations holds an unsent comment anchor for explicit re-selection', async t => {
  const { engine, transport, sent } = await fixture(t, 'abc');
  const draft = await engine.stageComment({ thread: 'thread', message: 'Review', view: 'abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } });
  await transport.join({ content: 'peer abc', version: 4 });
  await engine.confirmComment(draft.token);
  await transport.publish();
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().comments[0].held, 'anchor-changed');
  assert.equal(engine.snapshot().comments[0].message, 'Review');
  await engine.reanchorComment(draft.token, { view: 'peer abc',
    start: { row: 0, col: 5 }, end: { row: 0, col: 8 } });
  await transport.publish();
  assert.deepEqual(sent[0].op, [{ p: 5, c: 'abc', t: 'thread' }]);
  await assert.rejects(engine.reanchorComment(draft.token, { view: 'peer abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 4 } }), { code: 'UPLOAD_PENDING' });
});

test('a retained unposted comment survives an engine reopen without being published', async t => {
  const { engine, transport, store } = await fixture(t, 'abc');
  const draft = await engine.stageComment({ thread: 'thread', message: 'Retained message', view: 'abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } });
  await transport.close();
  const reopened = await DocumentEngine.open(store, 'doc');
  assert.deepEqual(reopened.snapshot().comments[0], draft);
  assert.equal(await reopened.prepareUpload('new-connection'), null);
});

test('a proven unapplied comment is retried once with its transformed anchor and a new source', async t => {
  const { engine, transport, queued, track } = await fixture(t, 'abc');
  const draft = await engine.stageComment({ thread: 'thread', message: 'Review', view: 'abc',
    start: { row: 0, col: 0 }, end: { row: 0, col: 3 } });
  await engine.confirmComment(draft.token); await transport.publish();
  queued[0].resolve(); await transport.idle(); await transport.close();
  const sent = [];
  const reconnect = track(new DocumentTransport(engine, { document: 'doc', source: 'new-source', send: update => sent.push(update) }));
  await reconnect.join({ content: 'peer abc', version: 4, queueDrained: true,
    updates: [{ v: 3, op: [{ p: 0, i: 'peer ' }], meta: { source: 'peer' } }] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].op, [{ p: 5, c: 'abc', t: 'thread' }]);
  assert.equal(engine.snapshot().pending.source, 'new-source');
  await reconnect.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().comments.length, 0);
});

test('a queued callback cannot acknowledge an upload; only the matching applied event can', async t => {
  const { engine, transport, sent, queued, save } = await fixture(t);
  await save('SAVED ' + base);
  await engine.edit('UNSAVED ' + base, engine.snapshot().revision);
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].v, 3);
  assert.equal(apply(base, sent[0].op), 'SAVED ' + base);
  assert.equal(engine.snapshot().pending.source, 'connection-one');
  queued[0].resolve();
  await transport.idle();
  assert.equal(engine.snapshot().remote.content, base);
  assert.ok(engine.snapshot().pending);
  await transport.receive({ doc: 'doc', v: 3 });
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().remote.version, 4);
  assert.equal(engine.snapshot().remote.content, 'SAVED ' + base);
  assert.equal(engine.snapshot().buffer, 'UNSAVED ' + base);
});

test('application can precede the queue callback and cannot be undone by a late callback error', async t => {
  const { engine, transport, queued, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await transport.receive({ doc: 'doc', v: 3 });
  queued[0].reject(new Error('late connection closure'));
  await transport.idle();
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().conflict, null);
  assert.equal(engine.snapshot().remote.version, 4);
});

test('concurrent peer operations transform the submitted save before its application is acknowledged', async t => {
  const { engine, transport, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  const op = [{ p: base.indexOf('ending'), i: 'THEIR ' }];
  await transport.receive({ doc: 'doc', v: 3, op, meta: { source: 'peer' } });
  assert.equal(engine.snapshot().remote.content, base.replace('ending', 'THEIR ending'));
  assert.ok(engine.snapshot().pending);
  await transport.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().remote.content, ('SAVED ' + base).replace('ending', 'THEIR ending'));
  assert.equal(engine.snapshot().remote.version, 5);
  assert.equal(engine.snapshot().pending, null);
  assert.equal(sent.length, 1);
});

test('saves queue behind the one unacknowledged upload and old duplicate ACKs cannot acknowledge the next', async t => {
  const { engine, transport, sent, save } = await fixture(t);
  await save('FIRST ' + base);
  await transport.publish();
  await save('SECOND ' + base);
  await transport.publish();
  assert.equal(sent.length, 1);
  await transport.receive({ doc: 'doc', v: 3 });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].v, 4);
  assert.equal(apply('FIRST ' + base, sent[1].op), 'SECOND ' + base);
  const token = engine.snapshot().pending.token;
  await transport.receive({ doc: 'doc', v: 3 });
  assert.equal(engine.snapshot().pending.token, token);
  await transport.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().pending, null);
});

test('a gap or impossible acknowledgement retains the pending save as uncertain without guessing', async t => {
  const { engine, transport, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await transport.receive({ doc: 'doc', v: 5 });
  assert.equal(engine.snapshot().pending.status, 'uncertain');
  assert.equal(engine.snapshot().conflict.reason, 'uncertain-ack');
  assert.equal(engine.snapshot().remote.content, base);
  await transport.publish();
  assert.equal(sent.length, 1);
});

test('disconnect drains uncertainty persistence and ignores events from the closed connection', async t => {
  const { engine, transport, store, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await transport.close();
  const before = engine.snapshot();
  assert.equal((await store.read('doc')).state.pending.status, 'uncertain');
  await transport.receive({ doc: 'doc', v: 3 });
  await transport.publish();
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(sent.length, 1);
});

test('join reconciles buffered events at the snapshot boundary and ignores covered old versions', async t => {
  const { engine, transport } = await fixture(t);
  await transport.beginJoin();
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: 0, i: 'COVERED ' }] });
  await transport.receive({ doc: 'doc', v: 4, op: [{ p: 0, i: 'AFTER ' }] });
  await transport.join({ content: 'COVERED ' + base, version: 4 });
  assert.equal(engine.snapshot().remote.content, 'AFTER COVERED ' + base);
  assert.equal(engine.snapshot().remote.version, 5);
});

test('unrelated documents and malformed operations cannot change a joined document', async t => {
  const { engine, transport } = await fixture(t);
  const before = engine.snapshot();
  await transport.receive({ doc: 'other', v: 3, op: [{ p: 0, i: 'wrong' }] });
  assert.deepEqual(engine.snapshot(), before);
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: 0, d: 'wrong' }] });
  assert.equal(engine.snapshot().remote.content, base);
  assert.equal(transport.status().reason, 'invalid-operation');
});

test('a rejected submission is retained as uncertain and is never automatically resent', async t => {
  const { engine, transport, queued, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  queued[0].reject(new Error('queue failure'));
  await transport.idle();
  assert.equal(engine.snapshot().pending.status, 'uncertain');
  await transport.publish();
  assert.equal(sent.length, 1);
});

test('a synchronous sender failure cannot deadlock the operation queue', { timeout: 5000 }, async t => {
  const { engine, transport, save } = await fixture(t);
  transport.send = () => { throw new Error('connection already closed'); };
  await save('SAVED ' + base);
  await transport.publish();
  assert.equal(engine.snapshot().pending.status, 'uncertain');
});

test('an upload is not sent before its intent and connection identity are durably recorded', async t => {
  const { engine, transport, store, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  const write = store.write.bind(store);
  const injected = t.mock.method(store, 'write', async (...args) => {
    if (args[1].pending) throw new Error('persistence failed');
    return write(...args);
  });
  await assert.rejects(transport.publish(), /persistence failed/);
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().pending, null);
  injected.mock.restore();
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal((await store.read('doc')).state.pending.source, 'connection-one');
});

test('overflowing the join buffer holds publication until a new complete join', async t => {
  const { transport, engine, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.beginJoin();
  for (let count = 0; count < 4096; count++) await transport.receive({ doc: 'doc', v: 2, op: [] });
  await transport.receive({ doc: 'doc', v: 3, op: [] });
  await transport.join({ content: base, version: 3 });
  assert.equal(transport.status().reason, 'join-overflow');
  assert.equal(sent.length, 0);
  await transport.beginJoin();
  await transport.join({ content: base, version: 4 });
  assert.equal(engine.snapshot().remote.version, 4);
  assert.equal(sent.length, 1);
});

test('socket join decodes only encoded snapshot/range fields and rejects unsupported document types', async t => {
  const SocketManager = require('../../../node/socket');
  const manager = new SocketManager('fixture-cookie', 'project', () => {});
  const encoded = value => Buffer.from(value).toString('latin1');
  const emit = t.mock.method(manager, '_promisifiedEmit', async (name, doc, from, options) => {
    assert.deepEqual([name, doc, from, options], ['joinDoc', 'doc', -1, { encodeRanges: true }]);
    return [[encoded('é😀')], 4, [{ v: 3, op: [{ p: 0, i: '日本' }] }], {
      comments: [{ op: { c: encoded('é😀'), p: 0, t: 'thread' } }],
      changes: [{ op: { i: encoded('日本'), p: 0 } }],
    }, 'sharejs-text-ot'];
  });
  const snapshot = await manager.joinDoc('doc');
  assert.deepEqual(snapshot.lines, ['é😀']);
  assert.equal(snapshot.ranges.comments[0].op.c, 'é😀');
  assert.equal(snapshot.ranges.changes[0].op.i, '日本');
  assert.equal(snapshot.updates[0].op[0].i, '日本');
  emit.mock.restore();
  t.mock.method(manager, '_promisifiedEmit', async () => [[], 4, [], {}, 'history-ot']);
  await assert.rejects(manager.joinDoc('doc'), { code: 'UNSUPPORTED_OT' });
});

test('socket join refuses invalid encoded text and malformed ranges instead of silently replacing them', async t => {
  const SocketManager = require('../../../node/socket');
  const manager = new SocketManager('fixture-cookie', 'project', () => {});
  for (const data of [[[String.fromCharCode(255)], 1, [], {}], [['good'], 1, [], '{broken']]) {
    const mocked = t.mock.method(manager, '_promisifiedEmit', async () => data);
    await assert.rejects(manager.joinDoc('doc'), { code: 'INVALID_SNAPSHOT' });
    mocked.mock.restore();
  }
});

test('project tree and feature events ignore obsolete sockets and preserve server event arguments', () => {
  const SocketManager = require('../../../node/socket');
  const { EventEmitter } = require('node:events');
  const events = [];
  const manager = new SocketManager('fixture-cookie', 'project', (event, data) => events.push({ event, data }));
  const socket = new EventEmitter();
  socket.onevent = () => {};
  manager.socket = socket;
  manager.connected = true;
  manager._setupEventHandlers();
  socket.emit('reciveEntityRename', 'doc', 'new.tex');
  socket.emit('reciveEntityMove', 'doc', 'folder');
  socket.emit('reciveNewFolder', 'parent', { _id: 'folder', name: 'chapters' });
  socket.emit('projectNameUpdated', 'Renamed paper');
  assert.deepEqual(events, [
    { event: 'reciveEntityRename', data: { entityId: 'doc', newName: 'new.tex' } },
    { event: 'reciveEntityMove', data: { entityId: 'doc', folderId: 'folder' } },
    { event: 'reciveNewFolder', data: { parentFolderId: 'parent', folder: { _id: 'folder', name: 'chapters' } } },
    { event: 'projectNameUpdated', data: { name: 'Renamed paper' } },
  ]);
  manager.socket = null;
  for (const [name, args] of [
    ['reciveEntityRename', ['doc', 'wrong.tex']], ['reciveEntityMove', ['doc', 'other']],
    ['reciveNewDoc', ['parent', { _id: 'doc' }]], ['reciveNewFile', ['parent', { _id: 'image' }]],
    ['reciveNewFolder', ['parent', { _id: 'folder' }]], ['removeEntity', ['doc']], ['rootDocUpdated', ['doc']],
    ['projectNameUpdated', ['obsolete name']],
    ['new-comment', ['thread', {}]], ['resolve-thread', ['thread', {}]], ['reopen-thread', ['thread']],
    ['delete-thread', ['thread']], ['clientTracking.clientUpdated', [{}]], ['clientTracking.clientDisconnected', ['client']],
  ]) socket.emit(name, ...args);
  assert.equal(events.length, 4);
});

test('a real socket applied event uses the pre-increment version and confirms the saved coordinator intent', async t => {
  const SocketManager = require('../../../node/socket');
  const { createServer, getOrCreateDoc } = require('../mock-server');
  const server = await createServer(0);
  const previousUrl = process.env.OVERLEAF_URL;
  process.env.OVERLEAF_URL = `http://127.0.0.1:${server.server.address().port}`;
  const manager = new SocketManager('fixture-cookie', 'project', () => {});
  let transport, unobserve;
  t.after(async () => {
    if (unobserve) unobserve();
    if (transport) await transport.close();
    manager.disconnect();
    await server.close();
    if (previousUrl === undefined) delete process.env.OVERLEAF_URL;
    else process.env.OVERLEAF_URL = previousUrl;
  });
  const { engine, save } = await fixture(t);
  getOrCreateDoc('wire-doc', base.split('\n')).version = 3;
  const connected = await manager.connect();
  assert.equal(manager.publicId, connected.publicId);
  const failures = [];
  transport = new DocumentTransport(engine, {
    document: 'wire-doc', source: manager.publicId,
    send: update => manager.sendUpdate(update),
  });
  unobserve = manager.observeDocument('wire-doc', {
    applied: update => transport.receive(update),
    interrupted: () => transport.close(),
    failed: error => failures.push(error),
  });
  const snapshot = await manager.joinDoc('wire-doc');
  await transport.join({ content: snapshot.lines.join('\n'), version: snapshot.version });
  await save('SAVED é日本 ' + base);
  await transport.publish();
  for (let count = 0; count < 100 && engine.snapshot().pending; count++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    await transport.idle();
  }
  assert.deepEqual(failures, []);
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().remote.version, 4);
  assert.equal(engine.snapshot().remote.content, 'SAVED é日本 ' + base);
});

test('rejoin proves a lost ACK from contiguous source-tagged history while retaining newer saved edits', async t => {
  const { engine, transport, store, save, track } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await save('NEWER ' + base);
  await transport.close();
  const reopened = await DocumentEngine.open(store, 'doc');
  const sent = [];
  const next = track(new DocumentTransport(reopened, { document: 'doc', source: 'connection-two', send: update => { sent.push(update); } }));
  const peer = { doc: 'doc', v: 3, op: [{ p: base.length, i: '\nPEER' }], meta: { source: 'colleague' } };
  const own = { doc: 'doc', v: 4, op: [{ p: 0, i: 'SAVED ' }], meta: { source: 'connection-one' } };
  await next.join({ content: 'SAVED ' + base + '\nPEER', version: 5, updates: [peer, own] });
  assert.equal(reopened.snapshot().remote.version, 5);
  assert.equal(reopened.snapshot().saved, 'NEWER ' + base + '\nPEER');
  assert.equal(reopened.snapshot().conflict, null);
  assert.equal(sent.length, 1);
  assert.equal(apply(reopened.snapshot().remote.content, sent[0].op), 'NEWER ' + base + '\nPEER');
  assert.equal(reopened.snapshot().pending.source, 'connection-two');
  assert.equal((await store.read('doc')).state.recovery.upload.pending.source, 'connection-one');
});

test('matching snapshots without complete, matching source history never clear an uncertain upload', async t => {
  const { engine, transport, save } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await transport.close();
  const own = { doc: 'doc', v: 3, op: [{ p: 0, i: 'SAVED ' }], meta: { source: 'connection-one' } };
  for (const updates of [undefined, [], [{ ...own, meta: { source: 'someone-else' } }],
    [{ ...own, v: 4 }], [{ ...own, op: [{ p: 0, i: 'WRONG ' }] }], [own, own]]) {
    const sent = [];
    const next = new DocumentTransport(engine, { document: 'doc', source: 'next', send: update => sent.push(update) });
    await next.join({ content: 'SAVED ' + base, version: 4, updates });
    assert.equal(engine.snapshot().pending.source, 'connection-one');
    assert.equal(engine.snapshot().pending.status, 'uncertain');
    assert.equal(sent.length, 0);
    await next.close();
  }
});

test('recovery ACK confirmation is durable before a subsequent saved revision is sent', async t => {
  const { engine, transport, store, save, track } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  await transport.close();
  const sent = [];
  const next = track(new DocumentTransport(engine, { document: 'doc', source: 'next', send: update => sent.push(update) }));
  const write = store.write.bind(store);
  const injected = t.mock.method(store, 'write', async (...args) => {
    if (!args[1].pending) throw new Error('recovery persistence failed');
    return write(...args);
  });
  await assert.rejects(next.join({ content: 'SAVED ' + base, version: 4,
    updates: [{ v: 3, op: [{ p: 0, i: 'SAVED ' }], meta: { source: 'connection-one' } }] }), /recovery persistence failed/);
  assert.equal(engine.snapshot().pending.source, 'connection-one');
  assert.equal(sent.length, 0);
  injected.mock.restore();
});

test('closing while upload intent persistence is delayed prevents a later network send', async t => {
  const { engine, transport, store, sent, save } = await fixture(t);
  await save('SAVED ' + base);
  const write = store.write.bind(store);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(store, 'write', async (...args) => {
    if (args[1].pending?.status === 'unacknowledged') { entered(); await gate; }
    return write(...args);
  });
  const publishing = transport.publish();
  await started;
  const closing = transport.close();
  release();
  await Promise.all([publishing, closing]);
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().pending.status, 'uncertain');
});

test('socket document ownership cannot be released twice to remove a newer owner', async t => {
  const SocketManager = require('../../../node/socket');
  const manager = new SocketManager('fixture-cookie', 'project', () => {});
  const handlers = { applied() {}, interrupted() {}, failed() {} };
  const release = manager.observeDocument('doc', handlers);
  assert.throws(() => manager.observeDocument('doc', handlers), { code: 'DOCUMENT_OWNED' });
  release();
  const releaseNew = manager.observeDocument('doc', handlers);
  release();
  await assert.rejects(manager.applyOtUpdate('doc', [], 0, ''), { code: 'DOCUMENT_OWNED' });
  await assert.rejects(manager.leaveDoc('doc'), { code: 'DOCUMENT_OWNED' });
  releaseNew();
  assert.equal(manager.documents.size, 0);
});

test('legacy-server unsupported insertions stay saved locally without a network intent and later supported saves can sync', async t => {
  const { engine, transport, sent, save } = await fixture(t);
  await save('😀 ' + base);
  await transport.publish();
  assert.equal(engine.snapshot().saved, '😀 ' + base);
  assert.equal(engine.snapshot().pending, null);
  assert.equal(sent.length, 0);
  assert.equal(transport.status().reason, 'unsupported-insert');
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: base.length, i: '\nPEER' }] });
  assert.equal(engine.snapshot().remote.content, base + '\nPEER');
  await save('SUPPORTED ' + base + '\nPEER');
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal(apply(engine.snapshot().remote.content, sent[0].op), 'SUPPORTED ' + base + '\nPEER');
});

test('a durable queue receipt plus complete drained join history can prove rejection and rebase a retry', async t => {
  const { engine, transport, queued, store, save, track } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  queued[0].resolve();
  await transport.idle();
  assert.equal((await store.read('doc')).state.pending.queued, true);
  await transport.close();
  const sent = [];
  const next = track(new DocumentTransport(engine, { document: 'doc', source: 'next', send: update => sent.push(update) }));
  await next.join({ content: base + '\nPEER', version: 4, queueDrained: true,
    updates: [{ v: 3, op: [{ p: base.length, i: '\nPEER' }], meta: { source: 'colleague' } }] });
  assert.equal(engine.snapshot().recovery.upload.outcome, 'not-applied');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].v, 4);
  assert.equal(apply(engine.snapshot().remote.content, sent[0].op), 'SAVED ' + base + '\nPEER');
  assert.equal(engine.snapshot().pending.source, 'next');
});

test('operation absence cannot retire a queued save without a queue-draining snapshot contract', async t => {
  const { engine, transport, queued, save, track } = await fixture(t);
  await save('SAVED ' + base);
  await transport.publish();
  queued[0].resolve();
  await transport.idle();
  await transport.close();
  const sent = [];
  const next = track(new DocumentTransport(engine, { document: 'doc', source: 'next', send: update => sent.push(update) }));
  await next.join({ content: base, version: 3, updates: [] });
  assert.equal(engine.snapshot().pending.source, 'connection-one');
  assert.equal(engine.snapshot().pending.status, 'uncertain');
  assert.equal(sent.length, 0);
});

test('a late queue receipt cannot mark a newer saved submission as queued', async t => {
  const { engine, transport, queued, save } = await fixture(t);
  await save('FIRST ' + base);
  await transport.publish();
  await save('SECOND ' + base);
  await transport.receive({ doc: 'doc', v: 3 });
  const newer = engine.snapshot().pending;
  queued[0].resolve();
  await transport.idle();
  assert.equal(engine.snapshot().pending.token, newer.token);
  assert.notEqual(engine.snapshot().pending.queued, true);
});

function nativeCheckpoint(content, format) {
  return { history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content, empty: false }] },
    tree: { seq_cur: 0, seq_last: 0 }, undo: null,
    options: { fileformat: 'unix', bomb: false, ...format, endofline: false, fixendofline: false,
      fileencoding: 'utf-8', binary: false, undolevels: 1000 } };
}

test('BOM and DOS local saves use logical server operations and preserve their format across incoming edits and ACKs', async t => {
  const { engine, transport, sent } = await fixture(t);
  await engine.checkpointEditor(nativeCheckpoint(base), engine.snapshot().revision);
  const logical = 'SAVED ' + base;
  const physical = '\ufeff' + logical.replaceAll('\n', '\r\n');
  await engine.saveEditor(nativeCheckpoint(logical, { fileformat: 'dos', bomb: true }), engine.snapshot().revision, physical);
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal(apply(base, sent[0].op), logical);
  assert.equal(engine.snapshot().saved, physical);
  assert.equal(engine.snapshot().pending.wire.content, logical);
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: base.length, i: '\nPEER' }] });
  await transport.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().remote.wire, logical + '\nPEER');
  assert.equal(engine.snapshot().remote.content, physical + '\r\nPEER');
  assert.equal(engine.snapshot().saved, physical + '\r\nPEER');
  assert.equal(engine.snapshot().pending, null);
});

test('a format-only local save changes neither server content nor version and never creates a wire intent', async t => {
  const { engine, transport, sent } = await fixture(t);
  await engine.checkpointEditor(nativeCheckpoint(base), engine.snapshot().revision);
  const physical = '\ufeff' + base.replaceAll('\n', '\r\n');
  await engine.saveEditor(nativeCheckpoint(base, { fileformat: 'dos', bomb: true }), engine.snapshot().revision, physical);
  await transport.publish();
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().pending, null);
  assert.equal(engine.snapshot().remote.version, 3);
  assert.equal(engine.snapshot().remote.wire, base);
  assert.equal(engine.snapshot().remote.content, physical);
  assert.equal(engine.snapshot().saved, physical);
});

test('changing local format while an upload is pending does not change its wire identity or the next saved revision', async t => {
  const { engine, transport, sent } = await fixture(t);
  await engine.checkpointEditor(nativeCheckpoint(base), engine.snapshot().revision);
  const first = 'FIRST ' + base;
  await engine.saveEditor(nativeCheckpoint(first, { fileformat: 'dos', bomb: true }), engine.snapshot().revision,
    '\ufeff' + first.replaceAll('\n', '\r\n'));
  await transport.publish();
  const second = 'SECOND ' + base;
  await engine.saveEditor(nativeCheckpoint(second), engine.snapshot().revision, second);
  await transport.receive({ doc: 'doc', v: 3, op: [{ p: base.length, i: '\nPEER' }] });
  await transport.receive({ doc: 'doc', v: 4 });
  assert.equal(engine.snapshot().remote.content, first + '\nPEER');
  assert.equal(engine.snapshot().saved, second + '\nPEER');
  assert.equal(sent.length, 2);
  assert.equal(apply(first + '\nPEER', sent[1].op), second + '\nPEER');
  assert.deepEqual(engine.snapshot().savedFormat, { fileformat: 'unix', bomb: false });
});

test('lost-ACK proof uses logical snapshots when local BOM and line endings change before restarting', async t => {
  const { engine, transport, store, track } = await fixture(t);
  await engine.checkpointEditor(nativeCheckpoint(base), engine.snapshot().revision);
  const first = 'FIRST ' + base, second = 'SECOND ' + base;
  await engine.saveEditor(nativeCheckpoint(first, { fileformat: 'dos', bomb: true }), engine.snapshot().revision,
    '\ufeff' + first.replaceAll('\n', '\r\n'));
  await transport.publish();
  await engine.saveEditor(nativeCheckpoint(second), engine.snapshot().revision, second);
  await transport.close();
  const reopened = await DocumentEngine.open(store, 'doc');
  const sent = [];
  const next = track(new DocumentTransport(reopened, { document: 'doc', source: 'next', send: update => sent.push(update) }));
  await next.join({ content: first, version: 4,
    updates: [{ v: 3, op: [{ p: 0, i: 'FIRST ' }], meta: { source: 'connection-one' } }] });
  assert.equal(reopened.snapshot().remote.content, first);
  assert.equal(reopened.snapshot().remote.wire, first);
  assert.equal(reopened.snapshot().saved, second);
  assert.equal(sent.length, 1);
  assert.equal(apply(first, sent[0].op), second);
});

test('an existing server BOM stays distinct from local encoding and joining never publishes its removal', async t => {
  const { engine, transport, sent } = await fixture(t, '\ufeff' + base);
  assert.equal(sent.length, 0);
  assert.equal(engine.snapshot().saved, '\ufeff' + base);
  await engine.checkpointEditor(nativeCheckpoint(base, { bomb: true }), engine.snapshot().revision);
  await engine.saveEditor(nativeCheckpoint('SAVED ' + base, { bomb: true }), engine.snapshot().revision, '\ufeffSAVED ' + base);
  await transport.publish();
  assert.equal(sent.length, 1);
  assert.equal(apply('\ufeff' + base, sent[0].op), '\ufeffSAVED ' + base);
  await transport.receive({ doc: 'doc', v: 3 });
  assert.equal(engine.snapshot().saved, '\ufeffSAVED ' + base);
  await transport.receive({ doc: 'doc', v: 4, op: [{ p: 0, d: '\ufeff' }] });
  assert.equal(engine.snapshot().remote.wire, 'SAVED ' + base);
  assert.equal(engine.snapshot().saved, '\ufeffSAVED ' + base);
  assert.equal(sent.length, 1);
});
