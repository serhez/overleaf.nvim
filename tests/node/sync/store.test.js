'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { SnapshotStore } = require('../../../node/sync/store');

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-store-test-')));
  const store = await SnapshotStore.open(directory);
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

test('missing state is distinguishable from a saved empty document', async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.read('doc'), null);
  const saved = await store.write('doc', { saved: '', pending: null }, 0);
  assert.deepEqual(saved, { revision: 1, state: { saved: '', pending: null } });
  assert.deepEqual(await store.read('doc'), saved);
});

test('recovers exact pending work in a new store instance', async (t) => {
  const { directory, store } = await fixture(t);
  const state = {
    remote: { content: 'original\n', version: 7 }, saved: 'saved 😀\n',
    buffer: 'unsaved 日本語\n', pending: { id: 'request', content: 'saved 😀\n' },
  };
  await store.write('doc', state, 0);
  assert.deepEqual(await new SnapshotStore(directory).read('doc'), { revision: 1, state });
});

test('rejects obsolete revisions and preserves newer saved work', async (t) => {
  const { store } = await fixture(t);
  await store.write('doc', { saved: 'first' }, 0);
  await store.write('doc', { saved: 'second' }, 1);
  await assert.rejects(store.write('doc', { saved: 'obsolete' }, 1), { code: 'STALE_REVISION' });
  assert.deepEqual(await store.read('doc'), { revision: 2, state: { saved: 'second' } });
});

test('serializes competing writes so only one can replace the expected revision', async (t) => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    store.write('doc', { saved: 'a' }, 0), store.write('doc', { saved: 'b' }, 0),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE_REVISION');
  assert.equal((await store.read('doc')).revision, 1);
});

test('document IDs are opaque and cannot address paths outside the store', async (t) => {
  const { store } = await fixture(t);
  for (const id of ['../../escape', '/absolute', 'a/b', 'a_b', '😀']) {
    await store.write(id, { saved: id }, 0);
  }
  for (const id of ['../../escape', '/absolute', 'a/b', 'a_b', '😀']) {
    assert.equal((await store.read(id)).state.saved, id);
  }
});

test('captures state at submission rather than after later caller mutations', async (t) => {
  const { store } = await fixture(t);
  const state = { pending: { content: 'saved' } };
  const writing = store.write('doc', state, 0);
  state.pending.content = 'unsaved';
  const result = await writing;
  result.state.pending.content = 'mutated return value';
  assert.equal((await store.read('doc')).state.pending.content, 'saved');
});

test('failed manifest installation leaves the previous revision recoverable', async (t) => {
  const { directory, store } = await fixture(t);
  await store.write('doc', { saved: 'safe' }, 0);
  const rename = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.dirname(to) === path.join(directory, 'documents')) {
      throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  await assert.rejects(store.write('doc', { saved: 'new' }, 1), { code: 'ENOSPC' });
  mocked.mock.restore();
  assert.deepEqual(await new SnapshotStore(directory).read('doc'), { revision: 1, state: { saved: 'safe' } });
  await store.write('doc', { saved: 'retry' }, 1);
  assert.equal((await store.read('doc')).state.saved, 'retry');
});

test('detects damaged snapshot content instead of using it as a merge base', async (t) => {
  const { directory, store } = await fixture(t);
  await store.write('doc', { saved: 'safe' }, 0);
  const [object] = await fs.readdir(path.join(directory, 'objects'));
  await fs.writeFile(path.join(directory, 'objects', object), '{}');
  await assert.rejects(store.read('doc'), { code: 'CORRUPT_STATE' });
});

test('a missing referenced snapshot is corruption, not an uninitialized document', async (t) => {
  const { directory, store } = await fixture(t);
  await store.write('doc', { saved: 'safe' }, 0);
  const [object] = await fs.readdir(path.join(directory, 'objects'));
  await fs.unlink(path.join(directory, 'objects', object));
  await assert.rejects(store.read('doc'), { code: 'CORRUPT_STATE' });
});

test('rejects state that JSON would silently change or omit', async (t) => {
  const { store } = await fixture(t);
  for (const state of [{ value: undefined }, { value: NaN }, { value: Infinity }, { value: () => {} }]) {
    await assert.rejects(store.write('doc', state, 0), /JSON/);
  }
  assert.equal(await store.read('doc'), null);
});

test('only one store can own a workspace while read-only recovery remains available', async (t) => {
  const { directory, store } = await fixture(t);
  await store.write('doc', { saved: 'local work' }, 0);
  await assert.rejects(SnapshotStore.open(directory), { code: 'WORKSPACE_BUSY' });
  const reader = new SnapshotStore(directory);
  assert.equal((await reader.read('doc')).state.saved, 'local work');
  await assert.rejects(reader.write('doc', { saved: 'overwrite' }, 1), { code: 'WORKSPACE_READ_ONLY' });
});

test('writer exclusion applies across processes', async (t) => {
  const { directory } = await fixture(t);
  const script = `
    const { SnapshotStore } = require(process.argv[1]);
    SnapshotStore.open(process.argv[2]).then(async store => {
      await store.close();
      process.exitCode = 1;
    }, error => {
      if (error.code !== 'WORKSPACE_BUSY') throw error;
    });
  `;
  await promisify(execFile)(process.execPath, [
    '-e', script, require.resolve('../../../node/sync/store'), directory,
  ]);
});

test('close drains accepted writes and releases ownership for recovery', async (t) => {
  const { directory, store } = await fixture(t);
  const write = store.write('doc', { saved: 'last save' }, 0);
  const closing = store.close();
  await assert.rejects(store.write('doc', { saved: 'late save' }, 0), { code: 'STORE_CLOSED' });
  await write;
  await closing;
  const next = await SnapshotStore.open(directory);
  try {
    assert.equal((await next.read('doc')).state.saved, 'last save');
    await next.write('doc', { saved: 'recovered edit' }, 1);
    await store.close();
    await assert.rejects(SnapshotStore.open(directory), { code: 'WORKSPACE_BUSY' });
  } finally {
    await next.close();
  }
});

test('a lock left by a terminated writer is not silently taken over', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-crash-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await promisify(execFile)(process.execPath, [
    '-e', `const { SnapshotStore } = require(process.argv[1]);
      SnapshotStore.open(process.argv[2]).then(async store => {
        await store.write('doc', { saved: 'recover me' }, 0);
        process.exit(0);
      });`,
    require.resolve('../../../node/sync/store'), directory,
  ]);
  await assert.rejects(SnapshotStore.open(directory), { code: 'WORKSPACE_BUSY' });
  assert.equal((await new SnapshotStore(directory).read('doc')).state.saved, 'recover me');
});

test('competing attempts to acquire an unused workspace have exactly one winner', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-lease-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const attempts = await Promise.allSettled([SnapshotStore.open(directory), SnapshotStore.open(directory)]);
  const owners = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(owners.length, 1);
  try {
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'WORKSPACE_BUSY');
  } finally {
    await owners[0].value.close();
  }
});

test('directory aliases cannot obtain a second writer lease', async (t) => {
  const { directory } = await fixture(t);
  const alias = `${directory}-alias`;
  await fs.symlink(directory, alias, 'dir');
  t.after(() => fs.unlink(alias));
  await assert.rejects(SnapshotStore.open(alias), { code: 'WORKSPACE_BUSY' });
});

test('a replaced lock stops writes and is never removed by the old owner', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-lock-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await SnapshotStore.open(directory);
  await store.write('doc', { saved: 'safe' }, 0);
  const lock = path.join(directory, 'writer.lock');
  await fs.rename(lock, `${lock}.old`);
  await fs.writeFile(lock, 'replacement lock', { flag: 'wx' });
  await assert.rejects(store.write('doc', { saved: 'obsolete' }, 1), { code: 'WORKSPACE_LOCK_LOST' });
  await assert.rejects(store.close(), { code: 'WORKSPACE_LOCK_LOST' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'replacement lock');
  assert.equal((await new SnapshotStore(directory).read('doc')).state.saved, 'safe');
});
