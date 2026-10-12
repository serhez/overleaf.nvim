'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { SnapshotStore } = require('./store');

const MAX_BYTES = 16 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const metadata = stat => Object.fromEntries(
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].map(key => [key, String(stat[key])]),
);
const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);

async function prospectivePath(filename) {
  try {
    return await fs.realpath(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await prospectivePath(path.dirname(filename)), path.basename(filename));
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** A source-file adapter with its own recovery namespace and exclusive writer.
 * Observations are bytes, not publishable engine saves. Directory watching and
 * document identity/lifecycle decisions belong to the project coordinator.
 * Guards narrow ordinary editor races; rename is not a filesystem CAS. Source
 * directories must not be modified by a hostile process while operating here. */
class Workspace {
  static async open({ root, recovery }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(recovery)) throw new TypeError('Workspace paths must be absolute');
    root = await fs.realpath(root);
    recovery = await prospectivePath(recovery);
    if (contains(root, recovery) || contains(recovery, root)) {
      throw failure('UNSAFE_PATH', 'Recovery and source directories must be separate');
    }
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory()) throw failure('UNSAFE_PATH', 'Workspace root must be a directory');
    const owner = { format: 1, root, identity: identity(stat) };
    const store = await SnapshotStore.open(recovery);
    try {
      const recorded = await store.read('workspace');
      if (recorded && !equal(recorded.state, owner)) {
        throw failure('WORKSPACE_IDENTITY', 'Recovery belongs to a different source directory; explicit recovery is required');
      }
      if (!recorded) await store.write('workspace', owner, 0);
      return new Workspace(root, owner.identity, store);
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  constructor(root, rootIdentity, store) {
    this.root = root;
    this._rootIdentity = rootIdentity;
    this._store = store;
    this._operations = Promise.resolve();
    this._closing = null;
  }

  _name(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw failure('UNSAFE_PATH', 'Source paths must be relative and contain no aliases or traversal');
    }
    return path.join(this.root, relative);
  }

  async _parents(relative) {
    this._name(relative);
    const chain = [];
    let directory = this.root;
    for (const part of ['', ...relative.split('/').slice(0, -1)]) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', 'Source parent is not an ordinary directory');
      chain.push(identity(stat));
    }
    if (!equal(chain[0], this._rootIdentity)) throw failure('UNSAFE_PATH', 'Workspace root has been replaced');
    return chain;
  }

  async _readOnce(relative) {
    const filename = this._name(relative);
    const parents = await this._parents(relative);
    let before;
    try {
      before = await fs.lstat(filename, { bigint: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!equal(parents, await this._parents(relative))) throw failure('UNSTABLE_FILE', 'Source parents changed during observation');
      return { exists: false, parents };
    }
    if (!before.isFile() || before.nlink !== 1n) throw failure('UNSAFE_PATH', 'Source must be a regular file with one link');
    if (before.size > BigInt(MAX_BYTES)) throw failure('FILE_LIMIT', 'Source exceeds the 16 MiB automatic observation limit');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content, after;
    try {
      if (!equal(metadata(before), metadata(await handle.stat({ bigint: true })))) {
        throw failure('UNSTABLE_FILE', 'Source changed while opening it');
      }
      // An extra byte detects growth without allocating an unbounded readFile.
      content = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < content.length) {
        const read = await handle.read(content, length, content.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      content = content.subarray(0, length);
      after = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    let installed;
    try { installed = await fs.lstat(filename, { bigint: true }); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!installed || !equal(metadata(before), metadata(after))
      || !equal(metadata(after), metadata(installed)) || BigInt(content.length) !== after.size
      || !equal(parents, await this._parents(relative))) {
      throw failure('UNSTABLE_FILE', 'Source changed during observation');
    }
    return { exists: true, parents, identity: metadata(after), bytes: content.toString('base64') };
  }

  async _read(relative) {
    const first = await this._readOnce(relative);
    const second = await this._readOnce(relative);
    if (!equal(first, second)) throw failure('UNSTABLE_FILE', 'Source has not settled');
    return second;
  }

  _enqueue(operation) {
    if (this._closing) return Promise.reject(failure('WORKSPACE_CLOSED', 'Workspace is closing or closed'));
    const pending = this._operations.catch(() => {}).then(operation);
    this._operations = pending;
    return pending;
  }

  _key(relative) {
    this._name(relative);
    return JSON.stringify(['source', relative]);
  }

  _ready(record) {
    if (record?.state.pending) {
      throw failure('WORKSPACE_RECOVERY_REQUIRED', 'An interrupted source write needs explicit recovery before further changes');
    }
  }

  snapshot(relative) {
    return this._enqueue(() => this._store.read(this._key(relative)));
  }

  observe(relative) {
    return this._enqueue(async () => {
      const key = this._key(relative);
      const previous = await this._store.read(key);
      this._ready(previous);
      const observed = await this._read(relative);
      if (previous && equal(previous.state.observed, observed)) return previous;
      return this._store.write(key, { format: 1, path: relative, observed, pending: null }, previous?.revision ?? 0);
    });
  }

  write(relative, bytes, revision) {
    if (!Buffer.isBuffer(bytes)) return Promise.reject(new TypeError('Source content must be exact bytes'));
    if (bytes.length > MAX_BYTES) return Promise.reject(failure('FILE_LIMIT', 'Source exceeds the 16 MiB automatic write limit'));
    const captured = Buffer.from(bytes);
    return this._enqueue(async () => {
      const key = this._key(relative);
      const previous = await this._store.read(key);
      this._ready(previous);
      if (!previous || revision !== previous.revision) throw failure('STALE_REVISION', 'Observe the current source before replacing it');
      const expected = previous.state.observed;
      const check = async () => {
        const current = await this._read(relative);
        if (!equal(current, expected)) throw failure('STALE_FILE', 'Source changed since observation; reconcile before writing');
      };
      await check();
      await this._store._assertOwnership();
      if (expected.exists && expected.bytes === captured.toString('base64')) return previous;
      // A durable intent precedes all source-side mutations. If anything after
      // this fails, leave it pending, retaining both versions across restart.
      const intent = await this._store.write(key, {
        ...previous.state, pending: { token: randomUUID(), bytes: captured.toString('base64') },
      }, previous.revision);
      const filename = this._name(relative);
      const temporary = path.join(path.dirname(filename), `.${randomUUID()}.overleaf-tmp`);
      let temporaryIdentity;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(captured);
          if (expected.exists) {
            const original = expected.identity;
            await handle.chown(Number(original.uid), Number(original.gid));
            await handle.chmod(Number(original.mode) & 0o7777);
          }
          await handle.sync();
          temporaryIdentity = identity(await handle.stat({ bigint: true }));
        } finally {
          await handle.close();
        }
        await check();
        await this._store._assertOwnership();
        if (expected.exists) await fs.rename(temporary, filename);
        else await fs.link(temporary, filename); // Atomic creation without clobbering a new file.
        if (!expected.exists) await fs.unlink(temporary);
        await syncDirectory(path.dirname(filename));
        const observed = await this._read(relative);
        if (!observed.exists || observed.bytes !== captured.toString('base64')
          || !equal(identity(observed.identity), temporaryIdentity)) {
          throw failure('STALE_FILE', 'Source changed during installation; inspect the retained write intent');
        }
        return await this._store.write(key, { ...intent.state, observed, pending: null }, intent.revision);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  }

  close() {
    this._closing ??= (async () => {
      await this._operations.catch(() => {});
      await this._store.close();
    })();
    return this._closing;
  }
}

module.exports = { Workspace };
