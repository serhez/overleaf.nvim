'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

function encodeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('State must be a JSON object');
  }
  return JSON.stringify(state, function (key, value) {
    const original = key === '' && this[key] === state ? state : this[key];
    if (original !== null && typeof original === 'object') {
      const prototype = Object.getPrototypeOf(original);
      if (!Array.isArray(original) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('State must contain only JSON values');
      }
    }
    if (value === undefined || ['function', 'symbol', 'bigint'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError('State must contain only JSON values');
    }
    return value;
  });
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(filename, content) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Immutable recovery snapshots and atomic per-document manifests.
 * open() acquires exclusive writer ownership; the constructor is read-only.
 * A crashed writer's lock requires explicit recovery, never automatic takeover.
 */
class SnapshotStore {
  static async open(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new SnapshotStore(await fs.realpath(directory));
    try {
      store._lock = await fs.open(store._lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw failure('WORKSPACE_BUSY', `Workspace is locked: ${store._lockPath}. Verify its writer has stopped before recovering the lock.`);
      }
      throw error;
    }
    try {
      store._lockIdentity = await store._lock.stat();
      await store._lock.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token: crypto.randomUUID() }));
      await store._lock.sync();
      await syncDirectory(store.directory);
      await syncDirectory(path.dirname(store.directory));
      return store;
    } catch (error) {
      // Retain the lock if its installation failed partway through. No writer is
      // exposed, and explicit recovery can inspect the directory without races.
      await store._lock.close();
      throw error;
    }
  }

  constructor(directory) {
    this.directory = path.resolve(directory);
    this._writes = Promise.resolve();
    this._lockPath = path.join(this.directory, 'writer.lock');
    this._lock = null;
    this._closing = null;
  }

  async _assertOwnership() {
    if (!this._lock) throw failure('WORKSPACE_READ_ONLY', 'Open the recovery store as its exclusive writer before writing');
    let identity;
    try {
      identity = await fs.lstat(this._lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!identity || identity.dev !== this._lockIdentity.dev || identity.ino !== this._lockIdentity.ino) {
      throw failure('WORKSPACE_LOCK_LOST', 'Workspace lock changed; stop writing and inspect ownership');
    }
  }

  close() {
    if (this._closing) return this._closing;
    this._closing = (async () => {
      await this._writes.catch(() => {});
      if (!this._lock) return;
      try {
        await this._assertOwnership();
        await fs.unlink(this._lockPath);
        await syncDirectory(this.directory);
      } finally {
        await this._lock.close();
        this._lock = null;
      }
    })();
    return this._closing;
  }

  _manifest(id) {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('Document ID must be a nonempty string');
    return path.join(this.directory, 'documents', `${hash(id)}.json`);
  }

  async read(id) {
    const filename = this._manifest(id);
    let data;
    try {
      data = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    try {
      const manifest = JSON.parse(data);
      if (manifest.schema !== 1 || !/^[a-f0-9]{64}$/.test(manifest.snapshot)) throw new Error('Invalid manifest');
      const snapshot = await fs.readFile(path.join(this.directory, 'objects', manifest.snapshot), 'utf8');
      if (hash(snapshot) !== manifest.snapshot) throw new Error('Snapshot hash mismatch');
      const record = JSON.parse(snapshot);
      if (record.schema !== 1 || record.id !== id || !Number.isSafeInteger(record.revision) || record.revision < 1) {
        throw new Error('Invalid snapshot identity or revision');
      }
      encodeState(record.state);
      return { revision: record.revision, state: record.state };
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      throw failure('CORRUPT_STATE', `Cannot recover document ${id}: ${error.message}`);
    }
  }

  async write(id, state, expectedRevision) {
    if (this._closing) throw failure('STORE_CLOSED', 'Recovery store is closing or closed');
    if (!this._lock) throw failure('WORKSPACE_READ_ONLY', 'Open the recovery store as its exclusive writer before writing');
    const filename = this._manifest(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Expected revision must be a nonnegative safe integer with room for its successor');
    }
    // Capture before queuing: later edits must not change what this write records.
    const captured = JSON.parse(encodeState(state));
    const write = this._writes.catch(() => {}).then(async () => {
      await this._assertOwnership();
      const previous = await this.read(id);
      if ((previous?.revision ?? 0) !== expectedRevision) {
        throw failure('STALE_REVISION', `Recovery state for ${id} changed before this write`);
      }
      await fs.mkdir(path.join(this.directory, 'objects'), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await syncDirectory(this.directory);
      await syncDirectory(path.dirname(this.directory));

      const revision = expectedRevision + 1;
      const snapshot = JSON.stringify({ schema: 1, id, revision, state: captured });
      const digest = hash(snapshot);
      const objectPath = path.join(this.directory, 'objects', digest);
      let existing;
      try {
        existing = await fs.readFile(objectPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (existing !== undefined && existing !== snapshot) {
        throw failure('CORRUPT_STATE', `Recovery snapshot ${digest} is damaged`);
      }
      if (existing === undefined) await replaceFile(objectPath, snapshot);
      await this._assertOwnership();
      await replaceFile(filename, JSON.stringify({ schema: 1, snapshot: digest }));
      return { revision, state: captured };
    });
    this._writes = write;
    return write;
  }
}

module.exports = { SnapshotStore };
