'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const childProcess = require('node:child_process');
const { execFile } = childProcess;
const { promisify } = require('node:util');
const { Workspace } = require('../../../node/sync/workspace');
const { SnapshotStore } = require('../../../node/sync/store');

async function fixture(t, content = 'original\n') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workspace-test-')));
  const root = path.join(directory, 'sources');
  const recovery = path.join(directory, 'recovery');
  await fs.mkdir(root);
  const filename = path.join(root, 'main.tex');
  if (content !== null) await fs.writeFile(filename, content, { mode: 0o640 });
  const workspace = await Workspace.open({ root, recovery });
  t.after(async () => {
    await workspace.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, recovery, filename, workspace };
}
const bytes = record => Buffer.from(record.state.observed.bytes, 'base64');
const replace = (workspace, revision, content) => workspace.write('main.tex', Buffer.from(content), revision);
// Workspace treats native history as opaque bytes; Lua verifies full imports.
const undoBytes = label => Buffer.concat([Buffer.from('Vim\x9fUnDo\xe5', 'latin1'), Buffer.from(label)]);
const execute = promisify(execFile);

test('legacy inventory is read-only and selected reads retain exact bytes without following aliases', async t => {
  const { directory, filename } = await fixture(t);
  const legacy = path.join(directory, 'legacy');
  await fs.mkdir(path.join(legacy, 'chapter'), { recursive: true });
  const selected = path.join(legacy, 'chapter', 'old.tex');
  const content = '\ufeffold unsynchronized edit\r\n';
  await fs.writeFile(selected, content);
  await fs.symlink(filename, path.join(legacy, 'linked.tex'));
  const inventory = await Workspace.inventoryLegacy(legacy);
  assert.equal(inventory.entries.find(entry => entry.path === 'chapter/old.tex').type, 'file');
  assert.equal(inventory.entries.find(entry => entry.path === 'linked.tex').type, 'link');
  const review = await Workspace.readLegacy(selected);
  assert.equal(Buffer.from(review.observed.bytes, 'base64').toString(), content);
  await assert.rejects(Workspace.readLegacy(path.join(legacy, 'linked.tex')), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(selected, 'utf8'), content);
  await assert.rejects(fs.stat(path.join(legacy, '.overleaf-workspace.json')), { code: 'ENOENT' });
});

test('one physical source root cannot acquire a second recovery authority, even after close', async t => {
  const { workspace, root, directory, recovery, filename } = await fixture(t);
  const other = path.join(directory, 'other-recovery');
  await assert.rejects(Workspace.open({ root, recovery: other }), { code: 'WORKSPACE_IDENTITY' });
  await workspace.close();
  await assert.rejects(Workspace.open({ root, recovery: other }), { code: 'WORKSPACE_IDENTITY' });
  const reopened = await Workspace.open({ root, recovery });
  await reopened.close();
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
});

test('concurrent claims through different recovery roots admit only one source writer', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-root-claim-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'sources');
  await fs.mkdir(root);
  const results = await Promise.allSettled(['one', 'two'].map(name => Workspace.open({ root, recovery: path.join(directory, name) })));
  const opened = results.filter(result => result.status === 'fulfilled');
  for (const result of opened) await result.value.close();
  assert.equal(opened.length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORKSPACE_IDENTITY');
});

test('nested source roots are refused in either ownership order', async t => {
  for (const childFirst of [true, false]) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-nested-claim-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const parent = path.join(directory, 'sources'), child = path.join(parent, 'chapter');
    await fs.mkdir(child, { recursive: true });
    const first = await Workspace.open({ root: childFirst ? child : parent, recovery: path.join(directory, 'first') });
    try {
      await assert.rejects(Workspace.open({ root: childFirst ? parent : child, recovery: path.join(directory, 'second') }),
        { code: 'WORKSPACE_OVERLAP' });
    } finally { await first.close(); }
  }
});

test('ownership metadata cannot be bound as project text and changed metadata stops source observations', async t => {
  const { workspace, root, filename } = await fixture(t);
  await assert.rejects(workspace.bind('.overleaf-workspace.json', 'doc'), { code: 'UNSAFE_PATH' });
  await fs.writeFile(path.join(root, '.overleaf-workspace.json'), '{}');
  await assert.rejects(workspace.observe('main.tex'), { code: 'WORKSPACE_IDENTITY' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
});

test('reviewed relocation preserves the original source and its mode while transferring the binding', async t => {
  const { workspace, filename, root } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await workspace.observe('main.tex');
  const review = await workspace.reviewRelocation('doc', 'chapters/renamed.tex');
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  await assert.rejects(fs.stat(path.join(root, 'chapters')), { code: 'ENOENT' });
  const result = await workspace.relocate(review);
  assert.equal(result.bound, true);
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal(await fs.readFile(path.join(root, 'chapters/renamed.tex'), 'utf8'), 'original\n');
  assert.equal((await fs.stat(path.join(root, 'chapters/renamed.tex'))).mode & 0o777, 0o640);
  assert.equal((await workspace.bindings())[0].path, 'chapters/renamed.tex');
  assert.equal((await workspace.snapshot('chapters/renamed.tex')).state.observed.bytes, Buffer.from('original\n').toString('base64'));
});

test('relocation rejects stale sources and occupied destinations without changing either file', async t => {
  const { workspace, filename, root } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await workspace.observe('main.tex');
  const review = await workspace.reviewRelocation('doc', 'renamed.tex');
  await fs.writeFile(filename, 'external edit');
  await assert.rejects(workspace.relocate(review), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external edit');
  await assert.rejects(fs.stat(path.join(root, 'renamed.tex')), { code: 'ENOENT' });
  const current = await workspace.reviewRelocation('doc', 'renamed.tex');
  await fs.writeFile(path.join(root, 'renamed.tex'), 'independent target');
  await assert.rejects(workspace.relocate(current), { code: 'TARGET_EXISTS' });
  assert.equal(await fs.readFile(path.join(root, 'renamed.tex'), 'utf8'), 'independent target');
  assert.equal((await workspace.bindings())[0].path, 'main.tex');
});

test('a relocation interrupted after copying retains both sources and requires a fresh explicit review', async t => {
  const { workspace, filename, root } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await workspace.observe('main.tex');
  const review = await workspace.reviewRelocation('doc', 'renamed.tex');
  const write = workspace._store.write.bind(workspace._store);
  const injected = t.mock.method(workspace._store, 'write', async (key, ...args) => {
    if (key === 'bindings') throw new Error('interrupted binding publication');
    return write(key, ...args);
  });
  await assert.rejects(workspace.relocate(review), /interrupted binding publication/);
  injected.mock.restore();
  const target = path.join(root, 'renamed.tex');
  const before = await fs.stat(target, { bigint: true });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  assert.equal((await workspace.bindings())[0].path, 'main.tex');
  await assert.rejects(workspace.relocate(review), { code: 'STALE_RELOCATION' });
  const inspected = await workspace.reviewRelocation('doc', 'renamed.tex');
  assert.equal(inspected.pending.state.phase, 'copied');
  assert.equal((await workspace.relocate(inspected)).bound, true);
  assert.equal((await workspace.snapshot('renamed.tex')).state.recovery, null, 'Retry must not archive another copy of its own relocation record');
  assert.equal((await fs.stat(target, { bigint: true })).ino, before.ino);
  assert.equal((await fs.stat(target, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('relocation rechecks both files after persisting destination history', async t => {
  for (const changed of ['source', 'target']) {
    const { workspace, filename, root } = await fixture(t);
    await workspace.bind('main.tex', 'doc');
    await workspace.observe('main.tex');
    const review = await workspace.reviewRelocation('doc', 'renamed.tex');
    const target = path.join(root, 'renamed.tex');
    const write = workspace._store.write.bind(workspace._store);
    const injected = t.mock.method(workspace._store, 'write', async (key, ...args) => {
      const result = await write(key, ...args);
      if (key === JSON.stringify(['source', 'renamed.tex'])) {
        await fs.writeFile(changed === 'source' ? filename : target, 'external edit');
      }
      return result;
    });
    await assert.rejects(workspace.relocate(review), { code: 'STALE_FILE' });
    injected.mock.restore();
    assert.equal((await workspace.bindings())[0].path, 'main.tex');
    assert.equal(await fs.readFile(filename, 'utf8'), changed === 'source' ? 'external edit' : 'original\n');
    assert.equal(await fs.readFile(target, 'utf8'), changed === 'target' ? 'external edit' : 'original\n');
  }
});

test('a committed relocation remains provable if its final journal confirmation fails', async t => {
  const { workspace, root, recovery, filename } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await workspace.observe('main.tex');
  const review = await workspace.reviewRelocation('doc', 'renamed.tex');
  const write = workspace._store.write.bind(workspace._store);
  const injected = t.mock.method(workspace._store, 'write', async (key, value, revision) => {
    if (key === JSON.stringify(['relocation', 'doc']) && value.phase === 'bound') throw new Error('confirmation interrupted');
    return write(key, value, revision);
  });
  await assert.rejects(workspace.relocate(review), /confirmation interrupted/);
  injected.mock.restore();
  await workspace.close();
  const reopened = await Workspace.open({ root, recovery });
  try {
    const journal = await reopened.relocation('doc');
    assert.equal(journal.bound, true);
    assert.equal(journal.state.review.from, 'main.tex');
    assert.equal(journal.state.review.to, 'renamed.tex');
    assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
    assert.equal(await fs.readFile(path.join(root, 'renamed.tex'), 'utf8'), 'original\n');
  } finally { await reopened.close(); }
});

test('relocation refuses an owned, aliased, or traversing target before creating destination parents', async t => {
  const { workspace, root, filename } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await workspace.bind('other.tex', 'other');
  await assert.rejects(workspace.reviewRelocation('doc', 'other.tex'), { code: 'PATH_BOUND' });
  await assert.rejects(workspace.reviewRelocation('doc', '../outside.tex'), { code: 'UNSAFE_PATH' });
  await fs.symlink(filename, path.join(root, 'linked.tex'));
  await assert.rejects(workspace.reviewRelocation('doc', 'linked.tex'), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
});

test('persists both undo versions before replacing source and persistent history', async t => {
  const { workspace, filename, directory, recovery } = await fixture(t);
  const undo = path.join(directory, 'persistent.undo');
  const original = undoBytes('original history');
  const candidate = undoBytes('saved history');
  await fs.writeFile(undo, original);
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) {
      const record = await new SnapshotStore(recovery).read(JSON.stringify(['source', 'main.tex']));
      assert.equal(record.state.pending.undo.before.bytes, original.toString('base64'));
      assert.equal(record.state.pending.undo.bytes, candidate.toString('base64'));
      assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
      assert.deepEqual(await fs.readFile(undo), original);
    }
    return rename(from, to);
  });
  const result = await workspace.write('main.tex', Buffer.from('saved text'), observed.revision, { path: undo, bytes: candidate });
  assert.equal(await fs.readFile(filename, 'utf8'), 'saved text');
  assert.deepEqual(await fs.readFile(undo), candidate);
  assert.equal((await fs.stat(undo)).mode & 0o777, 0o600);
  assert.equal(result.state.pending, null);
  assert.equal(result.state.undo.path, undo);
  assert.equal(result.state.undo.observed.bytes, candidate.toString('base64'));
  const snapshots = await Promise.all((await fs.readdir(path.join(recovery, 'objects')))
    .map(file => fs.readFile(path.join(recovery, 'objects', file), 'utf8')));
  const intent = snapshots.map(JSON.parse).find(record => record.state.pending?.undo);
  assert.equal(intent.state.observed.bytes, Buffer.from('original\n').toString('base64'));
  assert.equal(intent.state.pending.bytes, Buffer.from('saved text').toString('base64'));
  assert.equal(intent.state.pending.undo.path, undo);
  assert.equal(intent.state.pending.undo.before.bytes, original.toString('base64'));
  assert.equal(intent.state.pending.undo.bytes, candidate.toString('base64'));
});

test('writes persistent undo on a clean source save without replacing the source inode', async t => {
  const { workspace, filename, directory } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const before = await fs.stat(filename);
  const undo = { path: path.join(directory, 'persistent.undo'), bytes: undoBytes('clean save') };
  const result = await workspace.write('main.tex', bytes(observed), observed.revision, undo);
  assert.deepEqual(await fs.readFile(undo.path), undo.bytes);
  assert.equal((await fs.stat(filename)).ino, before.ino);
  assert.equal((await fs.stat(filename)).mtimeMs, before.mtimeMs);
  assert.equal(result.state.pending, null);
});

test('captures undo request bytes before queuing and drains publication on close', async t => {
  const { workspace, directory } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const undo = { path: path.join(directory, 'persistent.undo'), bytes: undoBytes('frozen') };
  const expected = Buffer.from(undo.bytes);
  const target = undo.path;
  const saving = workspace.write('main.tex', Buffer.from('saved'), observed.revision, undo);
  undo.bytes.fill(0);
  undo.path = path.join(directory, 'wrong.undo');
  const closing = workspace.close();
  await saving;
  await closing;
  assert.deepEqual(await fs.readFile(target), expected);
  await assert.rejects(fs.stat(undo.path), { code: 'ENOENT' });
});

test('rejects unrelated, linked, oversized, and source-file undo destinations before changing the source', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const unrelated = path.join(directory, 'unrelated');
  await fs.writeFile(unrelated, 'keep this');
  const original = path.join(directory, 'original.undo');
  await fs.writeFile(original, undoBytes('original'));
  await fs.symlink(original, path.join(directory, 'symbolic.undo'));
  await fs.link(original, path.join(directory, 'hard.undo'));
  await fs.mkdir(path.join(directory, 'folder'));
  for (const name of [unrelated, original, path.join(directory, 'symbolic.undo'), path.join(directory, 'folder'), filename]) {
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
      { path: name, bytes: undoBytes('candidate') }), { code: 'UNSAFE_UNDO' });
  }
  const oversized = path.join(directory, 'oversized.undo');
  await fs.writeFile(oversized, undoBytes('old'));
  await fs.truncate(oversized, 64 * 1024 * 1024 + 1);
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: oversized, bytes: undoBytes('candidate') }), { code: 'FILE_LIMIT' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep this');
  assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
});

test('refuses an externally replaced tracked undo file, even when its bytes are identical', async t => {
  const { workspace, filename, directory } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const undo = { path: path.join(directory, 'persistent.undo'), bytes: undoBytes('saved') };
  const saved = await workspace.write('main.tex', Buffer.from('first'), observed.revision, undo);
  await fs.writeFile(undo.path + '.external', undo.bytes);
  await fs.rename(undo.path + '.external', undo.path);
  await assert.rejects(workspace.write('main.tex', Buffer.from('second'), saved.revision, undo), { code: 'STALE_UNDO' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'first');
  assert.deepEqual(await fs.readFile(undo.path), undo.bytes);
});

for (const point of ['source', 'source-record', 'undo', 'completion']) {
  test('retains recoverable source and undo versions after failure at ' + point, async t => {
    const { workspace, filename, directory, root, recovery } = await fixture(t);
    const target = path.join(directory, 'persistent.undo');
    const original = undoBytes('old history'), candidate = undoBytes('new history');
    await fs.writeFile(target, original);
    const observed = await workspace.observe('main.tex');
    const rename = fs.rename.bind(fs);
    const storeWrite = SnapshotStore.prototype.write;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === (point === 'source' ? filename : point === 'undo' ? target : null)) throw new Error('injected replacement failure');
      return rename(from, to);
    });
    t.mock.method(SnapshotStore.prototype, 'write', async function (id, state, revision) {
      if (point === 'completion' && state.pending === null) throw new Error('injected completion failure');
      if (point === 'source-record' && state.pending?.sourceInstalled) throw new Error('injected source recording failure');
      return storeWrite.call(this, id, state, revision);
    });
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
      { path: target, bytes: candidate }), /injected/);
    assert.equal(await fs.readFile(filename, 'utf8'), point === 'source' ? 'original\n' : 'saved');
    assert.deepEqual(await fs.readFile(target), point === 'completion' ? candidate : original);
    const held = await workspace.snapshot('main.tex');
    assert.equal(held.state.pending.undo.before.bytes, original.toString('base64'));
    assert.equal(held.state.pending.undo.bytes, candidate.toString('base64'));
    await workspace.close();
    const reopened = await Workspace.open({ root, recovery });
    try {
      assert.deepEqual(await reopened.snapshot('main.tex'), held);
      await assert.rejects(reopened.observe('main.tex'), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    } finally { await reopened.close(); }
  });
}

test('removes an obsolete undo file for a history-free save only after preserving it in recovery', async t => {
  const { workspace, directory, recovery } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const original = undoBytes('obsolete');
  await fs.writeFile(target, original);
  const observed = await workspace.observe('main.tex');
  const result = await workspace.write('main.tex', Buffer.from('saved'), observed.revision, { path: target, bytes: null });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.equal(result.state.undo.observed.exists, false);
  const snapshots = await Promise.all((await fs.readdir(path.join(recovery, 'objects')))
    .map(file => fs.readFile(path.join(recovery, 'objects', file), 'utf8')));
  assert.ok(snapshots.map(JSON.parse).some(record => record.state.pending?.undo?.before.bytes === original.toString('base64')));
});

test('keeps undo tracking across source observations and refuses a source-only replacement', async t => {
  const { workspace, filename, directory } = await fixture(t);
  let observed = await workspace.observe('main.tex');
  const undo = { path: path.join(directory, 'persistent.undo'), bytes: undoBytes('saved') };
  await workspace.write('main.tex', Buffer.from('first'), observed.revision, undo);
  await fs.writeFile(filename, 'external source change');
  observed = await workspace.observe('main.tex');
  assert.equal(observed.state.undo.path, undo.path);
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'UNDO_REQUIRED' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external source change');
  assert.deepEqual(await fs.readFile(undo.path), undo.bytes);
});

test('does not let two documents share an undo destination or use another bound source', async t => {
  const { workspace, directory, root } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const second = path.join(root, 'second.tex');
  await fs.writeFile(second, undoBytes('source must survive'));
  await workspace.bind('main.tex', 'first');
  await workspace.bind('second.tex', 'second');
  const first = await workspace.observe('main.tex');
  await assert.rejects(workspace.write('main.tex', Buffer.from('first saved'), first.revision,
    { path: second, bytes: undoBytes('first history') }), { code: 'UNSAFE_UNDO' });
  await workspace.write('main.tex', Buffer.from('first saved'), first.revision,
    { path: target, bytes: undoBytes('first history') });
  const observed = await workspace.observe('second.tex');
  await assert.rejects(workspace.write('second.tex', Buffer.from('second saved'), observed.revision,
    { path: target, bytes: undoBytes('second history') }), { code: 'UNSAFE_UNDO' });
  assert.deepEqual(await fs.readFile(target), undoBytes('first history'));
  assert.deepEqual(await fs.readFile(second), undoBytes('source must survive'));
});

test('refuses malformed candidates and aliased undo parents before recording a write intent', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  await fs.mkdir(path.join(directory, 'undos'));
  await fs.symlink(path.join(directory, 'undos'), path.join(directory, 'alias'));
  for (const undo of [
    { path: 'relative.undo', bytes: undoBytes('history') },
    { path: path.join(directory, 'alias/file.undo'), bytes: undoBytes('history') },
    { path: path.join(directory, 'persistent.undo'), bytes: Buffer.from('not undo') },
    { path: path.join(directory, 'persistent.undo'), bytes: 'not bytes' },
  ]) {
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision, undo), { code: 'UNSAFE_UNDO' });
  }
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: path.join(directory, 'persistent.undo'), bytes: Buffer.alloc(64 * 1024 * 1024 + 1) }), { code: 'FILE_LIMIT' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
});

test('rechecks undo changes made while recording the intent before replacing the source', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const external = undoBytes('external');
  await fs.writeFile(target, undoBytes('original'));
  const observed = await workspace.observe('main.tex');
  const storeWrite = SnapshotStore.prototype.write;
  t.mock.method(SnapshotStore.prototype, 'write', async function (id, state, revision) {
    const result = await storeWrite.call(this, id, state, revision);
    if (state.pending?.undo) await fs.writeFile(target, external);
    return result;
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') }), { code: 'STALE_UNDO' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.deepEqual(await fs.readFile(target), external);
  assert.ok((await workspace.snapshot('main.tex')).state.pending);
});

for (const staging of ['source', 'undo']) {
  test('rechecks the other artifact after staging ' + staging, async t => {
    const { workspace, directory, filename, root } = await fixture(t);
    const undodir = path.join(directory, 'undos');
    await fs.mkdir(undodir);
    const target = path.join(undodir, 'persistent.undo');
    const original = undoBytes('original'), external = undoBytes('external');
    await fs.writeFile(target, original);
    const observed = await workspace.observe('main.tex');
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (name, flags, ...args) => {
      const handle = await open(name, flags, ...args);
      if (flags === 'wx' && name.endsWith('.overleaf-tmp') && path.dirname(name) === (staging === 'source' ? root : undodir)) {
        await fs.writeFile(staging === 'source' ? target : filename, staging === 'source' ? external : 'external source');
      }
      return handle;
    });
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
      { path: target, bytes: undoBytes('candidate') }), { code: staging === 'source' ? 'STALE_UNDO' : 'STALE_FILE' });
    assert.equal(await fs.readFile(filename, 'utf8'), staging === 'source' ? 'original\n' : 'external source');
    assert.deepEqual(await fs.readFile(target), staging === 'source' ? external : original);
    assert.ok((await workspace.snapshot('main.tex')).state.pending);
  });
}

test('preserves a new undo file racing the first publication', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const external = undoBytes('external');
  const observed = await workspace.observe('main.tex');
  const link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === target) await fs.writeFile(target, external);
    return link(from, to);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'saved');
  assert.deepEqual(await fs.readFile(target), external);
  assert.ok((await workspace.snapshot('main.tex')).state.pending.sourceInstalled);
});

test('records confirmed source installation if undo staging is denied', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const undodir = path.join(directory, 'undos');
  await fs.mkdir(undodir);
  const target = path.join(undodir, 'persistent.undo');
  const observed = await workspace.observe('main.tex');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, flags, ...args) => {
    if (path.dirname(name) === undodir && flags === 'wx') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return open(name, flags, ...args);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') }), { code: 'EACCES' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'saved');
  const pending = (await workspace.snapshot('main.tex')).state.pending;
  assert.equal(pending.sourceInstalled.bytes, Buffer.from('saved').toString('base64'));
  assert.equal(pending.undo.before.exists, false);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('detects source changes during undo publication without replacing the external text', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  await fs.writeFile(target, undoBytes('old'));
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === target) await fs.writeFile(filename, 'external text');
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') }), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external text');
  assert.ok((await workspace.snapshot('main.tex')).state.pending.sourceInstalled);
});

test('retains obsolete history and a pending intent when undo removal fails', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const original = undoBytes('old');
  await fs.writeFile(target, original);
  const observed = await workspace.observe('main.tex');
  const unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async name => {
    if (name === target) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return unlink(name);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: null }), { code: 'EACCES' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'saved');
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal((await workspace.snapshot('main.tex')).state.pending.undo.bytes, null);
});

test('does not change either file if the paired write intent cannot be persisted', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(directory, 'persistent.undo');
  const original = undoBytes('old');
  await fs.writeFile(target, original);
  const observed = await workspace.observe('main.tex');
  const write = SnapshotStore.prototype.write;
  t.mock.method(SnapshotStore.prototype, 'write', async function (id, state, revision) {
    if (state.pending?.undo) throw new Error('injected full recovery disk');
    return write.call(this, id, state, revision);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') }), /full recovery disk/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
});

test('refuses binding a tracked undo artifact as another source file', async t => {
  const { workspace, root } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const target = path.join(root, '.main.tex.un~');
  await workspace.write('main.tex', Buffer.from('saved'), observed.revision,
    { path: target, bytes: undoBytes('candidate') });
  await assert.rejects(workspace.bind('.main.tex.un~', 'different-document'), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readFile(target), undoBytes('candidate'));
});

test('observations preserve exact bytes without changing sources or inventing remote state', async t => {
  const original = Buffer.from('\ufeffé😀\r\nlast');
  const { workspace, filename } = await fixture(t, original);
  const before = await fs.stat(filename);
  const record = await workspace.observe('main.tex');
  assert.deepEqual(bytes(record), original);
  assert.equal(record.state.pending, null);
  assert.equal((await fs.stat(filename)).mtimeMs, before.mtimeMs);
  assert.equal((await workspace.observe('main.tex')).revision, record.revision);
  assert.equal(record.state.remote, undefined);
});

test('binding a nested document creates ordinary parents and exposes durable identity for reopening', async t => {
  const { workspace, root, recovery } = await fixture(t);
  await workspace.bind('chapters/part/main.tex', 'nested-doc');
  assert.equal((await fs.lstat(path.join(root, 'chapters/part'))).isDirectory(), true);
  assert.deepEqual(await workspace.bindings(), [{ document: 'nested-doc', path: 'chapters/part/main.tex' }]);
  await workspace.close();
  const reopened = await Workspace.open({ root, recovery });
  try {
    assert.deepEqual(await reopened.bindings(), [{ document: 'nested-doc', path: 'chapters/part/main.tex' }]);
    assert.equal((await reopened.observe('chapters/part/main.tex')).state.observed.exists, false);
  } finally { await reopened.close(); }
});

test('parent creation never follows a symlink or accepts traversal from a remote document path', async t => {
  const { workspace, root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'linked'));
  await assert.rejects(workspace.bind('linked/new/main.tex', 'doc'), { code: 'UNSAFE_PATH' });
  await assert.rejects(workspace.bind('../outside/new/main.tex', 'doc'), { code: 'UNSAFE_PATH' });
  await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
  assert.deepEqual(await workspace.bindings(), []);
});

test('guarded writes preserve permissions and both originals in durable recovery', async t => {
  const { workspace, filename, recovery } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const result = await replace(workspace, observed.revision, 'incoming\r\n😀');
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming\r\n😀');
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o640);
  assert.equal(bytes(result).toString(), 'incoming\r\n😀');
  assert.equal(result.state.pending, null);
  const snapshots = await Promise.all((await fs.readdir(path.join(recovery, 'objects')))
    .map(file => fs.readFile(path.join(recovery, 'objects', file), 'utf8')));
  const intent = snapshots.map(JSON.parse).find(record => record.state.pending);
  assert.equal(Buffer.from(intent.state.observed.bytes, 'base64').toString(), 'original\n');
  assert.equal(Buffer.from(intent.state.pending.bytes, 'base64').toString(), 'incoming\r\n😀');
});

test('guarded source replacement preserves extended attributes', async t => {
  const { workspace, filename } = await fixture(t);
  const mac = process.platform === 'darwin';
  if (mac) await execute('/usr/bin/xattr', ['-w', 'user.overleaf-test', 'retained metadata', filename]);
  else await execute('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1], "user.overleaf-test", b"retained metadata")', filename]);
  const observed = await workspace.observe('main.tex');
  await replace(workspace, observed.revision, 'incoming text');
  const result = mac ? await execute('/usr/bin/xattr', ['-p', 'user.overleaf-test', filename])
    : await execute('python3', ['-c', 'import os,sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], "user.overleaf-test"))', filename]);
  assert.equal(result.stdout.trimEnd(), 'retained metadata');
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming text');
});

test('guarded source replacement preserves access control entries', async t => {
  const { workspace, filename } = await fixture(t);
  const mac = process.platform === 'darwin';
  if (mac) await execute('/bin/chmod', ['+a', 'everyone allow read', filename]);
  else await execute('setfacl', ['-m', 'u:65534:r--', filename]);
  const acl = async () => {
    const result = mac ? await execute('/bin/ls', ['-le', filename]) : await execute('getfacl', ['--omit-header', '--numeric', filename]);
    return mac ? result.stdout.split('\n').slice(1).join('\n') : result.stdout;
  };
  const original = await acl();
  assert.ok(original.trim());
  const observed = await workspace.observe('main.tex');
  await replace(workspace, observed.revision, 'incoming text');
  assert.equal(await acl(), original);
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming text');
});

test('metadata-copy failure retains the source and durable candidate without installing either', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  t.mock.method(childProcess, 'execFile', (_command, _args, _options, callback) => {
    callback(new Error('injected metadata copy failure'));
  });
  await assert.rejects(replace(workspace, observed.revision, 'candidate'), { code: 'METADATA_COPY_FAILED' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  const held = await workspace.snapshot('main.tex');
  assert.equal(Buffer.from(held.state.pending.bytes, 'base64').toString(), 'candidate');
  assert.equal(bytes(held).toString(), 'original\n');
});

test('a source metadata change during copying is preserved and rejects the staged replacement', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    return execFile(command, args, options, (error, stdout, stderr) => {
      if (error) return callback(error, stdout, stderr);
      fs.chmod(filename, 0o600).then(() => callback(null, stdout, stderr), callback);
    });
  });
  await assert.rejects(replace(workspace, observed.revision, 'candidate'), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal(Buffer.from((await workspace.snapshot('main.tex')).state.pending.bytes, 'base64').toString(), 'candidate');
});

test('rejects a newer in-place edit or atomic-save replacement, including identical replacement bytes', async t => {
  const { workspace, filename } = await fixture(t);
  for (const mode of ['in-place', 'atomic', 'identical']) {
    const observed = await workspace.observe('main.tex');
    const external = mode === 'identical' ? bytes(observed) : Buffer.from('external ' + mode);
    if (mode === 'in-place') await fs.writeFile(filename, external);
    else {
      await fs.writeFile(filename + '.external', external);
      await fs.rename(filename + '.external', filename);
    }
    await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'STALE_FILE' });
    assert.deepEqual(await fs.readFile(filename), external);
    assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
  }
});

test('missing source files remain missing until an explicit guarded creation', async t => {
  const { workspace, filename } = await fixture(t, null);
  const missing = await workspace.observe('main.tex');
  assert.equal(missing.state.observed.exists, false);
  const created = await replace(workspace, missing.revision, 'created');
  assert.equal(bytes(created).toString(), 'created');
  await fs.unlink(filename);
  await assert.rejects(replace(workspace, created.revision, 'do not resurrect'), { code: 'STALE_FILE' });
  assert.equal((await workspace.observe('main.tex')).state.observed.exists, false);
});

test('same-path creation racing installation is never overwritten', async t => {
  const { workspace, filename } = await fixture(t, null);
  const observed = await workspace.observe('main.tex');
  const link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === filename) await fs.writeFile(filename, 'external creation');
    return link(from, to);
  });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external creation');
  assert.ok((await workspace.snapshot('main.tex')).state.pending);
});

test('refuses absolute, traversing, symlinked, non-file, and multiply linked paths', async t => {
  const { workspace, root, directory, filename } = await fixture(t);
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(directory, 'outside'), 'outside');
  await fs.symlink(path.join(directory, 'outside'), path.join(root, 'link'));
  await fs.symlink(directory, path.join(root, 'alias'));
  await fs.link(filename, path.join(root, 'hardlink'));
  for (const name of ['/tmp/outside', '../outside', 'folder/../main.tex', './main.tex', 'folder//a', 'link', 'alias/outside', 'folder', 'hardlink']) {
    await assert.rejects(workspace.observe(name), { code: 'UNSAFE_PATH' }, name);
  }
  assert.equal(await fs.readFile(path.join(directory, 'outside'), 'utf8'), 'outside');
});

test('rejects source parent replacement between observation and installation', async t => {
  const { workspace, root, directory } = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested/file.tex'), 'old');
  const observed = await workspace.observe('nested/file.tex');
  await fs.rename(path.join(root, 'nested'), path.join(directory, 'old-parent'));
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested/file.tex'), 'external');
  await assert.rejects(workspace.write('nested/file.tex', Buffer.from('incoming'), observed.revision), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(path.join(root, 'nested/file.tex'), 'utf8'), 'external');
});

test('checks again after staging a candidate and retains it if an external edit arrived', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, flags, ...args) => {
    const handle = await open(name, flags, ...args);
    if (String(name).endsWith('.overleaf-tmp')) await fs.writeFile(filename, 'external while staging');
    return handle;
  });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external while staging');
  assert.ok((await workspace.snapshot('main.tex')).state.pending);
});

test('no source write occurs if the durable intent cannot be stored', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  t.mock.method(SnapshotStore.prototype, 'write', async () => { throw new Error('injected full recovery disk'); });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), /full recovery disk/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
});

test('installation failure preserves source and candidate, and restart never guesses that it succeeded', async t => {
  const { workspace, filename, root, recovery } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw Object.assign(new Error('injected rename denial'), { code: 'EACCES' });
    return rename(from, to);
  });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'EACCES' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  const interrupted = await workspace.snapshot('main.tex');
  assert.equal(Buffer.from(interrupted.state.pending.bytes, 'base64').toString(), 'incoming');
  await workspace.close();
  const reopened = await Workspace.open({ root, recovery });
  try {
    await assert.rejects(reopened.observe('main.tex'), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    await assert.rejects(replace(reopened, interrupted.revision, 'retry'), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
    assert.deepEqual(await reopened.snapshot('main.tex'), interrupted);
  } finally {
    await reopened.close();
  }
});

test('failure after replacement retains an uncertain intent and both versions', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const write = SnapshotStore.prototype.write;
  t.mock.method(SnapshotStore.prototype, 'write', async function (id, state, revision) {
    if (state.pending === null) throw new Error('injected completion persistence failure');
    return write.call(this, id, state, revision);
  });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), /completion persistence failure/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming');
  const uncertain = await workspace.snapshot('main.tex');
  assert.equal(bytes(uncertain).toString(), 'original\n');
  assert.equal(Buffer.from(uncertain.state.pending.bytes, 'base64').toString(), 'incoming');
});

test('serializes competing writes, freezes caller bytes, and drains before releasing ownership', async t => {
  const { workspace, filename, root, recovery } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  await assert.rejects(Workspace.open({ root, recovery }), { code: 'WORKSPACE_BUSY' });
  const candidate = Buffer.from('first');
  const first = workspace.write('main.tex', candidate, observed.revision);
  candidate.fill(0);
  const second = replace(workspace, observed.revision, 'second');
  const secondCheck = assert.rejects(second, { code: 'STALE_REVISION' });
  const closing = workspace.close();
  await assert.rejects(workspace.observe('main.tex'), { code: 'WORKSPACE_CLOSED' });
  await first;
  await secondCheck;
  await closing;
  assert.equal(await fs.readFile(filename, 'utf8'), 'first');
});

test('stable reads reject changes during observation instead of accepting a partial revision', async t => {
  const { workspace, filename } = await fixture(t);
  const open = fs.open.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'open', async (name, flags, ...args) => {
    if (name === filename) await fs.writeFile(filename, 'changing ' + ++reads);
    return open(name, flags, ...args);
  });
  await assert.rejects(workspace.observe('main.tex'), { code: 'UNSTABLE_FILE' });
  assert.equal(await workspace.snapshot('main.tex'), null);
});

test('recovery roots cannot be inside source trees, and recovery cannot be reused for another root', async t => {
  const { root, directory, workspace, recovery } = await fixture(t);
  await assert.rejects(Workspace.open({ root, recovery: path.join(root, '.recovery') }), { code: 'UNSAFE_PATH' });
  await workspace.close();
  const other = path.join(directory, 'other-sources');
  await fs.mkdir(other);
  await assert.rejects(Workspace.open({ root: other, recovery }), { code: 'WORKSPACE_IDENTITY' });
});

test('source size limits hold observations and writes without truncating anything', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  await assert.rejects(workspace.write('main.tex', Buffer.alloc(16 * 1024 * 1024 + 1), observed.revision), { code: 'FILE_LIMIT' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
  await fs.truncate(filename, 16 * 1024 * 1024 + 1);
  await assert.rejects(workspace.observe('main.tex'), { code: 'FILE_LIMIT' });
  assert.equal((await fs.stat(filename)).size, 16 * 1024 * 1024 + 1);
  assert.deepEqual(await workspace.snapshot('main.tex'), observed);
});

test('losing recovery ownership during staging prevents source replacement', async t => {
  const { workspace, filename, recovery } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const lock = path.join(recovery, 'writer.lock');
  const oldLock = lock + '.original';
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, flags, ...args) => {
    const handle = await open(name, flags, ...args);
    if (String(name).endsWith('.overleaf-tmp')) {
      await fs.rename(lock, oldLock);
      await fs.writeFile(lock, 'replacement owner');
    }
    return handle;
  });
  try {
    await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'WORKSPACE_LOCK_LOST' });
    assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
    assert.ok((await workspace.snapshot('main.tex')).state.pending);
  } finally {
    // Restore the disposable fixture's actual owner for normal test cleanup.
    await fs.unlink(lock);
    await fs.rename(oldLock, lock);
  }
});

test('detects an external replacement immediately after installation and leaves recovery pending', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === filename) {
      await fs.writeFile(filename + '.external', 'newer external');
      await rename(filename + '.external', filename);
    }
  });
  await assert.rejects(replace(workspace, observed.revision, 'incoming'), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'newer external');
  assert.ok((await workspace.snapshot('main.tex')).state.pending);
});

test('unchanged candidate bytes cause no source rewrite and no revision increment', async t => {
  const { workspace, filename } = await fixture(t);
  const observed = await workspace.observe('main.tex');
  const before = await fs.stat(filename, { bigint: true });
  assert.deepEqual(await workspace.write('main.tex', bytes(observed), observed.revision), observed);
  const after = await fs.stat(filename, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
});


test('explicitly disabling persistent undo retains the old archive and permits source-only updates', async t => {
  const { workspace, directory, filename } = await fixture(t);
  const target = path.join(path.dirname(filename), 'saved.undo');
  const original = undoBytes('saved history');
  let record = await workspace.observe('main.tex');
  record = await workspace.write('main.tex', bytes(record), record.revision, { path: target, bytes: original });
  const disabled = await workspace.write('main.tex', Buffer.from('new save'), record.revision, null);
  assert.equal(disabled.state.undo, null);
  assert.equal(disabled.state.pending, null);
  assert.deepEqual(await fs.readFile(target), original);
  await workspace.write('main.tex', Buffer.from('incoming update'), disabled.revision);
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming update');
  assert.deepEqual(await fs.readFile(target), original);
  await workspace.bind('main.tex', 'doc');
  await assert.rejects(workspace.bind('saved.undo', 'other'), { code: 'UNSAFE_PATH' });
});

test('disabling persistent undo on a clean save persists across restart without source replacement', async t => {
  const { workspace, directory, root, recovery, filename } = await fixture(t);
  let record = await workspace.observe('main.tex');
  const target = path.join(directory, 'saved.undo');
  record = await workspace.write('main.tex', bytes(record), record.revision, { path: target, bytes: undoBytes('saved') });
  const before = await fs.stat(filename);
  await workspace.write('main.tex', bytes(record), record.revision, null);
  await workspace.close();
  const reopened = await Workspace.open({ root, recovery });
  try {
    assert.equal((await reopened.snapshot('main.tex')).state.undo, null);
    assert.equal((await fs.stat(filename)).ino, before.ino);
  } finally { await reopened.close(); }
});


test('preserves configured backups before source installation and keeps the oldest patchmode original', async t => {
  const { workspace, root, filename, recovery } = await fixture(t);
  const backup = path.join(root, 'main.tex~');
  const original = path.join(root, 'main.tex.orig');
  await fs.writeFile(backup, 'previous backup');
  const outputs = [{ path: backup, once: false }, { path: original, once: true }];
  let record = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) {
      const intent = await new SnapshotStore(recovery).read(JSON.stringify(['source', 'main.tex']));
      assert.equal(intent.state.pending.backups.length, 2);
      assert.ok(intent.state.pending.backups.every(item => item.installed));
      assert.equal(await fs.readFile(backup, 'utf8'), Buffer.from(intent.state.observed.bytes, 'base64').toString());
      assert.equal(await fs.readFile(original, 'utf8'), 'original\n');
    }
    return rename(from, to);
  });
  record = await workspace.write('main.tex', Buffer.from('first save'), record.revision, undefined, outputs);
  assert.equal(await fs.readFile(backup, 'utf8'), 'original\n');
  assert.equal(await fs.readFile(original, 'utf8'), 'original\n');
  record = await workspace.write('main.tex', Buffer.from('second save'), record.revision, undefined, outputs);
  assert.equal(await fs.readFile(backup, 'utf8'), 'first save');
  assert.equal(await fs.readFile(original, 'utf8'), 'original\n');
  assert.equal(record.state.pending, null);
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
});

for (const phase of ['backup', 'source', 'undo']) {
  test('retains backup originals and installation evidence when a save fails at ' + phase, async t => {
    const { workspace, root, filename } = await fixture(t);
    const backup = path.join(root, 'main.tex~');
    const undo = path.join(root, '.main.tex.un~');
    await fs.writeFile(backup, 'previous backup');
    const observed = await workspace.observe('main.tex');
    const rename = fs.rename.bind(fs), link = fs.link.bind(fs);
    const target = phase === 'backup' ? backup : phase === 'source' ? filename : undo;
    const intercept = original => async (from, to) => {
      if (to === target) throw new Error('injected artifact failure');
      return original(from, to);
    };
    t.mock.method(fs, 'rename', intercept(rename));
    t.mock.method(fs, 'link', intercept(link));
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision,
      { path: undo, bytes: undoBytes('new undo') }, [{ path: backup, once: false }]), /injected artifact failure/);
    const record = await workspace.snapshot('main.tex');
    assert.equal(record.state.pending.backups[0].before.bytes, Buffer.from('previous backup').toString('base64'));
    assert.equal(record.state.pending.backups[0].bytes, Buffer.from('original\n').toString('base64'));
    assert.equal(Boolean(record.state.pending.backups[0].installed), phase !== 'backup');
    assert.equal(await fs.readFile(filename, 'utf8'), phase === 'undo' ? 'saved' : 'original\n');
    await assert.rejects(workspace.write('main.tex', Buffer.from('retry'), record.revision), { code: 'WORKSPACE_RECOVERY_REQUIRED' });
  });
}

test('rejects backup overlaps, aliases, invalid requests and other documents before source writes', async t => {
  const { workspace, root, filename } = await fixture(t);
  await workspace.bind('main.tex', 'doc');
  await fs.writeFile(path.join(root, 'other.tex'), 'other document');
  await workspace.bind('other.tex', 'other');
  await fs.symlink(filename, path.join(root, 'link'));
  const observed = await workspace.observe('main.tex');
  for (const backups of [
    [{ path: filename, once: false }], [{ path: path.join(root, 'other.tex'), once: false }],
    [{ path: path.join(root, 'link'), once: true }], [{ path: 'relative', once: false }],
    [{ path: path.join(root, 'backup'), once: 'false' }],
    [{ path: path.join(root, 'same'), once: false }, { path: path.join(root, 'same'), once: true }],
  ]) {
    await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision, undefined, backups), { code: 'UNSAFE_BACKUP' });
    assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
    assert.equal((await workspace.snapshot('main.tex')).state.pending, null);
  }
});

test('detects an external backup change during staging and preserves both external and source text', async t => {
  const { workspace, root, filename } = await fixture(t);
  const backup = path.join(root, 'main.tex~');
  await fs.writeFile(backup, 'before');
  const observed = await workspace.observe('main.tex');
  const open = fs.open.bind(fs);
  let raced = false;
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (!raced && name.endsWith('.overleaf-tmp')) {
      raced = true;
      await fs.writeFile(backup, 'external backup');
    }
    return handle;
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('saved'), observed.revision, undefined,
    [{ path: backup, once: false }]), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(backup, 'utf8'), 'external backup');
  assert.equal(await fs.readFile(filename, 'utf8'), 'original\n');
});


test('explicit recovery adopts only the inspected current file and retains the interrupted artifacts', async t => {
  const { workspace, filename, root } = await fixture(t);
  const backup = path.join(root, 'main.tex~');
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw new Error('interrupted source write');
    return rename(from, to);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('candidate'), observed.revision, undefined,
    [{ path: backup, once: false }]), /interrupted/);
  injected.mock.restore();
  await fs.writeFile(filename, 'external recovery edit');
  const inspected = await workspace.inspect('main.tex');
  const recovered = await workspace.recover('main.tex', inspected);
  assert.equal(await fs.readFile(filename, 'utf8'), 'external recovery edit');
  assert.equal(recovered.state.pending, null);
  assert.equal(recovered.state.undo, null);
  assert.equal(recovered.state.recovery.pending.bytes, Buffer.from('candidate').toString('base64'));
  assert.equal(recovered.state.recovery.observed.bytes, Buffer.from('original\n').toString('base64'));
  assert.ok(recovered.state.recovery.pending.backups[0].installed);
  assert.equal(await fs.readFile(backup, 'utf8'), 'original\n');
  await workspace.write('main.tex', Buffer.from('next save'), recovered.revision);
});

test('recovery refuses a changed observation or revision without clearing the held intent', async t => {
  const { workspace, filename } = await fixture(t);
  const record = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw new Error('interrupted');
    return rename(from, to);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('candidate'), record.revision), /interrupted/);
  injected.mock.restore();
  const inspected = await workspace.inspect('main.tex');
  await fs.writeFile(filename, 'new external text');
  await assert.rejects(workspace.recover('main.tex', inspected), { code: 'STALE_FILE' });
  assert.deepEqual((await workspace.snapshot('main.tex')).state.pending, inspected.record.state.pending);
  const fresh = await workspace.inspect('main.tex');
  await workspace.recover('main.tex', fresh);
  await assert.rejects(workspace.recover('main.tex', fresh), { code: 'STALE_REVISION' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'new external text');
});

test('explicit recovery never recreates a missing file or deletes incomplete undo artifacts', async t => {
  const { workspace, filename, root } = await fixture(t);
  const undo = path.join(root, '.main.tex.un~');
  const before = undoBytes('original undo');
  await fs.writeFile(undo, before);
  const record = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === undo) throw new Error('interrupted undo');
    return rename(from, to);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('candidate'), record.revision,
    { path: undo, bytes: undoBytes('candidate undo') }), /interrupted/);
  injected.mock.restore();
  await fs.unlink(filename);
  const inspected = await workspace.inspect('main.tex');
  await assert.rejects(workspace.recover('main.tex', inspected), { code: 'MISSING_SOURCE' });
  assert.deepEqual(await fs.readFile(undo), before);
  await fs.writeFile(filename, 'manual restore');
  const recovered = await workspace.recover('main.tex', await workspace.inspect('main.tex'));
  assert.equal(recovered.state.undo, null);
  assert.equal(recovered.state.recovery.pending.undo.before.bytes, before.toString('base64'));
  assert.deepEqual(await fs.readFile(undo), before);
});


test('recovery inspection reports current artifacts and read errors without modifying any file', async t => {
  const { workspace, root, filename } = await fixture(t);
  const undo = path.join(root, '.main.tex.un~');
  const backup = path.join(root, 'main.tex~');
  await fs.writeFile(undo, undoBytes('original'));
  const observed = await workspace.observe('main.tex');
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === undo) throw new Error('interrupted');
    return rename(from, to);
  });
  await assert.rejects(workspace.write('main.tex', Buffer.from('candidate'), observed.revision,
    { path: undo, bytes: undoBytes('new') }, [{ path: backup, once: false }]), /interrupted/);
  injected.mock.restore();
  const inspected = await workspace.inspect('main.tex');
  assert.equal(inspected.artifacts.find(item => item.path === undo).observed.bytes, undoBytes('original').toString('base64'));
  assert.equal(inspected.artifacts.find(item => item.path === backup).observed.bytes, Buffer.from('original\n').toString('base64'));
  await fs.unlink(undo);
  await fs.symlink(filename, undo);
  const unsafe = await workspace.inspect('main.tex');
  assert.equal(unsafe.artifacts.find(item => item.path === undo).error.code, 'UNSAFE_UNDO');
  assert.equal(await fs.readFile(filename, 'utf8'), 'candidate');
  assert.deepEqual(unsafe.record, inspected.record);
});
