'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { SyncSession } = require('../../../node/sync/session');

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
