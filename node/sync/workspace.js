'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const childProcess = require('node:child_process');
const { SnapshotStore } = require('./store');
const { captureEditorCheckpoint } = require('./history');

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_UNDO_BYTES = 64 * 1024 * 1024;
const UNDO_MAGIC = Buffer.from('Vim\x9fUnDo\xe5', 'latin1');
const failure = (code, message) => Object.assign(new Error(message), { code });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const metadata = stat => Object.fromEntries(
  ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].map(key => [key, String(stat[key])]),
);
const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const ROOT_BINDING = '.overleaf-workspace.json';

async function rejectOverlappingRoots(root) {
  const rejectMarker = async directory => {
    try { await fs.lstat(path.join(directory, ROOT_BINDING)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw failure('WORKSPACE_OVERLAP', 'Source directories cannot contain another workspace: ' + directory);
  };
  for (let parent = path.dirname(root); parent !== root; parent = path.dirname(parent)) {
    await rejectMarker(parent);
    if (parent === path.dirname(parent)) break;
  }
  const pending = [root];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop();
    for await (const entry of await fs.opendir(directory)) {
      if (++count > 100000) throw failure('WORKSPACE_LIMIT', 'Source inventory exceeds 100000 entries');
      if (entry.name === ROOT_BINDING && directory !== root) await rejectMarker(directory);
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
}

async function claimRoot(root, owner, recovery) {
  const filename = path.join(root, ROOT_BINDING);
  const bytes = Buffer.from(JSON.stringify({ ...owner, recovery })).toString('base64');
  const read = () => readOnce(filename, async () => [identity(await fs.lstat(root))], 16384, 'WORKSPACE_IDENTITY');
  const check = async () => {
    const current = await read();
    if (!current.exists || current.bytes !== bytes) {
      throw failure('WORKSPACE_IDENTITY', 'Source directory belongs to a different recovery location: ' + filename);
    }
    return current;
  };
  const existing = await read();
  if (existing.exists) await check();
  await rejectOverlappingRoots(root);
  let installed;
  try {
    if (!existing.exists) {
      const stage = path.join(root, `.${randomUUID()}.overleaf-binding`);
      try {
        const handle = await fs.open(stage, 'wx', 0o600);
        try {
          await handle.writeFile(Buffer.from(bytes, 'base64'));
          await handle.sync();
          const stat = await handle.stat();
          try { await fs.link(stage, filename); installed = identity(stat); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally { await handle.close(); }
      } finally { await fs.rm(stage, { force: true }); }
      await syncDirectory(root);
    }
    await check();
    // Concurrent parent/child claims must see at least one installed marker
    // before either is permitted to touch a source file.
    await rejectOverlappingRoots(root);
    return { check };
  } catch (error) {
    if (installed && equal(installed, identity(await fs.lstat(filename)))) {
      await fs.unlink(filename);
      await syncDirectory(root);
    }
    throw error;
  }
}

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

async function undoParents(filename) {
  const root = path.parse(filename).root;
  let directory = root;
  const chain = [];
  for (const part of ['', ...path.relative(root, path.dirname(filename)).split(path.sep).filter(Boolean)]) {
    directory = path.join(directory, part);
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory()) throw failure('UNSAFE_UNDO', 'Undo parent must be an ordinary directory');
    chain.push(identity(stat));
  }
  return chain;
}

function captureUndo(undo) {
  if (undo === undefined || undo === null) return undo;
  if (!undo || typeof undo.path !== 'string' || !path.isAbsolute(undo.path)
    || path.normalize(undo.path) !== undo.path || undo.path.includes('\0')
    || (!Buffer.isBuffer(undo.bytes) && undo.bytes !== null)) throw failure('UNSAFE_UNDO', 'Undo needs an absolute path and exact bytes or null');
  if (undo.bytes && undo.bytes.length > MAX_UNDO_BYTES) throw failure('FILE_LIMIT', 'Undo exceeds the 64 MiB limit');
  if (undo.bytes && !undo.bytes.subarray(0, UNDO_MAGIC.length).equals(UNDO_MAGIC)) throw failure('UNSAFE_UNDO', 'Candidate is not a native undo file');
  return {
    path: undo.path, bytes: undo.bytes === null ? null : Buffer.from(undo.bytes),
    ...(undo.checkpoint ? { checkpoint: captureEditorCheckpoint(undo.checkpoint) } : {}),
  };
}

async function readOnce(filename, parentsFor, limit, unsafe = 'UNSAFE_PATH') {
  const parents = await parentsFor();
  let before;
  try {
    before = await fs.lstat(filename, { bigint: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!equal(parents, await parentsFor())) throw failure('UNSTABLE_FILE', 'Source parents changed during observation');
    return { exists: false, parents };
  }
  if (!before.isFile() || before.nlink !== 1n) throw failure(unsafe, 'File must be a regular file with one link');
  if (before.size > BigInt(limit)) throw failure('FILE_LIMIT', 'File exceeds the automatic observation limit');
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
    || !equal(parents, await parentsFor())) {
    throw failure('UNSTABLE_FILE', 'Source changed during observation');
  }
  return { exists: true, parents, identity: metadata(after), bytes: content.toString('base64') };
}

async function readStable(filename, parentsFor, limit, unsafe) {
  const first = await readOnce(filename, parentsFor, limit, unsafe);
  const second = await readOnce(filename, parentsFor, limit, unsafe);
  if (!equal(first, second)) throw failure('UNSTABLE_FILE', 'File has not settled');
  return second;
}

function captureBackups(backups) {
  if (backups === undefined) return [];
  if (!Array.isArray(backups) || backups.length > 2) throw failure('UNSAFE_BACKUP', 'At most a backup and an original are supported');
  const seen = new Set();
  return backups.map(item => {
    if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)
      || path.normalize(item.path) !== item.path || item.path.includes('\0')
      || typeof item.once !== 'boolean' || seen.has(item.path)) {
      throw failure('UNSAFE_BACKUP', 'Backup needs a distinct absolute path and explicit retention policy');
    }
    seen.add(item.path);
    return { path: item.path, once: item.once };
  });
}

async function installFile(filename, captured, expected, read, assertOwnership, preserveMode, metadataSource) {
  const check = async () => {
    if (!equal(await read(), expected)) throw failure('STALE_FILE', 'File changed since observation; reconcile before writing');
  };
  await check();
  await assertOwnership();
  if (captured === null) {
    if (expected.exists) {
      await fs.unlink(filename);
      await syncDirectory(path.dirname(filename));
    }
    const observed = await read();
    if (observed.exists || !equal(observed.parents, expected.parents)) throw failure('STALE_FILE', 'Undo destination changed during removal');
    return observed;
  }
  if (expected.exists && expected.bytes === captured.toString('base64')) return expected;
  const temporary = path.join(path.dirname(filename), `.${randomUUID()}.overleaf-tmp`);
  const attributes = metadataSource?.observed ?? expected;
  let temporaryIdentity;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      if (preserveMode && attributes.exists) {
        // Native copies retain ACLs and extended attributes which Node's file
        // APIs cannot enumerate. Only the private stage is changed; recheck the
        // original observation before installing it. Explicit GNU attributes
        // make preservation failures fatal (unlike --preserve=all).
        const args = process.platform === 'darwin' ? ['-p']
          : process.platform === 'linux' ? ['--attributes-only', '--preserve=mode,ownership,xattr'] : null;
        if (!args) throw failure('METADATA_UNSUPPORTED', 'Source metadata preservation requires macOS or GNU cp on Linux');
        try {
          await new Promise((resolve, reject) => childProcess.execFile('/bin/cp', [...args, metadataSource?.filename ?? filename, temporary],
            { timeout: 10000, maxBuffer: 65536 }, error => error ? reject(error) : resolve()));
        } catch (error) {
          throw failure('METADATA_COPY_FAILED', 'Cannot preserve source metadata: ' + error.message);
        }
        if (!equal(identity(await handle.stat({ bigint: true })), identity(await fs.lstat(temporary, { bigint: true })))) {
          throw failure('STALE_FILE', 'Metadata copy replaced its private staging file');
        }
        await handle.truncate(0);
      }
      await handle.writeFile(captured);
      if (preserveMode && attributes.exists) {
        const original = attributes.identity;
        await handle.chown(Number(original.uid), Number(original.gid));
        await handle.chmod(Number(original.mode) & 0o7777);
      }
      await handle.sync();
      temporaryIdentity = identity(await handle.stat({ bigint: true }));
    } finally { await handle.close(); }
    await check();
    await assertOwnership();
    if (expected.exists) await fs.rename(temporary, filename);
    else await fs.link(temporary, filename); // Atomic creation without clobbering a new file.
    if (!expected.exists) await fs.unlink(temporary);
    await syncDirectory(path.dirname(filename));
    const observed = await read();
    if (!observed.exists || observed.bytes !== captured.toString('base64')
      || !equal(identity(observed.identity), temporaryIdentity) || !equal(observed.parents, expected.parents)) {
      throw failure('STALE_FILE', 'File changed during installation; inspect the retained write intent');
    }
    return observed;
  } finally { await fs.rm(temporary, { force: true }); }
}

/** A source-file adapter with its own recovery namespace and exclusive writer.
 * Observations are bytes, not publishable engine saves. Directory watching and
 * document identity/lifecycle decisions belong to the project coordinator.
 * Guards narrow ordinary editor races; rename is not a filesystem CAS. Source
 * directories must not be modified by a hostile process while operating here. */
class Workspace {
  static async inventoryLegacy(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Choose an absolute legacy directory');
    const root = await fs.realpath(directory), entries = [], pending = [root];
    while (pending.length) {
      const parent = pending.pop();
      for await (const entry of await fs.opendir(parent)) {
        if (entries.length >= 10000) throw failure('MIGRATION_LIMIT', 'Legacy inventory exceeds 10000 entries; choose a smaller directory');
        const filename = path.join(parent, entry.name);
        const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : 'other';
        entries.push({ path: path.relative(root, filename), filename, type });
        if (entry.isDirectory()) pending.push(filename);
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { root, entries };
  }

  static async readLegacy(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.normalize(filename) !== filename) {
      throw new TypeError('Choose an absolute legacy file without aliases');
    }
    const observed = await readStable(filename, () => undoParents(filename), MAX_BYTES);
    if (!observed.exists) throw failure('MISSING_SOURCE', 'Legacy source no longer exists');
    return { kind: 'file', filename, observed };
  }

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
      const binding = await claimRoot(root, owner, store.directory);
      if (!recorded) await store.write('workspace', owner, 0);
      return new Workspace(root, owner.identity, store, binding);
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  constructor(root, rootIdentity, store, binding) {
    this.root = root;
    this._rootIdentity = rootIdentity;
    this._store = store;
    this._binding = binding;
    this._operations = Promise.resolve();
    this._closing = null;
  }

  _name(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..' || part === ROOT_BINDING)) {
      throw failure('UNSAFE_PATH', 'Source paths must be relative and contain no aliases or traversal');
    }
    return path.join(this.root, relative);
  }

  async _parents(relative, create = false) {
    this._name(relative);
    await this._binding.check();
    const chain = [];
    let directory = this.root;
    for (const part of ['', ...relative.split('/').slice(0, -1)]) {
      directory = path.join(directory, part);
      let stat;
      try { stat = await fs.lstat(directory, { bigint: true }); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create || directory === this.root) throw error;
        // Parents are visited individually, so no recursive mkdir can follow
        // an unchecked link supplied by the remote path.
        try { await fs.mkdir(directory); }
        catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        stat = await fs.lstat(directory, { bigint: true });
        await syncDirectory(path.dirname(directory));
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', 'Source parent is not an ordinary directory');
      if (directory === this.root && !equal(identity(stat), this._rootIdentity)) throw failure('UNSAFE_PATH', 'Workspace root has been replaced');
      chain.push(identity(stat));
    }
    return chain;
  }

  async _readOnce(relative) {
    return readOnce(this._name(relative), () => this._parents(relative), MAX_BYTES);
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

  bindings() {
    return this._enqueue(async () => structuredClone((await this._store.read('bindings'))?.state.entries ?? []));
  }

  async _relocationTarget(relative, entries, document) {
    const filename = this._name(relative);
    if (entries.some(entry => entry.path === relative && entry.document !== document)) {
      throw failure('PATH_BOUND', 'Relocation target belongs to another document');
    }
    if (await this._store.read(JSON.stringify(['undo', filename])) || await this._store.read(JSON.stringify(['backup', filename]))) {
      throw failure('UNSAFE_PATH', 'Relocation target belongs to a save artifact');
    }
    let observed;
    try { observed = await this._read(relative); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      observed = { exists: false, parents: null };
    }
    return { record: await this._store.read(this._key(relative)), observed };
  }

  reviewRelocation(document, to) {
    return this._enqueue(async () => {
      const entries = (await this._store.read('bindings'))?.state.entries ?? [];
      const binding = entries.find(entry => entry.document === document);
      if (!binding) throw failure('PATH_BOUND', 'Document has no source binding');
      if (binding.path === to) throw failure('PATH_BOUND', 'Source already uses this path');
      const target = await this._relocationTarget(to, entries, document);
      const source = { record: await this._store.read(this._key(binding.path)), observed: await this._read(binding.path) };
      return { document, from: binding.path, to, binding, source, target,
        pending: await this._store.read(JSON.stringify(['relocation', document])) };
    });
  }

  relocation(document) {
    return this._enqueue(async () => {
      const record = await this._store.read(JSON.stringify(['relocation', document]));
      if (!record) return null;
      const bindings = (await this._store.read('bindings'))?.state.entries ?? [];
      return { ...record, bound: bindings.some(entry => entry.document === document
        && entry.path === record.state.review.to && entry.relocation === record.state.token) };
    });
  }

  /** Copy an explicitly reviewed source to a new path, then transfer its
   * identity. The old source and undo remain intact. A journal plus the binding
   * token proves which side of an interrupted binding publication completed. */
  relocate(inspection) {
    const captured = structuredClone(inspection);
    return this._enqueue(async () => {
      const { document, from, to, pending, ...details } = captured;
      this._name(from); this._name(to);
      if (typeof document !== 'string' || !document || from === to) throw new TypeError('Distinct reviewed source paths are required');
      const key = JSON.stringify(['relocation', document]);
      let journal = await this._store.read(key);
      if (!equal(journal, pending)) throw failure('STALE_RELOCATION', 'Inspect the current relocation before retrying');
      const bindings = await this._store.read('bindings');
      const binding = bindings?.state.entries.find(entry => entry.document === document);
      if (!binding || !equal(binding, captured.binding) || binding.path !== from) throw failure('PATH_BOUND', 'Source binding changed after review');
      const guard = async () => {
        await this._store._assertOwnership();
        if (!equal(await this._read(from), captured.source.observed)) throw failure('STALE_FILE', 'Source changed after relocation review');
      };
      await guard();
      const source = await this._store.read(this._key(from));
      if (!equal(source, captured.source.record)) throw failure('STALE_REVISION', 'Source history changed after relocation review');
      this._ready(source);
      if (!captured.source.observed.exists) throw failure('MISSING_SOURCE', 'Restore the source before relocating it');
      const target = await this._relocationTarget(to, bindings.state.entries, document);
      this._ready(target.record);
      const resuming = journal?.state.phase === 'copied' && journal.state.review.from === from && journal.state.review.to === to
        && equal(journal.state.review.source.observed, captured.source.observed) && equal(journal.state.installed, target.observed);
      if (!resuming) {
        if (target.observed.exists) throw failure('TARGET_EXISTS', 'Relocation target already exists; retain or move it before retrying');
        if (!equal(target.record, captured.target.record)) throw failure('STALE_REVISION', 'Destination history changed after review');
        await this._parents(to, true);
        const before = await this._read(to);
        if (before.exists) throw failure('TARGET_EXISTS', 'Relocation target appeared during review');
        journal = await this._store.write(key, { token: randomUUID(), phase: 'prepared',
          review: { document, from, to, ...details }, installed: null }, journal?.revision ?? 0);
        const installed = await installFile(this._name(to), Buffer.from(captured.source.observed.bytes, 'base64'),
          before, () => this._read(to), guard, true, { filename: this._name(from), observed: captured.source.observed });
        journal = await this._store.write(key, { ...journal.state, phase: 'copied', installed }, journal.revision);
      }
      await guard();
      if (!equal(await this._read(to), journal.state.installed)) throw failure('STALE_FILE', 'Copied source changed before binding publication');
      await this._store.write(this._key(to), { format: 1, path: to, observed: journal.state.installed,
        pending: null, undo: null, relocation: journal.state.token,
        recovery: target.record?.state.relocation === journal.state.token ? target.record.state.recovery : target.record?.state ?? null }, target.record?.revision ?? 0);
      await guard();
      if (!equal(await this._read(to), journal.state.installed)) throw failure('STALE_FILE', 'Copied source changed before binding publication');
      const entries = bindings.state.entries.map(entry => entry.document === document
        ? { ...entry, path: to, relocation: journal.state.token } : entry);
      await this._store.write('bindings', { entries }, bindings.revision);
      journal = await this._store.write(key, { ...journal.state, phase: 'bound' }, journal.revision);
      return { ...journal, bound: true };
    });
  }

  bind(relative, document, kind = 'doc') {
    return this._enqueue(async () => {
      const filename = this._name(relative);
      if (typeof document !== 'string' || !document.length) throw new TypeError('Document identity is required');
      if (!['doc', 'asset'].includes(kind)) throw new TypeError('Unsupported source kind');
      const previous = await this._store.read('bindings');
      const entries = previous?.state.entries ?? [];
      for (const entry of entries) {
        if ((entry.document === document || entry.path === relative)
          && (entry.document !== document || entry.path !== relative || (entry.kind ?? 'doc') !== kind)) {
          throw failure('PATH_BOUND', 'Document paths require explicit rename or identity recovery');
        }
      }
      if (await this._store.read(JSON.stringify(['undo', filename])) || await this._store.read(JSON.stringify(['backup', filename]))) {
        throw failure('UNSAFE_PATH', 'Source path belongs to a reserved save artifact');
      }
      await this._parents(relative, true);
      try {
        if (await fs.realpath(filename) !== filename) throw failure('UNSAFE_PATH', 'Source path is an alias');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (entries.some(entry => entry.document === document)) return;
      entries.push({ document, path: relative, ...(kind === 'asset' ? { kind } : {}) });
      await this._store.write('bindings', { entries }, previous?.revision ?? 0);
    });
  }

  /** Recovery inspection never clears an intent or adopts its current file. */
  inspect(relative) {
    return this._enqueue(async () => {
      const record = await this._store.read(this._key(relative));
      const observed = await this._read(relative);
      const paths = new Map();
      const add = (item, kind) => { if (item) paths.set(item.path, kind); };
      for (const state of [record?.state, record?.state.recovery]) {
        add(state?.undo, 'undo');
        add(state?.pending?.undo, 'undo');
        for (const item of state?.pending?.backups ?? []) add(item, 'backup');
      }
      const artifacts = [];
      for (const [filename, kind] of paths) {
        try {
          artifacts.push({ path: filename, kind, observed: await readStable(filename, () => undoParents(filename),
            kind === 'undo' ? MAX_UNDO_BYTES : MAX_BYTES, kind === 'undo' ? 'UNSAFE_UNDO' : 'UNSAFE_BACKUP') });
        } catch (error) {
          artifacts.push({ path: filename, kind, error: { code: error.code ?? 'READ_ERROR', message: error.message } });
        }
      }
      return { record, observed, artifacts };
    });
  }

  /** Explicitly adopt an inspected current source. This never installs a
   * candidate, removes an artifact, or infers that an interrupted write won. */
  recover(relative, inspection) {
    const captured = structuredClone(inspection);
    return this._enqueue(async () => {
      const key = this._key(relative);
      const previous = await this._store.read(key);
      if (!previous || previous.revision !== captured?.record?.revision) {
        throw failure('STALE_REVISION', 'Inspect the current recovery record before adopting the source');
      }
      const observed = await this._read(relative);
      if (!equal(observed, captured.observed)) throw failure('STALE_FILE', 'Source changed after recovery inspection');
      if (!observed.exists) throw failure('MISSING_SOURCE', 'Restore the missing source before adopting its contents');
      return this._store.write(key, {
        ...previous.state, observed, pending: null, undo: null,
        recovery: {
          choice: 'keep-current', revision: previous.revision,
          observed: previous.state.observed, pending: previous.state.pending, undo: previous.state.undo ?? null,
        },
      }, previous.revision);
    });
  }

  observe(relative) {
    return this._enqueue(async () => {
      const key = this._key(relative);
      const previous = await this._store.read(key);
      this._ready(previous);
      const observed = await this._read(relative);
      if (previous && equal(previous.state.observed, observed)) return previous;
      return this._store.write(key, { ...previous?.state, format: 1, path: relative, observed, pending: null }, previous?.revision ?? 0);
    });
  }

  write(relative, bytes, revision, undo, backups) {
    if (!Buffer.isBuffer(bytes)) return Promise.reject(new TypeError('Source content must be exact bytes'));
    if (bytes.length > MAX_BYTES) return Promise.reject(failure('FILE_LIMIT', 'Source exceeds the 16 MiB automatic write limit'));
    const captured = Buffer.from(bytes);
    let history, copies;
    try { history = captureUndo(undo); copies = captureBackups(backups); } catch (error) { return Promise.reject(error); }
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
      let undoBefore;
      const readUndo = history && (() => readStable(history.path, () => undoParents(history.path), MAX_UNDO_BYTES, 'UNSAFE_UNDO'));
      if (history) {
        const bindings = await this._store.read('bindings');
        if (history.path === this._name(relative) || contains(this._store.directory, history.path)
          || bindings?.state.entries.some(entry => this._name(entry.path) === history.path)
          || await this._store.read(JSON.stringify(['backup', history.path]))) {
          throw failure('UNSAFE_UNDO', 'Undo destination overlaps a source or recovery file');
        }
        undoBefore = await readUndo();
        if (undoBefore.exists && !Buffer.from(undoBefore.bytes, 'base64').subarray(0, UNDO_MAGIC.length).equals(UNDO_MAGIC)) {
          throw failure('UNSAFE_UNDO', 'Existing destination is not a native undo file');
        }
        if (previous.state.undo?.path === history.path && !equal(previous.state.undo.observed, undoBefore)) {
          throw failure('STALE_UNDO', 'Persistent undo changed outside this workspace; reconcile before saving');
        }
        const ownerKey = JSON.stringify(['undo', history.path]);
        const undoOwner = await this._store.read(ownerKey);
        if (undoOwner && undoOwner.state.source !== relative) throw failure('UNSAFE_UNDO', 'Undo destination belongs to another source');
        if (!undoOwner) await this._store.write(ownerKey, { format: 1, source: relative, path: history.path }, 0);
      } else if (history !== null && previous.state.undo && (!expected.exists || expected.bytes !== captured.toString('base64'))) {
        throw failure('UNDO_REQUIRED', 'Source replacement requires its persistent undo artifact');
      }
      const readBackup = filename => readStable(filename, () => undoParents(filename), MAX_BYTES, 'UNSAFE_BACKUP');
      const bindings = copies.length ? await this._store.read('bindings') : null;
      const prepared = [];
      for (const item of copies) {
        if (item.path === this._name(relative) || item.path === history?.path || contains(this._store.directory, item.path)
          || bindings?.state.entries.some(entry => this._name(entry.path) === item.path)
          || await this._store.read(JSON.stringify(['undo', item.path]))) {
          throw failure('UNSAFE_BACKUP', 'Backup overlaps a source, undo, or recovery destination');
        }
        let before;
        try { before = await readBackup(item.path); }
        catch (error) {
          if (error.code === 'UNSAFE_UNDO') throw failure('UNSAFE_BACKUP', error.message);
          throw error;
        }
        const ownerKey = JSON.stringify(['backup', item.path]);
        const owner = await this._store.read(ownerKey);
        if (owner && owner.state.source !== relative) throw failure('UNSAFE_BACKUP', 'Backup belongs to another source');
        prepared.push({ ...item, before, bytes: expected.bytes ?? '' });
      }
      for (const item of prepared) {
        const key = JSON.stringify(['backup', item.path]);
        if (!await this._store.read(key)) await this._store.write(key, { format: 1, source: relative, path: item.path }, 0);
      }
      if (!prepared.length && !history && !(history === null && previous.state.undo) && expected.exists && expected.bytes === captured.toString('base64')) return previous;
      // A durable intent retains both artifacts before either destination can
      // change. Two files cannot be replaced atomically; partial completion is
      // preserved for explicit recovery, never inferred or blindly retried.
      let intent = await this._store.write(key, {
        ...previous.state, pending: {
          token: randomUUID(), bytes: captured.toString('base64'),
          ...(history === null ? { undoDisabled: true } : {}),
          ...(prepared.length ? { backups: prepared } : {}),
          ...(history ? { undo: { path: history.path, before: undoBefore, bytes: history.bytes?.toString('base64') ?? null,
            ...(history.checkpoint ? { checkpoint: history.checkpoint } : {}) } } : {}),
        },
      }, previous.revision);
      // Recheck the undo destination before touching the source, including an
      // edit that arrived while persisting the intent or staging the source.
      const sourceGuard = async () => {
        await this._store._assertOwnership();
        if (history && !equal(await readUndo(), undoBefore)) throw failure('STALE_UNDO', 'Undo destination changed before saving');
        for (const item of prepared) {
          if (!equal(await readBackup(item.path), item.installed ?? item.before)) {
            throw failure('STALE_FILE', 'Backup changed during save preparation');
          }
        }
      };
      for (const item of prepared) {
        await check();
        await sourceGuard();
        item.installed = item.once && item.before.exists ? item.before
          : await installFile(item.path, Buffer.from(item.bytes, 'base64'), item.before,
            () => readBackup(item.path), async () => { await check(); await sourceGuard(); }, false);
        intent = await this._store.write(key, {
          ...intent.state, pending: { ...intent.state.pending, backups: prepared },
        }, intent.revision);
      }
      const observed = await installFile(this._name(relative), captured, expected, () => this._read(relative), sourceGuard, true);
      let completion = intent;
      let installedUndo;
      if (history) {
        completion = await this._store.write(key, {
          ...intent.state, pending: { ...intent.state.pending, sourceInstalled: observed },
        }, intent.revision);
        const undoGuard = async () => {
          await this._store._assertOwnership();
          if (!equal(await this._read(relative), observed)) throw failure('STALE_FILE', 'Source changed before undo publication');
        };
        const undoObserved = await installFile(history.path, history.bytes, undoBefore, readUndo, undoGuard, false);
        installedUndo = { path: history.path, observed: undoObserved,
          ...(history.checkpoint ? { checkpoint: history.checkpoint } : {}) };
        if (!equal(await this._read(relative), observed)) throw failure('STALE_FILE', 'Source changed during undo publication');
      }
      return this._store.write(key, {
        ...completion.state, observed, pending: null,
        ...(installedUndo ? { undo: installedUndo } : history === null ? { undo: null } : {}),
      }, completion.revision);
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
