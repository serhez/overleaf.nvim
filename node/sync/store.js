'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const RETAINED_SNAPSHOTS = 32;

function writerState(owner) {
  if (owner.host !== os.hostname()) return 'unknown';
  try { process.kill(owner.pid, 0); return 'active'; }
  catch (error) {
    if (error.code === 'ESRCH') return 'stale';
    return error.code === 'EPERM' ? 'active' : 'unknown';
  }
}

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
    const busy = () => failure('WORKSPACE_BUSY', `Workspace is locked: ${store._lockPath}. Inspect its writer before explicit recovery.`);
    try { await fs.lstat(store._lockPath); throw busy(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    store._owner = { pid: process.pid, host: os.hostname(), token: crypto.randomUUID() };
    const stage = path.join(store.directory, `.writer-${store._owner.token}`);
    let installed = false;
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      store._lock = await fs.open(path.join(stage, 'owner.json'), 'wx', 0o600);
      await store._lock.writeFile(JSON.stringify(store._owner));
      await store._lock.sync();
      await syncDirectory(stage);
      store._lockIdentity = identity(await fs.lstat(stage));
      // A public lock is always a nonempty directory. POSIX rename cannot
      // replace another nonempty lock, giving acquisition atomic exclusion.
      try { await fs.rename(stage, store._lockPath); }
      catch (error) {
        if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
          throw busy();
        }
        throw error;
      }
      installed = true;
      await syncDirectory(store.directory);
      await syncDirectory(path.dirname(store.directory));
      return store;
    } catch (error) {
      await store._lock?.close();
      if (!installed) {
        await fs.rm(path.join(stage, 'owner.json'), { force: true });
        await fs.rmdir(stage);
      }
      // A published lock remains available if flushing its installation failed.
      throw error;
    }
  }

  static async inspectLock(directory) {
    directory = await fs.realpath(directory);
    const result = { directory, workspace: identity(await fs.lstat(directory)), state: 'unknown', owner: null, lock: null };
    const filename = path.join(directory, 'writer.lock');
    let stat;
    try { stat = await fs.lstat(filename); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...result, state: 'unlocked' };
    }
    result.lock = identity(stat);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...result, reason: 'unrecognized-lock' };
    let handle;
    try {
      handle = await fs.open(path.join(filename, 'owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4096) throw new Error('Invalid owner metadata');
      const bytes = Buffer.alloc(metadata.size + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== metadata.size) throw new Error('Owner metadata changed');
      const owner = JSON.parse(bytes.subarray(0, read.bytesRead));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647
        || typeof owner.host !== 'string' || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)) {
        throw new Error('Invalid owner metadata');
      }
      result.owner = owner;
      result.state = writerState(owner);
    } catch (_) { result.reason = 'unreadable-owner'; }
    finally { await handle?.close(); }
    if (!equal(result.lock, identity(await fs.lstat(filename)))) throw failure('LOCK_CHANGED', 'Writer changed during inspection');
    return result;
  }

  static async recoverLock(review) {
    if (!review || typeof review.directory !== 'string' || !path.isAbsolute(review.directory)) throw new TypeError('An inspected lock is required');
    const current = await SnapshotStore.inspectLock(review.directory);
    if (!equal(current, review)) throw failure('LOCK_CHANGED', 'Writer changed after inspection; inspect it again');
    if (current.state === 'active') throw failure('WRITER_ACTIVE', 'The local writer is still running');
    if (current.state !== 'stale') throw failure('OWNER_UNKNOWN', 'The writer cannot be confirmed stopped on this host');
    const retained = path.join(current.directory, `.recovered-${current.owner.token}`);
    try {
      // The deterministic, nonempty destination makes competing recovery
      // attempts fail atomically, even if a new writer acquired the source name
      // after this attempt's inspection. Retain it permanently as that barrier.
      await fs.rename(path.join(current.directory, 'writer.lock'), retained);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw failure('LOCK_CHANGED', 'Writer was already recovered or changed');
      throw error;
    }
    await syncDirectory(current.directory);
    return { directory: current.directory, retained };
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
    let stat;
    try {
      stat = await fs.lstat(this._lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!stat || !equal(identity(stat), this._lockIdentity)) {
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
        const retired = path.join(this.directory, `.closed-${this._owner.token}`);
        await fs.rename(this._lockPath, retired);
        await syncDirectory(this.directory);
        await fs.unlink(path.join(retired, 'owner.json'));
        await fs.rmdir(retired);
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
      const manifest = previous ? JSON.parse(await fs.readFile(filename, 'utf8')) : null;
      const history = manifest ? [manifest.snapshot, ...(manifest.history ?? [])] : [];
      if (history.length > RETAINED_SNAPSHOTS || history.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        || new Set(history).size !== history.length) throw failure('CORRUPT_STATE', 'Invalid retained snapshot manifest');
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
      await replaceFile(filename, JSON.stringify({ schema: 1, snapshot: digest,
        history: history.slice(0, RETAINED_SNAPSHOTS - 1) }));
      // Only a committed manifest can retire snapshots it previously named.
      // Never sweep unrelated objects: an orphan may be a failed commit whose
      // saved work is still needed for manual recovery.
      for (const expired of history.slice(RETAINED_SNAPSHOTS - 1)) {
        try { await this._prune(expired, id, expectedRevision); }
        catch (error) {
          if (!this._pruneWarning) {
            this._pruneWarning = true;
            console.error('Overleaf snapshot cleanup held; old snapshots retained:', error.code ?? 'CLEANUP_FAILED');
          }
        }
      }
      return { revision, state: captured };
    });
    this._writes = write;
    return write;
  }

  async _prune(digest, id, revision) {
    await this._assertOwnership();
    const filename = path.join(this.directory, 'objects', digest);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let before;
    try {
      before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw failure('CORRUPT_STATE', 'Invalid snapshot object');
      const content = await handle.readFile('utf8');
      const record = JSON.parse(content);
      if (hash(content) !== digest || record.schema !== 1 || record.id !== id
        || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > revision) {
        throw failure('CORRUPT_STATE', 'Retained snapshot identity changed');
      }
    } finally { await handle.close(); }
    const current = await fs.lstat(filename, { bigint: true });
    if (!equal(identity(before), identity(current)) || before.ctimeNs !== current.ctimeNs
      || before.size !== current.size || current.nlink !== 1n) throw failure('CORRUPT_STATE', 'Retained snapshot changed');
    await this._assertOwnership();
    await fs.unlink(filename);
    await syncDirectory(path.dirname(filename));
  }
}

module.exports = { SnapshotStore };
