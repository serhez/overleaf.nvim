'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
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
