'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { watch, constants } = require('node:fs');
const { access, realpath, readdir, mkdir, mkdtemp, writeFile, lstat, open, rm } = require('node:fs/promises');
const { isDeepStrictEqual: equal } = require('node:util');
const { SnapshotStore } = require('./store');
const { DocumentEngine } = require('./engine');
const { decodeBytes, editorText } = require('./codec');
const { captureEditorCheckpoint, rebaseEditorHistory, currentText, persistentView } = require('./history');
const { Workspace } = require('./workspace');
const { DocumentTransport } = require('./transport');
const { diff, updateComments, bytePosition, mapCursor } = require('./ot');

const failure = (code, message) => Object.assign(new Error(message), { code });
const actions = new Set(['open', 'state', 'snapshot', 'remote', 'checkpoint', 'save', 'prepare', 'accept', 'hold', 'scan', 'diskState', 'write', 'writeDiskUndo', 'holdDiskUndo', 'recoverDisk', 'prepareReattach', 'acceptReattach', 'useEditor', 'prepareHistoryResolution', 'prepareConflictResolution', 'prepareDiskUndoResolution', 'reviewRelocation', 'relocate', 'reviewLifecycle', 'keepLocal', 'keepUncertainLocal', 'archiveLocal', 'features', 'captures', 'importBranch', 'stageComment', 'confirmComment', 'reanchorComment']);
const diskOptions = { fileformat: 'unix', fileencoding: 'utf-8', binary: false, endofline: false, fixendofline: false, bomb: false };
const diskText = observed => observed.exists
  ? editorText(decodeBytes(Buffer.from(observed.bytes, 'base64'), diskOptions)) : null;
const retainedPath = (document, source) => {
  const extension = path.posix.extname(source);
  return source.slice(0, source.length - extension.length) + '.local-' + createHash('sha256').update(document).digest('hex').slice(0, 12) + extension;
};

function cleanEditor(state) {
  if (!state.editor || !state.disk || state.editor.pending || state.editor.recovery || state.editor.held
    || state.disk.pending || state.disk.held) return false;
  try { return currentText(state.editor.checkpoint, { forWrite: true }) === state.disk.content; }
  catch { return false; }
}

function capturePersistentUndo(undo, checkpoint) {
  if (undo === undefined || undo === null) return undo;
  const captured = captureEditorCheckpoint(undo.checkpoint ?? checkpoint);
  if (undo.checkpoint) {
    const expected = persistentView(checkpoint);
    if (!equal(captured.history, expected.history) || !equal(captured.options, expected.options)) {
      throw failure('INVALID_UNDO', 'Persistent readback history differs from the frozen save');
    }
  }
  if (!undo || typeof undo.path !== 'string') throw failure('INVALID_UNDO', 'Persistent undo needs a destination');
  const encoded = undo.bytes;
  if (encoded === null && captured.undo === null) return { path: undo.path, bytes: null, checkpoint: captured };
  if (captured.undo === null || typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(64 * 1024 * 1024 / 3)) {
    throw failure('INVALID_UNDO', 'Persistent undo must match the captured history');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const content = captured.history.nodes.find(node => node.seq === captured.history.current).content;
  const lines = content.split('\n');
  const hash = createHash('sha256');
  const emptyReadback = undo.checkpoint && captured.history.nodes.find(node => node.seq === captured.history.current).empty;
  if (!emptyReadback) for (const line of lines) hash.update(line + '\0');
  if (undo.checkpoint) {
    const native = Buffer.from(captured.undo, 'base64');
    if (emptyReadback && native.length >= 43) createHash('sha256').digest().copy(native, 11);
    if (!native.equals(bytes)) throw failure('INVALID_UNDO', 'Persistent bytes differ from the verified native checkpoint');
  }
  // Native undo hashes buffer lines including their terminating NUL, excluding
  // BOM and file line separators. Lua verifies the entire native tree; this
  // boundary also refuses an export belonging to a different saved snapshot.
  if (bytes.toString('base64') !== encoded || bytes.length < 47
    || !bytes.subarray(0, 11).equals(Buffer.from('Vim\x9fUnDo\xe5\0\x03', 'latin1'))
    || !bytes.subarray(11, 43).equals(hash.digest()) || bytes.readUInt32BE(43) !== lines.length) {
    throw failure('INVALID_UNDO', 'Persistent undo does not match the captured buffer text');
  }
  return { path: undo.path, bytes, checkpoint: captured };
}

const undoProposal = pending => ({
  status: 'undo-required', token: pending.token, content: pending.content,
  path: pending.undo.path, checkpoint: pending.undo.checkpoint, bytes: pending.undo.bytes,
  history: pending.undo.history,
});

function location({ root, server, projectId }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)
    || typeof projectId !== 'string' || !projectId.length) throw new TypeError('Recovery root and project ID are required');
  const url = new URL(server);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Server must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  server = url.href.replace(/\/+$/, '');
  const key = createHash('sha256').update(JSON.stringify([server, projectId])).digest('hex');
  return { directory: path.join(root, key), server };
}

/** One project writer, with per-document ordering and a process-local identity.
 * Optional sourceRoot enables guarded workspace coordination. Network waits
 * stay outside the local document queue; transport transitions enter it. */
class SyncSession {
  static locate(params) { return location(params); }

  static async listProjects({ root, server }) {
    const normalized = location({ root, server, projectId: 'catalog' }).server;
    let directory;
    try { directory = await realpath(root); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const projects = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const store = new SnapshotStore(path.join(directory, entry.name));
      const identity = (await store.read(JSON.stringify(['identity'])))?.state;
      if (!identity || identity.server !== normalized
        || path.basename(location({ root, ...identity }).directory) !== entry.name) continue;
      const project = (await store.read(JSON.stringify(['project'])))?.state;
      if (!project) continue;
      const workspace = await new SnapshotStore(path.join(store.directory, 'workspace')).read('workspace');
      projects.push({ ...identity, name: project.name, sourceRoot: workspace?.state.root ?? null });
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
  }

  static async open({ root, server, projectId, sourceRoot }, onChange = () => {}) {
    const target = location({ root, server, projectId });
    const store = await SnapshotStore.open(target.directory);
    let workspace;
    try {
      workspace = sourceRoot === undefined ? null
        : await Workspace.open({ root: sourceRoot, recovery: path.join(store.directory, 'workspace') });
      const identity = { server: target.server, projectId };
      const recorded = await store.read(JSON.stringify(['identity']));
      if (recorded && !equal(recorded.state, identity)) throw failure('WORKSPACE_IDENTITY', 'Recovery belongs to another project');
      if (!recorded) await store.write(JSON.stringify(['identity']), identity, 0);
      const session = new SyncSession(store, workspace, onChange);
      session.server = target.server;
      session.projectId = projectId;
      session._setProject((await store.read(JSON.stringify(['project'])))?.state ?? null);
      return session;
    } catch (error) {
      await Promise.allSettled([workspace?.close(), store.close()]);
      throw error;
    }
  }

  static async inspectLocks(params) {
    const target = location(params);
    const result = { directory: target.directory, locks: [] };
    for (const label of ['project', 'workspace']) {
      const directory = label === 'project' ? result.directory : path.join(result.directory, 'workspace');
      let inspection;
      try { inspection = await SnapshotStore.inspectLock(directory); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (label === 'project') result.directory = inspection.directory;
      if (inspection.state !== 'unlocked') result.locks.push({ label, inspection });
    }
    return result;
  }

  static async recoverLocks(review) {
    if (!review || typeof review.directory !== 'string' || !path.isAbsolute(review.directory)
      || !Array.isArray(review.locks) || review.locks.length > 2) throw new TypeError('An inspected project is required');
    const seen = new Set();
    // Validate every reviewed owner before releasing any lock. Each atomic
    // release rechecks independently in case ownership changes after this pass.
    for (const { label, inspection } of review.locks) {
      if (!['project', 'workspace'].includes(label) || seen.has(label)
        || inspection?.directory !== (label === 'project' ? review.directory : path.join(review.directory, 'workspace'))) {
        throw new TypeError('Lock does not belong to the inspected project');
      }
      seen.add(label);
      const current = await SnapshotStore.inspectLock(inspection.directory);
      if (!equal(current, inspection)) throw failure('LOCK_CHANGED', 'A reviewed writer changed; inspect the project again');
      if (current.state === 'active') throw failure('WRITER_ACTIVE', 'A project writer is still running');
      if (current.state !== 'stale') throw failure('OWNER_UNKNOWN', 'A writer cannot be confirmed stopped on this host');
    }
    const retained = [];
    for (const { inspection } of review.locks) retained.push((await SnapshotStore.recoverLock(inspection)).retained);
    return { directory: review.directory, retained };
  }

  constructor(store, workspace, onChange) {
    this.id = randomUUID();
    this.directory = store.directory;
    this._store = store;
    this._documents = new Map();
    this._paths = new Map();
    this._queues = new Map();
    this._closing = null;
    this._workspace = workspace;
    this._onChange = onChange;
    this._watchers = new Map();
    this._notifications = new Map();
    this._transports = new Map();
    this._retiring = new Set();
    // Directory notifications are hints. Periodic rescans cover dropped events
    // and reattach watches after a directory is replaced; no timed suppression.
    this._rescan = workspace ? setInterval(() => {
      for (const watcher of this._watchers.values()) watcher.close();
      this._watchers.clear();
      for (const [document, engine] of this._documents) {
        this._watch(document, engine.snapshot().disk.path);
        this._notify(document);
      }
    }, 3000) : null;
    this._rescan?.unref();
  }

  async describe() {
    return { session: this.id, directory: this.directory, server: this.server, projectId: this.projectId, sourceRoot: this._workspace?.root ?? null,
      sources: this._workspace ? await this._workspace.bindings() : [], project: structuredClone(this._project) };
  }

  project(metadata) {
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    const captured = metadata === undefined ? undefined : structuredClone(metadata);
    if (captured !== undefined) {
      if (!captured || typeof captured.name !== 'string' || !Array.isArray(captured.tree)
        || captured.tree.length > 10000 || Buffer.byteLength(JSON.stringify(captured)) > 16 * 1024 * 1024) {
        return Promise.reject(new TypeError('Bounded project metadata and a source tree are required'));
      }
      const ids = new Set(), paths = new Set();
      for (const entry of captured.tree) {
        const relative = entry.type === 'folder' ? entry.path?.replace(/\/$/, '') : entry.path;
        if (typeof entry.id !== 'string' || !entry.id || !['doc', 'file', 'folder'].includes(entry.type)
          || typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0')
          || relative.split('/').some(part => !part || part === '.' || part === '..')
          || ids.has(entry.id) || paths.has(relative)) return Promise.reject(new TypeError('Project contains an invalid or ambiguous source path'));
        ids.add(entry.id); paths.add(relative);
      }
    }
    const key = JSON.stringify(['project']);
    return this._queue(key, async () => {
      if (captured !== undefined && !equal(captured, this._project)) {
        const record = await this._store.read(key);
        await this._store.write(key, captured, record?.revision ?? 0);
        this._setProject(captured);
        for (const document of this._documents.keys()) this._onChange({ session: this.id, document, reason: 'project' });
      }
      return structuredClone(this._project);
    });
  }

  _setProject(metadata) {
    this._project = metadata;
    this._entries = new Map((metadata?.tree ?? []).map(entry => [entry.id, entry]));
    this._entriesByPath = new Map((metadata?.tree ?? []).map(entry => [entry.path, entry]));
  }

  captureBuild({ previousFingerprint, inspectOnly = false } = {}) {
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    return this._queue(JSON.stringify(['project']), async () => {
      if (!this._workspace || !this._project) throw failure('BUILD_INPUT_UNAVAILABLE', 'Open a cached project before compiling');
      const bindings = new Map((await this._workspace.bindings()).map(entry => [entry.document, entry]));
      const files = [];
      let total = 0;
      for (const entry of this._project.tree) {
        if (entry.type === 'folder') continue;
        const binding = bindings.get(entry.id);
        if (!binding || binding.path !== entry.path || (binding.kind ?? 'doc') !== (entry.type === 'file' ? 'asset' : 'doc')) {
          throw failure('BUILD_INPUT_UNAVAILABLE', 'Download or resolve the project path before compiling: ' + entry.path);
        }
        const inspection = await this._workspace.inspect(entry.path);
        if (!inspection.observed.exists) throw failure('BUILD_INPUT_UNAVAILABLE', 'Missing saved source: ' + entry.path);
        const bytes = Buffer.from(inspection.observed.bytes, 'base64');
        total += bytes.length;
        if (total > 256 * 1024 * 1024) throw failure('BUILD_INPUT_LIMIT', 'Saved project inputs exceed 256 MiB');
        files.push({ entry, inspection, bytes });
      }
      if (!files.length) throw failure('BUILD_INPUT_UNAVAILABLE', 'Project has no saved source files');
      for (const file of files) {
        if (!equal(await this._workspace.inspect(file.entry.path), file.inspection)) {
          throw failure('BUILD_INPUT_CHANGED', 'Saved inputs changed during capture; retry compilation');
        }
      }
      const inputs = files.map(({ entry, bytes }) => ({ document: entry.id, path: entry.path,
        hash: createHash('sha256').update(bytes).digest('hex') })).sort((a, b) => a.path.localeCompare(b.path));
      const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
      const captured = { session: this.id, fingerprint, inputs,
        projectHash: createHash('sha256').update(JSON.stringify(this._project)).digest('hex') };
      if (inspectOnly) return captured;
      if (previousFingerprint === fingerprint) return { session: this.id, fingerprint, unchanged: true };
      const parent = path.join(this.directory, 'builds');
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('BUILD_DIRECTORY', 'Build root must be an ordinary private directory');
      const directory = await mkdtemp(path.join(parent, 'build-'));
      for (const { entry, bytes } of files) {
        const filename = path.join(directory, entry.path);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      }
      const key = JSON.stringify(['builds']), record = await this._store.read(key);
      const identity = await lstat(directory);
      const build = { name: path.basename(directory), token: randomUUID(), session: this.id,
        identity: { dev: String(identity.dev), ino: String(identity.ino) }, finished: null };
      await this._store.write(key, { entries: [...(record?.state.entries ?? []), build] }, record?.revision ?? 0);
      return { ...captured, directory, token: build.token };
    });
  }

  finishBuild({ token }) {
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    return this._queue(JSON.stringify(['project']), async () => {
      const key = JSON.stringify(['builds']);
      let record = await this._store.read(key);
      const build = record?.state.entries.find(entry => entry.token === token && entry.session === this.id);
      if (!build) throw failure('STALE_BUILD', 'Build does not belong to this session');
      if (build.finished === null) {
        build.finished = record.revision + 1;
        record = await this._store.write(key, record.state, record.revision);
      }
      const completed = record.state.entries.filter(entry => entry.finished !== null)
        .sort((a, b) => b.finished - a.finished);
      const parent = path.join(this.directory, 'builds');
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw failure('BUILD_DIRECTORY', 'Build root changed');
      const removed = new Set();
      for (const entry of completed.slice(10)) {
        if (!/^build-[a-zA-Z0-9]+$/.test(entry.name)) throw failure('BUILD_DIRECTORY', 'Invalid retained build name');
        const directory = path.join(parent, entry.name);
        let stat;
        try { stat = await lstat(directory); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink()
          || !equal(entry.identity, { dev: String(stat.dev), ino: String(stat.ino) }))) {
          throw failure('BUILD_DIRECTORY', 'Retained build directory changed; cleanup held');
        }
        await this._store._assertOwnership();
        if (stat) await rm(directory, { recursive: true });
        removed.add(entry.token);
      }
      if (removed.size) await this._store.write(key,
        { entries: record.state.entries.filter(entry => !removed.has(entry.token)) }, record.revision);
      return { status: 'finished' };
    });
  }

  compileReady(capture) {
    const captured = structuredClone(capture);
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    return this._queue(JSON.stringify(['project']), async () => {
      if (captured?.session !== this.id || !Array.isArray(captured.inputs) || !captured.inputs.length
        || captured.fingerprint !== createHash('sha256').update(JSON.stringify(captured.inputs)).digest('hex')) {
        throw failure('BUILD_INPUT_CHANGED', 'Compile inputs do not belong to this project session');
      }
      if (captured.projectHash !== createHash('sha256').update(JSON.stringify(this._project)).digest('hex')) {
        throw failure('BUILD_INPUT_CHANGED', 'Project metadata changed after requesting compilation; retry');
      }
      const pending = [];
      for (const input of captured.inputs) {
        const entry = this._entries.get(input.document);
        if (!entry || entry.path !== input.path) throw failure('BUILD_INPUT_CHANGED', 'Project source changed');
        const inspection = await this._workspace.inspect(input.path);
        const observed = inspection.observed;
        const hash = text => createHash('sha256').update(text).digest('hex');
        if (!observed.exists || hash(Buffer.from(observed.bytes, 'base64')) !== input.hash) {
          throw failure('BUILD_INPUT_CHANGED', 'Saved source changed after requesting compilation: ' + input.path);
        }
        if (inspection.record?.state.pending) throw failure('COMPILE_HELD', 'Recover the interrupted source write: ' + input.path);
        if (entry.type === 'file') {
          const asset = (await this._store.read(JSON.stringify(['asset', input.document])))?.state;
          if (!asset || asset.pending || asset.conflict || asset.remote !== observed.bytes) {
            throw failure('COMPILE_HELD', 'Binary contents have not been synchronized: ' + input.path);
          }
          continue;
        }
        const state = this._documents.get(input.document)?.snapshot();
        if (!state) throw failure('BUILD_INPUT_UNAVAILABLE', 'Open the source before compiling: ' + input.path);
        if (state.conflict || state.disk?.held || state.pending?.status === 'uncertain') {
          throw failure('COMPILE_HELD', 'Resolve synchronization before compiling: ' + input.path);
        }
        if (hash(state.saved) !== input.hash) {
          throw failure('BUILD_INPUT_CHANGED', 'An incoming revision changed the saved target: ' + input.path);
        }
        const transport = this._transports.get(input.document);
        const status = transport?.transport?.status();
        if (!status || status.state === 'offline') throw failure('COMPILE_OFFLINE', 'Reconnect before remote compilation: ' + input.path);
        if (transport.error || status.state === 'held') throw failure('COMPILE_HELD', 'Synchronization is held: ' + input.path);
        if (state.pending || state.remote.content !== state.saved || status.state !== 'idle') pending.push(input.path);
      }
      return { ready: pending.length === 0, pending };
    });
  }

  _lifecycle(document, source = this._paths.get(document), kind = 'doc', policy = this._documents.get(document)?.snapshot()) {
    if (policy?.localArchive) return { reason: 'local-archive', path: source, remotePath: null, replacement: null };
    if (!this._project || !this._workspace) return null;
    if (!source) return null;
    const entry = this._entries.get(document);
    if (entry?.type === kind && entry.path === source) return null;
    const occupying = this._entriesByPath.get(source);
    const replacement = occupying?.id !== document ? occupying : null;
    if (policy?.localOnly && !replacement) return null;
    return { reason: replacement ? 'remote-replaced' : entry ? 'remote-renamed' : 'remote-deleted',
      path: source, remotePath: entry?.path ?? null, replacement: replacement?.id ?? null };
  }

  async _reviewLifecycle(engine) {
    const state = engine.snapshot();
    const lifecycle = this._lifecycle(engine._id, state.disk?.path);
    if (!lifecycle) throw failure('NO_LIFECYCLE', 'This source has no remote lifecycle change to review');
    const source = await this._workspace.inspect(state.disk.path);
    const archive = await this._reviewOptionalRelocation(engine._id, retainedPath(engine._id, state.disk.path), true);
    return { session: this.id, revision: state.revision, lifecycle, source,
      workspace: archive.review, workspaceError: archive.error };
  }

  async _reviewOptionalRelocation(document, target, local = false) {
    try {
      if (local) this._checkLocalTarget(target);
      return { review: await this._workspace.reviewRelocation(document, target), error: null };
    } catch (error) {
      // An unavailable destination must not prevent retaining the original.
      // Source inspection and acceptance still perform their complete checks.
      if (!['PATH_BOUND', 'UNSAFE_PATH', 'FILE_LIMIT', 'UNSTABLE_FILE', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      return { review: null, error: { code: error.code, message: error.message } };
    }
  }

  async _keepLocal(engine, captured) {
    const review = captured.review, state = engine.snapshot();
    const uncertain = captured.action === 'keepUncertainLocal';
    const matches = uncertain
      ? review?.document === engine._id && state.pending?.status === 'uncertain'
        && review.pending?.token === state.pending.token
      : review?.lifecycle && equal(review.lifecycle, this._lifecycle(engine._id, state.disk?.path));
    if (!review || review.session !== this.id || review.revision !== state.revision || !matches) {
      throw failure('STALE_LIFECYCLE', 'Document or remote identity changed; review the source again');
    }
    const source = await this._workspace.inspect(state.disk.path);
    if (!equal(source, review.source)) throw failure('STALE_FILE', 'Source changed after lifecycle review');
    if (source.record?.state.pending) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Recover the interrupted source write first');
    const content = diskText(source.observed);
    if (content === null) throw failure('MISSING_SOURCE', 'Restore the source before retaining it');
    await engine.keepLocal(content, captured.checkpoint, state.revision,
      captured.action === 'archiveLocal' ? review.workspace.to : null);
    const entry = this._transports.get(engine._id);
    this._transports.delete(engine._id);
    this._retire(entry);
    return { status: 'local-only' };
  }

  async _archiveLocal(engine, captured) {
    const review = captured.review;
    const target = retainedPath(engine._id, engine.snapshot().disk.path);
    if (review?.workspace?.document !== engine._id || review.workspace.to !== target) {
      throw failure('STALE_LIFECYCLE', 'Review the retained local path before accepting it');
    }
    this._checkLocalTarget(target);
    await this._keepLocal(engine, captured);
    await this._workspace.relocate(review.workspace);
    await this._completeRelocation(engine);
    return { status: 'local-only', from: review.workspace.from, to: target };
  }

  _checkLocalTarget(target) {
    if ([...this._entries.values()].some(entry => entry.path === target || (entry.type !== 'folder' && target.startsWith(entry.path + '/')))) {
      throw failure('PATH_BOUND', 'The retained local path belongs to a remote project entry');
    }
  }

  async _completeAssetRelocation(document, record) {
    if (!record) return record;
    const journal = await this._workspace.relocation(document);
    if (!journal?.bound || record.state.path === journal.state.review.to) return record;
    if (record.state.path !== journal.state.review.from) throw failure('PATH_BOUND', 'Asset relocation does not match its source');
    return this._store.write(JSON.stringify(['asset', document]), { ...record.state, path: journal.state.review.to,
      localArchive: null }, record.revision);
  }

  assetLifecycle(params) {
    const { document, action, review } = structuredClone(params);
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    if (!this._workspace) return Promise.reject(failure('NO_WORKSPACE', 'Assets require a source workspace'));
    if (typeof document !== 'string' || !document || !['state', 'review', 'rename', 'local', 'archive'].includes(action)) {
      return Promise.reject(new TypeError('Asset identity and a lifecycle action are required'));
    }
    const key = JSON.stringify(['asset', document]);
    return this._queue(key, async () => {
      let record = await this._completeAssetRelocation(document, await this._store.read(key));
      if (!record) throw failure('ASSET_NOT_OPEN', 'Open the retained asset before reviewing it');
      let source = await this._workspace.inspect(record.state.path);
      const lifecycle = this._lifecycle(document, record.state.path, 'file', record.state);
      if (action === 'state') return { session: this.id, document, revision: record.revision, observation: source,
        state: { ...record.state, lifecycle } };
      if (!lifecycle) throw failure('NO_LIFECYCLE', 'This asset has no changed remote identity');
      if (action === 'review') {
        const relocation = lifecycle.remotePath && this._entries.get(document)?.type === 'file'
          ? await this._reviewOptionalRelocation(document, lifecycle.remotePath) : { review: null, error: null };
        const archive = await this._reviewOptionalRelocation(document, retainedPath(document, record.state.path), true);
        return { session: this.id, document, revision: record.revision, lifecycle, source,
          relocation: relocation.review, relocationError: relocation.error,
          archive: archive.review, archiveError: archive.error };
      }
      if (!review || review.session !== this.id || review.document !== document || review.revision !== record.revision
        || !equal(review.lifecycle, lifecycle)) throw failure('STALE_LIFECYCLE', 'Asset identity changed; review it again');
      if (!equal(source, review.source)) throw failure('STALE_FILE', 'Asset source changed after review');
      if (record.state.pending || source.record?.state.pending) throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Recover the interrupted asset write first');
      if (!source.observed.exists) throw failure('MISSING_SOURCE', 'Restore the asset before accepting its lifecycle');
      const move = action === 'rename' ? review.relocation : action === 'archive' ? review.archive : null;
      if (action === 'rename' && (!move || this._entries.get(document)?.type !== 'file' || move.to !== lifecycle.remotePath)) {
        throw failure('STALE_LIFECYCLE', 'The reviewed remote asset path changed');
      }
      if (action === 'archive') {
        if (!move || move.to !== retainedPath(document, record.state.path)) throw failure('STALE_LIFECYCLE', 'Review the retained asset path');
        this._checkLocalTarget(move.to);
      }
      if (move && move.document !== document) throw failure('STALE_LIFECYCLE', 'Relocation belongs to another asset');
      if (action !== 'rename') {
        record = await this._store.write(key, { ...record.state, localOnly: true, status: 'local-only',
          localArchive: action === 'archive' ? move.to : null,
          recovery: record.state.localOnly ? record.state.recovery : { ...record.state.recovery, localOnly: record.state } }, record.revision);
      }
      if (move) {
        await this._workspace.relocate(move);
        record = await this._completeAssetRelocation(document, record);
        source = await this._workspace.inspect(record.state.path);
      }
      return { session: this.id, document, revision: record.revision, observation: source,
        state: { ...record.state, lifecycle: this._lifecycle(document, record.state.path, 'file', record.state) } };
    });
  }

  async _completeRelocation(engine) {
    if (!this._workspace || !engine.snapshot().disk) return;
    const journal = await this._workspace.relocation(engine._id);
    if (!journal?.bound) return;
    const { from, to } = journal.state.review;
    if (engine.snapshot().disk.path === to) return;
    if (engine.snapshot().disk.path !== from) throw failure('PATH_BOUND', 'Relocation journal does not match the source');
    await engine.relocateDisk(from, to, diskText(journal.state.installed));
    this._paths.set(engine._id, to);
    this._watch(engine._id, to);
  }

  async _captures(engine) {
    const directory = path.join(this.directory, 'editor-captures');
    let entries;
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH', 'Invalid editor capture directory');
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const captures = [];
    let bytes = 0;
    for (const entry of entries.slice(-4096)) {
      if (!entry.isDirectory() || !/^overleaf-history-[a-zA-Z0-9]+$/.test(entry.name)) continue;
      const parent = path.join(directory, entry.name), filename = path.join(parent, 'snapshot.json');
      let handle;
      try {
        const parentStat = await lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) continue;
        handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) continue;
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
        const saved = JSON.parse(buffer.toString('utf8'));
        if (saved.document !== engine._id || typeof saved.content !== 'string'
          || typeof saved.empty !== 'boolean' || (saved.empty && saved.content !== '') || saved.content.includes('\0')) continue;
        bytes += Buffer.byteLength(saved.content);
        if (bytes > 16 * 1024 * 1024 || captures.length >= 64) break;
        captures.push({ path: parent, content: saved.content, empty: saved.empty });
      } catch (error) {
        if (!['ENOENT', 'ELOOP'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
      } finally { await handle?.close(); }
    }
    return captures;
  }

  async _importBranch(engine, captured) {
    if (this._lifecycle(engine._id)) throw failure('MIGRATION_HELD', 'Resolve the document identity before migration');
    const source = captured.source;
    let branch;
    if (source?.kind === 'file') {
      const current = await Workspace.readLegacy(source.filename);
      if (!equal(current, source)) throw failure('STALE_FILE', 'Legacy file changed after inspection; select it again');
      const { bytes, ...observation } = source.observed;
      branch = { content: diskText(source.observed), origin: { kind: 'file', name: source.filename, observation } };
    } else if (source?.kind === 'buffer') {
      const checkpoint = captureEditorCheckpoint(source.checkpoint);
      branch = { content: currentText(checkpoint), origin: { kind: 'buffer', name: source.name, checkpoint } };
    } else throw new TypeError('An inspected legacy file or native buffer is required');
    await engine.importBranch(branch, captured.checkpoint, captured.revision);
    return { status: 'review-required' };
  }

  _features(engine, captured) {
    const state = engine.snapshot();
    if (state.localOnly || state.remote.wire === undefined) return { status: 'unavailable', comments: [], cursor: null };
    const wire = state.remote.wire, view = captured.view;
    if (typeof view !== 'string' || Buffer.byteLength(view) > 16 * 1024 * 1024) throw new TypeError('A bounded native text view is required');
    if (captured.cursor !== undefined) return { version: state.remote.version, cursor: mapCursor(wire, view, captured.cursor) };
    const comments = updateComments(wire, state.remote.comments ?? [], diff(wire, view));
    return { version: state.remote.version, comments: comments.map(({ id, op }) => ({ id, content: op.c,
      start: bytePosition(view, op.p), end: bytePosition(view, op.p + op.c.length) })) };
  }

  async _reviewRelocation(engine) {
    const state = engine.snapshot();
    const lifecycle = this._lifecycle(engine._id, state.disk?.path);
    if (!lifecycle?.remotePath || this._entries.get(engine._id)?.type !== 'doc') {
      throw failure('NO_RELOCATION', 'This source has no remote rename to accept');
    }
    if ((state.disk.pending && state.disk.pending.kind !== 'persistent-undo') || state.disk.held || state.editor?.pending) {
      throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Finish source and editor recovery before relocation');
    }
    await this._workspace.inspect(state.disk.path);
    const relocation = await this._reviewOptionalRelocation(engine._id, lifecycle.remotePath);
    return { session: this.id, revision: state.revision, lifecycle,
      workspace: relocation.review, workspaceError: relocation.error };
  }

  async _relocate(engine, review) {
    if (!review || review.session !== this.id || review.revision !== engine.snapshot().revision
      || !equal(review.lifecycle, this._lifecycle(engine._id, engine.snapshot().disk?.path))
      || review.workspace?.document !== engine._id || review.workspace.to !== review.lifecycle.remotePath) {
      throw failure('STALE_RELOCATION', 'Source or remote path changed; review the rename again');
    }
    await this._reviewRelocation(engine);
    await this._workspace.relocate(review.workspace);
    await this._completeRelocation(engine);
    return { status: 'relocated', from: review.workspace.from, to: review.workspace.to };
  }

  /** Binary sources have no text merger or implicit upload. Preserve local
   * changes and require an explicit choice if the remote branch also changes. */
  asset(params) {
    const captured = structuredClone(params);
    const { document, path: relative, bytes } = captured;
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closed'));
    if (!this._workspace) return Promise.reject(failure('NO_WORKSPACE', 'Assets require a source workspace'));
    if (typeof document !== 'string' || !document.length) return Promise.reject(new TypeError('Asset identity is required'));
    if (bytes !== undefined && (typeof bytes !== 'string' || bytes.length > 4 * Math.ceil(16 * 1024 * 1024 / 3)
      || Buffer.from(bytes, 'base64').toString('base64') !== bytes)) {
      return Promise.reject(new TypeError('Asset bytes must be canonical base64 within the 16 MiB limit'));
    }
    const key = JSON.stringify(['asset', document]);
    return this._queue(key, async () => {
      let record = await this._completeAssetRelocation(document, await this._store.read(key));
      await this._workspace.bind(relative, document, 'asset');
      if (record && (record.state.kind !== 'asset' || record.state.path !== relative)) {
        throw failure('PATH_BOUND', 'Asset belongs to another source');
      }
      if (!record && bytes === undefined) throw failure('ASSET_NOT_OPEN', 'Fetch this asset before opening it offline');
      const next = structuredClone(record?.state ?? {
        kind: 'asset', path: relative, remote: null, installed: null, conflict: null, pending: null,
      });
      let inspection = await this._workspace.inspect(relative);
      const lifecycle = this._lifecycle(document, relative, 'file', next);
      const reply = () => ({ session: this.id, document, revision: record.revision,
        state: { ...record.state, lifecycle }, observation: inspection });
      const persist = async () => {
        if (!record || !equal(record.state, next)) record = await this._store.write(key, next, record?.revision ?? 0);
      };
      if (next.localOnly) return reply();
      if (lifecycle) {
        if (captured.choice !== undefined) throw failure('LIFECYCLE_HELD', 'Review the changed project path before choosing binary contents');
        if (bytes !== undefined) next.remote = bytes;
        await persist();
        return reply();
      }
      if (captured.choice !== undefined) {
        if (!['local', 'remote'].includes(captured.choice) || bytes !== undefined) throw new TypeError('Select one reviewed binary branch');
        if (!record || captured.revision !== record.revision) throw failure('STALE_REVISION', 'Asset changed after review');
        if (!equal(inspection, captured.observation)) throw failure('STALE_FILE', 'Asset source changed after review');
        if (captured.choice === 'remote' && (next.pending || inspection.record?.state.pending)) {
          throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Adopt the inspected current file before resolving an interrupted write');
        }
        if (captured.choice === 'local' && !inspection.observed.exists) throw failure('MISSING_SOURCE', 'Restore the source before adopting it');
        next.recovery = { choice: captured.choice, local: inspection.observed.bytes ?? null,
          conflict: next.conflict, pending: next.pending, installed: next.installed, remote: next.remote };
        if (captured.choice === 'local') {
          if (inspection.record?.state.pending) await this._workspace.recover(relative, inspection);
          next.pending = next.conflict = null;
          next.local = inspection.observed.bytes;
          next.status = next.local === next.remote ? 'synced' : 'local-changes';
          delete next.error;
          if (next.status === 'synced') next.installed = next.remote;
          await persist();
          inspection = await this._workspace.inspect(relative);
          return reply();
        }
        next.conflict = null;
      }
      const remote = bytes ?? next.remote;
      if (next.pending) return reply();
      const observed = await this._workspace.observe(relative);
      const local = observed.state.observed.exists ? observed.state.observed.bytes : null;
      const base = next.installed;
      const remoteChanged = next.remote !== remote;
      next.remote = remote;
      next.local = local;
      if (record && local === null && captured.choice !== 'remote') {
        next.status = 'missing-file';
      } else if (next.conflict) {
        next.status = 'conflict';
      } else if (local === remote) {
        next.installed = remote;
        next.status = 'synced';
        delete next.error;
      } else if (local !== base && captured.choice !== 'remote') {
        next.status = remoteChanged ? 'conflict' : 'local-changes';
        if (remoteChanged) next.conflict = { base, local, remote };
      } else {
        next.pending = { bytes: remote, workspaceRevision: observed.revision };
        next.status = 'write-recovery';
        await persist();
        try { await this._workspace.write(relative, Buffer.from(remote, 'base64'), observed.revision); }
        catch (error) {
          next.error = { code: error.code ?? 'WRITE_FAILED', message: error.message };
          await persist();
          inspection = await this._workspace.inspect(relative);
          return reply();
        }
        next.installed = next.local = remote;
        next.pending = null;
        next.status = 'synced';
      }
      await persist();
      inspection = await this._workspace.inspect(relative);
      return reply();
    });
  }

  _queue(document, operation) {
    const previous = this._queues.get(document) ?? Promise.resolve();
    // Metadata changes form a barrier across source transactions. Work already
    // accepted finishes first; later work observes the committed project tree.
    const metadata = JSON.stringify(['project']);
    const dependencies = document === metadata ? [...this._queues.values()]
      : [previous, this._queues.get(metadata)];
    const request = Promise.allSettled(dependencies).then(operation);
    this._queues.set(document, request);
    return request;
  }

  _transportChanged(document, entry, status) {
    if (this._closing || this._transports.get(document) !== entry) return;
    this._onChange({ session: this.id, document, reason: 'transport', transport: status });
    const engine = this._documents.get(document);
    if (this._workspace && engine && !engine.snapshot().editor) this._notify(document);
  }

  _retire(entry) {
    entry?.unobserve?.();
    const closing = entry?.transport?.close();
    if (!closing) return Promise.resolve();
    this._retiring.add(closing);
    closing.then(() => this._retiring.delete(closing), () => this._retiring.delete(closing));
    return closing;
  }

  async connectDocument(document, connection) {
    if (this._closing) throw failure('SESSION_CLOSED', 'Project session is closing or closed');
    if (!connection.connected || !connection.publicId || connection.projectId !== this.projectId
      || connection.server !== this.server) throw failure('CONNECTION_MISMATCH', 'Connection does not belong to this project session');
    const previous = this._transports.get(document);
    const entry = { connection };
    this._transports.set(document, entry);
    await this._retire(previous);
    let transport;
    try {
      transport = await this._queue(document, () => {
        if (this._closing || this._transports.get(document) !== entry) return null;
        const engine = this._documents.get(document);
        if (!engine) throw failure('DOCUMENT_NOT_OPEN', 'Open the document before connecting it');
        if (engine.snapshot().localOnly) return null;
        // All transport mutations share the queue containing whole disk save
        // transactions. An ACK cannot interleave source installation and commit.
        const queued = { snapshot: () => engine.snapshot() };
        for (const method of ['receiveRemote', 'prepareUpload', 'acknowledge', 'markUncertain', 'markQueued', 'recoverUpload']) {
          queued[method] = (...args) => this._queue(document, () =>
            engine.snapshot().localOnly || (method === 'prepareUpload' && this._lifecycle(document)) ? null : engine[method](...args));
        }
        entry.transport = new DocumentTransport(queued, {
          document, source: connection.publicId, send: update => connection.sendUpdate(update),
          onChange: status => this._transportChanged(document, entry, status),
        });
        entry.unobserve = connection.observeDocument(document, {
          applied: update => entry.transport.receive(update),
          interrupted: () => { entry.unobserve(); return entry.transport.close(); },
          failed: error => {
            entry.error = error.code ?? 'TRANSPORT_ERROR';
            this._transportChanged(document, entry, { state: 'held', reason: entry.error });
            entry.unobserve();
            return entry.transport.close();
          },
        });
        return entry.transport;
      });
      if (!transport) return { state: this._documents.get(document)?.snapshot().localOnly ? 'local-only' : 'offline' };
      const pending = this._documents.get(document).snapshot().pending;
      const joined = await connection.joinDoc(document, pending?.version ?? -1);
      await transport.join({ content: joined.lines.join('\n'), version: joined.version, updates: joined.updates,
        ranges: joined.ranges, queueDrained: joined.queueDrained });
      return transport.status();
    } catch (error) {
      entry.error = error.code ?? 'JOIN_FAILED';
      await this._retire(entry);
      this._transportChanged(document, entry, { state: 'held', reason: entry.error });
      throw error;
    }
  }

  async reviewUpload(params) {
    const { document, review, accept = false } = structuredClone(params);
    const connection = this._transports.get(document)?.connection;
    if (!connection?.connected) throw failure('UPLOAD_REVIEW_OFFLINE', 'Reconnect before inspecting the server queue');
    // A held stream may have ignored later events. Every review and decision
    // starts with a new owned join, never the last cached remote snapshot.
    await this.connectDocument(document, connection);
    const owner = this._transports.get(document);
    const result = await this._queue(document, async () => {
      if (owner !== this._transports.get(document) || owner.connection !== connection || this._closing) {
        throw failure('STALE_UPLOAD_REVIEW', 'Project connection changed during queue inspection');
      }
      const engine = this._documents.get(document), state = engine.snapshot();
      if (!state.pending) return { status: 'recovered' };
      const proof = owner.transport.joinSnapshot;
      const current = { session: this.id, document, revision: state.revision,
        pending: state.pending, remote: state.remote, saved: state.saved, buffer: state.buffer,
        source: this._workspace ? await this._workspace.inspect(state.disk.path) : null,
        canRetire: proof?.queueDrained === true && state.pending.queued === true };
      if (!accept) return current;
      if (!review || review.session !== this.id || review.document !== document
        || review.revision !== state.revision || review.pending?.token !== state.pending.token) {
        throw failure('STALE_UPLOAD_REVIEW', 'Source or remote head changed; inspect the uncertain operation again');
      }
      await engine.reviewUnknown(state.pending.token, state.revision, proof);
      return { status: 'review-required' };
    });
    if (result.status === 'review-required') await this.connectDocument(document, connection);
    return result;
  }

  async transportIdle(document) { await this._transports.get(document)?.transport?.idle(); }

  _publish(document) {
    const entry = this._transports.get(document);
    if (!entry?.transport || this._closing) return;
    entry.transport.publish().catch(error => {
      entry.error = error.code ?? 'PERSISTENCE_ERROR';
      this._transportChanged(document, entry, { state: 'held', reason: entry.error });
    });
  }

  _notify(document) {
    if (this._closing || this._notifications.has(document)) return;
    const timer = setTimeout(() => {
      this._notifications.delete(document);
      if (this._closing) return;
      this._onChange({ session: this.id, document, reason: 'disk' });
      const engine = this._documents.get(document);
      if (engine && !engine.snapshot().editor) {
        this.document({ document, action: 'scan' }).catch(error => {
          if (!this._closing) this._onChange({ session: this.id, document, reason: 'disk-error', message: error.message });
        });
      }
    }, 30);
    timer.unref();
    this._notifications.set(document, timer);
  }

  _watch(document, relative) {
    const directory = path.dirname(path.join(this._workspace.root, relative));
    if (this._watchers.has(directory)) return;
    try {
      const watcher = watch(directory, { persistent: false }, () => {
        for (const [id, engine] of this._documents) {
          if (path.dirname(path.join(this._workspace.root, engine.snapshot().disk.path)) === directory) this._notify(id);
        }
      });
      watcher.on('error', () => {
        watcher.close();
        this._watchers.delete(directory);
        this._notify(document);
      });
      // A directory replacement can leave a valid watcher on the old inode.
      // Periodic rescans renew watches as well as checking content.
      this._watchers.set(directory, watcher);
    } catch {
      this._notify(document);
    }
  }

  async _syncDisk(engine) {
    if (!this._workspace) return;
    const lifecycle = engine.snapshot().localOnly ? null : this._lifecycle(engine._id, engine.snapshot().disk?.path);
    if (lifecycle) return { status: 'held', reason: lifecycle.reason };
    let state = engine.snapshot();
    if (state.disk.pending?.kind === 'persistent-undo' && !state.disk.held) {
      if (state.disk.pending.undo.manual) return { status: 'held', reason: 'persistent-undo-review' };
      if (!state.conflict && state.saved === state.disk.pending.content) return undoProposal(state.disk.pending);
      await engine.finishDiskWrite(state.disk.pending.token, false);
      state = engine.snapshot();
    }
    if (state.disk.pending || (state.disk.held && state.disk.held.reason !== 'read-retry')) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      let observed;
      try {
        observed = await this._workspace.observe(state.disk.path);
        await engine.receiveDisk(diskText(observed.state.observed));
      } catch (error) {
        await engine.holdDisk(error.code === 'WORKSPACE_RECOVERY_REQUIRED' ? 'write-recovery' : 'read-retry');
        return;
      }
      let undo;
      state = engine.snapshot();
      if (observed.state.undo && !state.disk.held && !state.conflict && state.saved !== state.disk.content) {
        const archive = observed.state.undo;
        if (!archive.checkpoint) return { status: 'held', reason: 'persistent-undo-recovery' };
        let rebased;
        try { rebased = await rebaseEditorHistory(archive.checkpoint, state.saved, { forWrite: true }); }
        catch (error) {
          if (!['HISTORY_LIMIT', 'UNSUPPORTED_TEXT'].includes(error.code)) throw error;
          return { status: 'held', reason: 'persistent-undo', message: error.message };
        }
        if (rebased.status !== 'clean') return { ...rebased, status: 'held', reason: 'persistent-undo' };
        undo = { path: archive.path, checkpoint: archive.checkpoint, bytes: archive.observed.bytes ?? null,
          history: rebased.history, workspaceRevision: observed.revision };
      }
      const pending = await engine.planDiskWrite(undo);
      if (!pending) return;
      if (undo) return undoProposal(pending);
      try {
        await this._workspace.write(state.disk.path, Buffer.from(pending.content), observed.revision);
        await engine.finishDiskWrite(pending.token, true);
        return;
      } catch (error) {
        const recovery = await this._workspace.snapshot(state.disk.path);
        if (['STALE_FILE', 'STALE_REVISION'].includes(error.code) && !recovery?.state.pending) {
          await engine.finishDiskWrite(pending.token, false);
          state = engine.snapshot();
          continue;
        }
        await engine.holdDisk('write-recovery');
        return;
      }
    }
    await engine.holdDisk('read-retry');
  }

  async _resolveDiskHistory(engine, captured) {
    if (!captured.resolutions || typeof captured.resolutions !== 'object' || Array.isArray(captured.resolutions)) {
      throw failure('INVALID_RESOLUTION', 'Persistent history choices must be keyed by sequence ID');
    }
    const state = engine.snapshot();
    if (state.revision !== captured.revision) throw failure('STALE_REVISION', 'Document changed during persistent history review');
    if (!this._workspace || !state.disk || state.disk.held || state.conflict
      || (state.disk.pending && state.disk.pending.kind !== 'persistent-undo')) {
      throw failure('WORKSPACE_RECOVERY_REQUIRED', 'Resolve the workspace or document before its saved history');
    }
    const observed = await this._workspace.observe(state.disk.path);
    if (observed.revision !== captured.workspaceRevision || diskText(observed.state.observed) !== state.disk.content) {
      throw failure('STALE_FILE', 'Source or persistent archive changed after review');
    }
    const archive = observed.state.undo;
    if (!archive?.checkpoint || state.saved === state.disk.content) throw failure('NO_HISTORY_CONFLICT', 'No incoming saved history needs review');
    const result = await rebaseEditorHistory(archive.checkpoint, state.saved, { forWrite: true, resolutions: captured.resolutions });
    if (state.disk.pending) await engine.finishDiskWrite(state.disk.pending.token, false);
    if (Object.keys(captured.resolutions).length) {
      await engine.rememberDiskHistory({ content: state.saved, workspaceRevision: observed.revision, resolutions: captured.resolutions });
    }
    if (result.status !== 'clean') return result;
    const undo = { path: archive.path, checkpoint: archive.checkpoint, bytes: archive.observed.bytes ?? null,
      history: result.history, workspaceRevision: observed.revision, resolutions: captured.resolutions, manual: true };
    return undoProposal(await engine.planDiskWrite(undo));
  }

  async _writeEditor(engine, captured) {
    if (!this._workspace) throw failure('NO_WORKSPACE', 'Session has no source workspace');
    const state = engine.snapshot();
    if (captured.revision !== state.revision) throw failure('STALE_REVISION', 'Document changed before saving');
    const undo = capturePersistentUndo(captured.undo, captured.checkpoint);
    // A native preparation has not installed anything. A manual save may
    // supersede it; uncertain writes and recovery holds are never cancelled.
    if (state.disk?.pending?.kind === 'persistent-undo' && !state.disk.held) {
      await engine.finishDiskWrite(state.disk.pending.token, false);
    }
    const observation = await this._workspace.observe(state.disk.path);
    if (diskText(observation.state.observed) !== captured.expected) {
      throw failure('DISK_CHANGED', 'External text must be reconciled before saving');
    }
    if (!(Number(observation.state.observed.identity.mode) & 0o222)) throw failure('READ_ONLY', 'Source file is read-only');
    try { await access(path.join(this._workspace.root, state.disk.path), constants.W_OK); }
    catch { throw failure('READ_ONLY', 'Source file is not writable'); }
    const pending = await engine.beginEditorSave(captured.checkpoint, engine.snapshot().revision, captured.expected);
    try {
      await this._workspace.write(state.disk.path, Buffer.from(pending.content), observation.revision, undo, captured.backups);
      return await engine.commitEditorSave(pending.token);
    } catch (error) {
      // A failed response is not proof that installation did not happen. Keep
      // the frozen editor state and both disk versions for explicit recovery.
      await engine.holdDisk('write-recovery');
      throw failure('WRITE_UNCERTAIN', 'Save requires recovery: ' + error.message);
    }
  }

  _pendingDiskUndo(engine, token) {
    const state = engine.snapshot();
    if (!state.disk || state.disk.held || state.disk.pending?.kind !== 'persistent-undo' || state.disk.pending.token !== token) {
      throw failure('STALE_DISK_WRITE', 'Persistent undo preparation is no longer current');
    }
    return state.disk.pending;
  }

  async _writeDiskUndo(engine, captured) {
    const state = engine.snapshot();
    if (this._lifecycle(engine._id, state.disk?.path)) {
      throw failure('LIFECYCLE_HELD', 'Project path changed before persistent history publication');
    }
    if (captured.revision !== state.revision) throw failure('STALE_REVISION', 'Document changed before undo publication');
    const pending = this._pendingDiskUndo(engine, captured.token);
    if (state.conflict || state.saved !== pending.content) throw failure('STALE_DISK_WRITE', 'Saved target changed during undo preparation');
    const checkpoint = captureEditorCheckpoint(captured.checkpoint);
    const proposed = { ...pending.undo.checkpoint, history: pending.undo.history };
    const expected = persistentView(proposed);
    if (!equal(checkpoint.history, expected.history) || !equal(checkpoint.options, expected.options)
      || currentText(checkpoint, { forWrite: true }) !== pending.content) {
      throw failure('INVALID_UNDO', 'Native persistent history differs from the prepared saved branch');
    }
    const undo = capturePersistentUndo({ path: pending.undo.path, bytes: captured.bytes, checkpoint }, proposed);
    try {
      await this._workspace.write(state.disk.path, Buffer.from(pending.content), pending.undo.workspaceRevision, undo);
      await engine.finishDiskWrite(pending.token, true);
      return { status: 'written', content: pending.content };
    } catch (error) {
      const record = await this._workspace.snapshot(state.disk.path);
      if (['STALE_FILE', 'STALE_REVISION'].includes(error.code) && !record.state.pending) {
        await engine.finishDiskWrite(pending.token, false);
        throw failure('STALE_DISK_WRITE', 'Source changed before persistent history installation');
      }
      await engine.holdDisk('write-recovery');
      throw failure('WRITE_UNCERTAIN', 'Persistent history update requires recovery: ' + error.message);
    }
  }

  document(params) {
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closing or closed'));
    const captured = structuredClone(params);
    const { document, action } = captured;
    if (typeof document !== 'string' || !document.length) return Promise.reject(new TypeError('Document ID is required'));
    if (!actions.has(action)) return Promise.reject(failure('UNKNOWN_ACTION', 'Unsupported synchronization action'));
    return this._queue(document, async () => {
      let engine = this._documents.get(document);
      let result = null;
      if (action === 'open') {
        if (engine) throw failure('DOCUMENT_OPEN', 'Document already belongs to this session');
        if (this._workspace) await this._workspace.bind(captured.path, document);
        engine = await DocumentEngine.open(this._store, document, captured.initial);
        if (this._workspace) {
          await this._completeRelocation(engine);
          const disk = await this._workspace.inspect(captured.path);
          await engine.bindDisk(captured.path, diskText(disk.observed));
          await this._syncDisk(engine);
        } else if (engine.snapshot().disk) throw failure('NO_WORKSPACE', 'Reopen with the bound source workspace');
        this._documents.set(document, engine);
        if (this._workspace) this._paths.set(document, captured.path);
        if (this._workspace) this._watch(document, captured.path);
      } else {
        if (!engine) throw failure('DOCUMENT_NOT_OPEN', 'Open the document before submitting events');
        await this._completeRelocation(engine);
        if (captured.sourcePath !== undefined && captured.sourcePath !== engine.snapshot().disk?.path) {
          throw failure('PATH_BOUND', 'Editor source path changed; review the relocation before continuing');
        }
        switch (action) {
          case 'importBranch': result = await this._importBranch(engine, captured); break;
          case 'stageComment':
            if (this._lifecycle(document) || !['idle', 'uploading'].includes(this._transports.get(document)?.transport?.status().state)) {
              throw failure('COMMENT_UNAVAILABLE', 'Connect and resolve the document before adding a comment');
            }
            result = await engine.stageComment(captured.selection); break;
          case 'reanchorComment': result = await engine.reanchorComment(captured.token, captured.selection); break;
          case 'confirmComment': result = await engine.confirmComment(captured.token); break;
          case 'captures': result = this._workspace ? await this._captures(engine) : []; break;
          case 'features': result = this._features(engine, captured); break;
          case 'reviewLifecycle': result = await this._reviewLifecycle(engine); break;
          case 'keepLocal': result = await this._keepLocal(engine, captured); break;
          case 'keepUncertainLocal': result = await this._keepLocal(engine, captured); break;
          case 'archiveLocal': result = await this._archiveLocal(engine, captured); break;
          case 'reviewRelocation': result = await this._reviewRelocation(engine); break;
          case 'relocate': result = await this._relocate(engine, captured.review); break;
          case 'snapshot': result = engine.snapshot(); break;
          case 'remote':
            if (this._transports.has(document)) throw failure('TRANSPORT_OWNED', 'Remote revisions belong to the active document transport');
            await engine.receiveRemote(captured.remote);
            if (!engine.snapshot().editor) await this._syncDisk(engine);
            break;
          case 'prepareReattach': result = await engine.prepareReattach(captured.checkpoint, captured.revision); break;
          case 'useEditor': {
            if (!this._workspace) throw failure('NO_WORKSPACE', 'Editor adoption requires a source workspace');
            const inspection = await this._workspace.inspect(engine.snapshot().disk.path);
            const content = diskText(inspection.observed);
            if (content === null || content !== captured.expected) throw failure('STALE_DISK', 'Source changed before editor adoption');
            await engine.useEditor(captured.checkpoint, captured.revision, content);
            result = { status: 'reattached' };
            break;
          }
          case 'prepareHistoryResolution': result = await engine.prepareHistoryResolution(captured.resolutions, captured.revision); break;
          case 'prepareConflictResolution': result = await engine.prepareConflictResolution(captured.conflict, captured.resolutions, captured.revision); break;
          case 'prepareDiskUndoResolution': result = await this._resolveDiskHistory(engine, captured); break;
          case 'acceptReattach':
            await engine.acceptReattach(captured.token, captured.checkpoint);
            result = { status: 'reattached' };
            break;
          case 'checkpoint': await engine.checkpointEditor(captured.checkpoint, captured.revision); break;
          case 'write': result = await this._writeEditor(engine, captured); break;
          case 'writeDiskUndo': result = await this._writeDiskUndo(engine, captured); break;
          case 'holdDiskUndo':
            if (!['undo-metadata', 'history-limit'].includes(captured.reason)) throw new TypeError('Invalid persistent undo hold reason');
            this._pendingDiskUndo(engine, captured.token);
            await engine.finishDiskWrite(captured.token, false);
            result = { status: 'held', reason: 'persistent-undo', detail: captured.reason };
            break;
          case 'save': {
            if (this._workspace) throw failure('GUARDED_SAVE_REQUIRED', 'Use the guarded write action for bound sources');
            const encoded = captured.bytes;
            if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(16 * 1024 * 1024 / 3)
              || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
              throw new TypeError('Saved file bytes must be canonical base64 within the 16 MiB limit');
            }
            const content = editorText(decodeBytes(Buffer.from(encoded, 'base64'), captured.checkpoint?.options));
            result = await engine.saveEditor(captured.checkpoint, captured.revision, content);
            break;
          }
          case 'prepare':
            if (captured.revision !== engine.snapshot().revision) throw failure('STALE_REVISION', 'Document changed before preparation');
            result = await this._syncDisk(engine) ?? await engine.prepareEditorUpdate(engine.snapshot().revision);
            break;
          case 'scan': result = await this._syncDisk(engine) ?? null; break;
          case 'diskState':
            if (!this._workspace) throw failure('NO_WORKSPACE', 'Session has no source workspace');
            result = await this._workspace.inspect(engine.snapshot().disk.path);
            break;
          case 'recoverDisk': {
            if (!this._workspace) throw failure('NO_WORKSPACE', 'Session has no source workspace');
            if (captured.choice !== 'keep-current') throw failure('INVALID_RECOVERY', 'Select the inspected current source explicitly');
            const state = engine.snapshot();
            if (state.revision !== captured.revision) throw failure('STALE_REVISION', 'Document changed after recovery inspection');
            const content = diskText(captured.inspection?.observed);
            if (content === null) throw failure('MISSING_SOURCE', 'Restore the source before adopting its contents');
            await this._workspace.recover(state.disk.path, captured.inspection);
            await engine.recoverDisk(content, state.revision);
            result = { status: 'recovered', content };
            break;
          }
          case 'accept': await engine.acceptEditorUpdate(captured.token, captured.checkpoint); break;
          case 'hold': await engine.holdEditorUpdate(captured.token, captured.reason); break;
        }
      }
      const state = engine.snapshot();
      if (['save', 'write', 'scan', 'prepare', 'writeDiskUndo', 'confirmComment', 'reanchorComment'].includes(action)) this._publish(document);
      const entry = this._transports.get(document);
      return {
        session: this.id, document, revision: state.revision, result,
        workspace: this._workspace ? {
          root: this._workspace.root, path: state.disk.path,
          readFlags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        } : null,
        state: {
          buffer: state.buffer, saved: state.saved, remoteVersion: state.remote.version,
          publication: state.localOnly ? 'local-only' : state.pending ? (state.pending.status === 'uncertain' ? 'uncertain' : 'uploading')
            : state.saved === state.remote.content ? 'synced' : 'pending',
          comments: state.comments ?? [],
          conflict: state.conflict, held: state.editor?.held ?? null,
          editorAttached: !!state.editor,
          editorClean: cleanEditor(state),
          lifecycle: this._lifecycle(document),
          disk: state.disk ?? null,
          transport: entry?.error ? { state: 'held', reason: entry.error } : entry?.transport?.status() ?? { state: 'offline' },
        },
      };
    });
  }

  close() {
    if (!this._closing) {
      clearInterval(this._rescan);
      for (const watcher of this._watchers.values()) watcher.close();
      for (const timer of this._notifications.values()) clearTimeout(timer);
      this._closing = (async () => {
        for (const entry of this._transports.values()) entry.unobserve?.();
        await Promise.all([...this._transports.values()].map(entry => this._retire(entry)).concat([...this._retiring]));
        // Include engine work that has been accepted but has not yet enqueued
        // its store write. Store.close alone cannot drain those operations.
        await Promise.allSettled(this._queues.values());
        const closed = await Promise.allSettled([this._workspace?.close(), this._store.close()]);
        const failed = closed.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      })();
    }
    return this._closing;
  }
}

module.exports = { SyncSession };
