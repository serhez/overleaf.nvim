#!/usr/bin/env node
'use strict';

const readline = require('readline');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const auth = require('./auth');
const SocketManager = require('./socket');
const { rebaseHistory } = require('./sync/history');
const { SyncSession } = require('./sync/session');
const { getOverleafCookie, listProfiles } = require('./browser-cookie');

// Redirect console.log to stderr (stdout is the RPC channel)
const origLog = console.log;
console.log = (...args) => console.error('[bridge]', ...args);

const BASE_URL = process.env.OVERLEAF_URL || 'https://www.overleaf.com';
const BASE_ORIGIN = new URL(BASE_URL).origin;

let requestId = 0;
let socketManager = null;
let connectionGeneration = 0;
let pendingRequests = 0;
let pendingSyncRequests = 0;
let stdinClosed = false;
let exiting = false;
let abandonNetwork = false;
const syncSessions = new Map();
const syncMethods = new Set(['syncOpen', 'syncProject', 'syncDocument', 'syncAsset', 'syncAssetLifecycle', 'syncCaptureBuild', 'syncFinishBuild', 'syncComment', 'syncMergeView', 'syncUploadReview', 'syncClose', 'syncInspectLocks', 'syncRecoverLocks']);

function syncSession(id) {
  const session = syncSessions.get(id);
  if (!session) throw { code: 'STALE_SESSION', message: 'Synchronization session is no longer active' };
  return session;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, result) {
  send({ id, result });
}

function sendError(id, code, message) {
  send({ id, error: { code, message } });
}

function sendEvent(event, data) {
  send({ event, data });
}

function headersForUrl(parsed, cookie) {
  const headers = { 'User-Agent': 'overleaf-neovim/0.1' };
  if (cookie && parsed.origin === BASE_ORIGIN) {
    headers.Cookie = cookie;
  }
  return headers;
}

function resolveUrl(url) {
  return new URL(url, BASE_URL).toString();
}

function clsiZoneFromServerId(clsiServerId) {
  if (!clsiServerId || typeof clsiServerId !== 'string') return null;

  const parts = clsiServerId.split('-').filter(Boolean);
  return parts[4] || parts[parts.length - 1] || null;
}

function normalizeDownloadDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  const withScheme = domain.match(/^https?:\/\//) ? domain : `https://${domain}`;
  return withScheme.replace(/\/+$/, '');
}

function addCompileOutputParams(downloadUrl, compileResponse) {
  if (compileResponse.compileGroup) {
    downloadUrl.searchParams.set('compileGroup', compileResponse.compileGroup);
  }
  downloadUrl.searchParams.set('clsiserverid', compileResponse.clsiServerId);
  downloadUrl.searchParams.set('enable_pdf_caching', 'true');
  return downloadUrl.toString();
}

function resolveOutputFileUrl(fileUrl, compileResponse) {
  if (!fileUrl) return fileUrl;

  const resolved = new URL(fileUrl, BASE_URL);
  const downloadDomain = normalizeDownloadDomain(compileResponse.pdfDownloadDomain);
  const clsiServerId = compileResponse.clsiServerId;
  const zone = clsiZoneFromServerId(clsiServerId);

  if (downloadDomain && clsiServerId && zone) {
    const base = new URL(downloadDomain);

    if (resolved.pathname.startsWith('/zone/')) {
      const downloadUrl = new URL(`${base.origin}${resolved.pathname}${resolved.search}`);
      return addCompileOutputParams(downloadUrl, compileResponse);
    }

    if (resolved.pathname.startsWith('/project/')) {
      const basePath = base.pathname.replace(/\/+$/, '');
      const zonePrefix = `/zone/${encodeURIComponent(zone)}`;
      const prefix = basePath.endsWith(zonePrefix) ? basePath : `${basePath}${zonePrefix}`;
      const downloadUrl = new URL(`${base.origin}${prefix}${resolved.pathname}${resolved.search}`);
      return addCompileOutputParams(downloadUrl, compileResponse);
    }
  }

  return resolved.toString();
}

function resolveOutputFiles(outputFiles, compileResponse) {
  return (outputFiles || []).map((file) => ({
    ...file,
    url: resolveOutputFileUrl(file.url, compileResponse),
  }));
}

const bridgeError = (code, message) => Object.assign(new Error(message), { code });
const DOWNLOAD_LIMIT = 64 * 1024 * 1024;

async function downloadResponse(url, cookie, redirects = 0, deadline = Date.now() + 30000) {
  if (redirects > 5) throw bridgeError('TOO_MANY_REDIRECTS', 'Too many download redirects');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw bridgeError('DOWNLOAD_FAILED', 'Download URL must use HTTP(S) without embedded credentials');
  }
  const response = await new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'http:' ? http : https).get(parsed,
      { headers: headersForUrl(parsed, cookie) }, res => {
        res.on('error', () => {}); // pipeline below owns errors after the response arrives.
        res.once('close', () => clearTimeout(timer));
        resolve(res);
      });
    const timer = setTimeout(() => req.destroy(bridgeError('DOWNLOAD_FAILED', 'Download timed out')), Math.max(1, deadline - Date.now()));
    timer.unref();
    req.on('error', error => { clearTimeout(timer); reject(error); });
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.destroy();
    return downloadResponse(new URL(response.headers.location, parsed).toString(), cookie, redirects + 1, deadline);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw bridgeError('DOWNLOAD_FAILED', `Download returned HTTP ${response.statusCode}`);
  }
  return response;
}

async function downloadToFile(url, cookie, filePath) {
  const response = await downloadResponse(url, cookie);
  if (Number(response.headers['content-length']) > DOWNLOAD_LIMIT) {
    response.destroy();
    throw bridgeError('FILE_LIMIT', 'Download exceeds 64 MiB');
  }
  let bytes = 0;
  const bounded = new (require('node:stream').Transform)({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > DOWNLOAD_LIMIT ? bridgeError('FILE_LIMIT', 'Download exceeds 64 MiB') : null, chunk);
    },
  });
  try {
    await require('node:stream/promises').pipeline(response, bounded,
      fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error.code === 'FILE_LIMIT') throw error;
    throw bridgeError('DOWNLOAD_FAILED', 'Download was interrupted: ' + error.message);
  }
  if (!response.complete) throw bridgeError('DOWNLOAD_FAILED', 'Download was incomplete');
  if (!bytes) throw bridgeError('EMPTY_DOWNLOAD', 'Downloaded file is empty');
  return { bytes };
}

async function downloadDestination(filename) {
  let stat;
  try { stat = await fs.promises.lstat(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw bridgeError('UNSAFE_DOWNLOAD', 'Download destination must be an ordinary file with one link');
  }
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function downloadArtifact(url, cookie, fileName, outputDir) {
  if (typeof fileName !== 'string' || !fileName || fileName === '.' || fileName === '..'
    || /[\/\\\x00-\x1f\x7f]/.test(fileName) || Buffer.byteLength('overleaf_' + fileName) > 255) {
    throw bridgeError('INVALID_FILENAME', 'Download filename must be one nonempty filename without separators or control characters');
  }
  if (outputDir !== undefined && (typeof outputDir !== 'string' || !outputDir || outputDir.includes('\0'))) {
    throw bridgeError('UNSAFE_DOWNLOAD', 'Download directory must be a filesystem path');
  }
  const requested = path.resolve(outputDir ?? require('os').tmpdir());
  await fs.promises.mkdir(requested, { recursive: true });
  const directory = await fs.promises.realpath(requested);
  const root = await fs.promises.lstat(directory, { bigint: true });
  const destination = path.join(directory, 'overleaf_' + fileName);
  const before = await downloadDestination(destination);
  const stage = await fs.promises.mkdtemp(path.join(directory, '.overleaf-download-'));
  try {
    const temporary = path.join(stage, 'contents');
    const result = await downloadToFile(url, cookie, temporary);
    const handle = await fs.promises.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const currentRoot = await fs.promises.lstat(directory, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino
      || await fs.promises.realpath(directory) !== directory || await downloadDestination(destination) !== before) {
      throw bridgeError('DOWNLOAD_CHANGED', 'Download destination changed; existing file was retained');
    }
    if (before === null) {
      try { await fs.promises.link(temporary, destination); }
      catch (error) {
        if (error.code === 'EEXIST') throw bridgeError('DOWNLOAD_CHANGED', 'Download destination was created while downloading');
        throw error;
      }
    } else await fs.promises.rename(temporary, destination);
    return { path: destination, bytes: result.bytes };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}

// Fetch bounded asset bytes before taking the local mutation queue. No source
// or temporary filename is derived from a remote filename during downloading.
async function downloadAsset(url, cookie) {
  const response = await downloadResponse(url, cookie);
  const limit = 16 * 1024 * 1024;
  if (Number(response.headers['content-length']) > limit) {
    response.destroy();
    throw bridgeError('FILE_LIMIT', 'Asset or log exceeds 16 MiB');
  }
  let count = 0;
  const chunks = [];
  try {
    for await (const chunk of response) {
      count += chunk.length;
      if (count > limit) throw bridgeError('FILE_LIMIT', 'Asset or log exceeds 16 MiB');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.code === 'FILE_LIMIT') throw error;
    throw bridgeError('DOWNLOAD_FAILED', 'Asset or log download was interrupted');
  }
  if (!response.complete) throw bridgeError('DOWNLOAD_FAILED', 'Asset or log download was incomplete');
  return Buffer.concat(chunks);
}

const handlers = {
  async syncLocate(params) {
    return SyncSession.locate(params);
  },

  async ping(params) {
    return { status: 'ok' };
  },

  async rebaseEditorHistory(params) {
    return await rebaseHistory(params.history, params.content);
  },

  async syncOpen(params) {
    const session = await SyncSession.open(params, event => sendEvent('syncChanged', event));
    syncSessions.set(session.id, session);
    return session.describe();
  },

  async syncInspectLocks(params) {
    return SyncSession.inspectLocks(params);
  },

  async syncRecoverLocks(params) {
    return SyncSession.recoverLocks(params.review);
  },

  async syncDocument(params) {
    const reply = await syncSession(params.session).document(params);
    if (params.action === 'remote') {
      sendEvent('syncChanged', { session: reply.session, document: reply.document, revision: reply.revision });
    }
    return reply;
  },

  async syncUploadReview(params) {
    return syncSession(params.session).reviewUpload(params);
  },

  async syncMergeView(params) {
    const session = syncSession(params.session);
    if (session._closing) throw bridgeError('SESSION_CLOSED', 'Project is closing');
    const root = path.join(session.directory, 'merge-views');
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw bridgeError('UNSAFE_PATH', 'Merge views need a private directory');
    return require('./sync/merge').createConflictWorkspace(params.inputs, params.candidate, { root });
  },

  async syncComment(params) {
    const session = syncSession(params.session);
    if (new URL(session.server).origin !== BASE_ORIGIN || !params.cookie || !params.csrfToken) {
      throw { code: 'COMMENT_UNAVAILABLE', message: 'Comment authentication must belong to this project server' };
    }
    if (params.action === 'inspect') {
      const snapshot = (await session.document({ document: params.document, action: 'snapshot' })).result;
      const draft = snapshot.comments?.find(value => value.token === params.token);
      if (!draft) throw { code: 'STALE_COMMENT', message: 'Comment draft is no longer current' };
      const response = await auth.httpGet(`${session.server}/project/${encodeURIComponent(session.projectId)}/threads`, params.cookie);
      if (response.status !== 200) throw { code: 'THREADS_FAILED', message: `Get threads failed: ${response.status}` };
      const thread = JSON.parse(response.body)[draft.thread];
      if (!thread?.messages?.some(message => message.content === draft.message)) {
        return { status: 'unconfirmed', thread: draft.thread, token: draft.token };
      }
      const confirmed = await session.document({ document: params.document, action: 'confirmComment', token: draft.token });
      return { status: confirmed.result.held ? 'held' : 'queued', thread: draft.thread, token: draft.token };
    }
    if (params.action !== undefined && params.action !== 'create') throw { code: 'UNKNOWN_ACTION', message: 'Unknown comment action' };
    const reply = await session.document({ document: params.document, action: 'stageComment', selection: params.selection });
    const draft = reply.result;
    const url = `${session.server}/project/${encodeURIComponent(session.projectId)}/thread/${encodeURIComponent(draft.thread)}/messages`;
    try {
      const response = await auth.httpPost(url, params.cookie, params.csrfToken, { content: draft.message });
      if (![200, 201, 204].includes(response.status)) throw Error(`Server returned ${response.status}`);
    } catch (error) {
      // The request may have succeeded. Never repeat it: the durable draft and
      // unique thread ID let a later review inspect the outcome without posting.
      throw { code: 'COMMENT_UNCERTAIN', message: `Comment draft ${draft.thread} retained; inspect it with :Overleaf comments drafts. ${error.message}` };
    }
    const confirmed = await session.document({ document: params.document, action: 'confirmComment', token: draft.token });
    return { thread: draft.thread, token: draft.token, status: confirmed.result.held ? 'held' : 'queued' };
  },

  async syncAsset(params) {
    return syncSession(params.session).asset(params);
  },

  async syncAssetLifecycle(params) {
    return syncSession(params.session).assetLifecycle(params);
  },

  async syncProject(params) {
    return { session: params.session, project: await syncSession(params.session).project(params.project) };
  },

  async syncListProjects(params) {
    return { projects: await SyncSession.listProjects(params) };
  },

  async syncCaptureBuild(params) {
    return syncSession(params.session).captureBuild(params);
  },

  async syncFinishBuild(params) {
    return syncSession(params.session).finishBuild(params);
  },

  async syncLegacyInventory(params) {
    return require('./sync/workspace').Workspace.inventoryLegacy(params.directory);
  },

  async syncLegacyRead(params) {
    return require('./sync/workspace').Workspace.readLegacy(params.filename);
  },

  async syncFetchAsset(params) {
    const session = syncSession(params.session);
    if (new URL(session.server).origin !== BASE_ORIGIN) throw { code: 'CONNECTION_MISMATCH', message: 'Asset server does not match this bridge' };
    if (typeof params.document !== 'string' || !params.document || typeof params.cookie !== 'string' || !params.cookie) {
      throw { code: 'MISSING_PARAM', message: 'Asset identity and authentication are required' };
    }
    const url = `${session.server}/project/${encodeURIComponent(session.projectId)}/file/${encodeURIComponent(params.document)}`;
    const bytes = await downloadAsset(url, params.cookie);
    return syncSession(params.session).asset({ document: params.document, path: params.path, bytes: bytes.toString('base64') });
  },

  async syncClose(params) {
    await syncSession(params.session).close();
    syncSessions.delete(params.session);
    return { session: params.session, closed: true };
  },

  async syncConnect(params) {
    if (!socketManager) throw { code: 'NOT_CONNECTED', message: 'Not connected to a project' };
    const session = syncSession(params.session);
    return { session: session.id, document: params.document,
      transport: await session.connectDocument(params.document, socketManager) };
  },

  async listBrowserProfiles(params) {
    const profiles = listProfiles();
    return { profiles };
  },

  async getCookie(params) {
    const cookie = await getOverleafCookie(params.browser, params.profile);
    return { cookie };
  },

  async auth(params) {
    const { cookie } = params;
    if (!cookie) throw { code: 'MISSING_PARAM', message: 'cookie is required' };
    return await auth.fetchProjectPage(cookie);
  },

  async connect(params) {
    let { cookie, projectId } = params;
    if (!cookie || !projectId) {
      throw { code: 'MISSING_PARAM', message: 'cookie and projectId are required' };
    }
    const generation = ++connectionGeneration;
    socketManager?.disconnect();
    socketManager = null;

    // Fetch GCLB cookie for load balancer stickiness (skip for local/test servers)
    if (!process.env.OVERLEAF_URL) {
      cookie = await auth.updateCookies(cookie);
      console.log('Updated cookies for socket connection');
    }

    if (generation !== connectionGeneration) throw { code: 'CONNECTION_REPLACED', message: 'A newer project connection replaced this request' };
    const manager = new SocketManager(cookie, projectId, sendEvent);
    socketManager = manager;
    try {
      const result = await manager.connect();
      if (generation !== connectionGeneration) throw { code: 'CONNECTION_REPLACED', message: 'A newer project connection replaced this request' };
      return result;
    } catch (error) {
      manager.disconnect();
      if (socketManager === manager) socketManager = null;
      throw error;
    }
  },

  async joinDoc(params) {
    const { docId } = params;
    if (!socketManager) throw { code: 'NOT_CONNECTED', message: 'Not connected to a project' };
    if (!docId) throw { code: 'MISSING_PARAM', message: 'docId is required' };
    return await socketManager.joinDoc(docId);
  },

  async leaveDoc(params) {
    const { docId } = params;
    if (!socketManager) throw { code: 'NOT_CONNECTED', message: 'Not connected to a project' };
    if (!docId) throw { code: 'MISSING_PARAM', message: 'docId is required' };
    return await socketManager.leaveDoc(docId);
  },

  async applyOtUpdate(params) {
    const { docId, op, v, content } = params;
    if (!socketManager) throw { code: 'NOT_CONNECTED', message: 'Not connected to a project' };
    if (!docId || op === undefined || v === undefined) {
      throw { code: 'MISSING_PARAM', message: 'docId, op, and v are required' };
    }
    return await socketManager.applyOtUpdate(docId, op, v, content);
  },

  async compile(params) {
    const { cookie, csrfToken, projectId } = params;
    if (!cookie || !csrfToken || !projectId) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, and projectId are required' };
    }

    const compileRes = await auth.httpPost(
      `${BASE_URL}/project/${projectId}/compile?auto_compile=true`,
      cookie, csrfToken,
      { check: 'silent', draft: false, incrementalCompilesEnabled: true, stopOnFirstError: false }
    );

    if (compileRes.status !== 200) {
      throw { code: 'COMPILE_ERROR', message: `Compile request failed with status ${compileRes.status}` };
    }

    const parsed = JSON.parse(compileRes.body);

    const outputFiles = resolveOutputFiles(parsed.outputFiles || [], parsed);

    // Download log if available
    const logFile = outputFiles.find(f => f.path === 'output.log');
    let log = '';
    if (logFile) {
      log = (await downloadAsset(logFile.url, cookie)).toString('utf8');
    }

    return { status: parsed.status, outputFiles, log };
  },

  async syncCompile(params) {
    const session = syncSession(params.session);
    const manager = socketManager;
    const current = () => {
      if (!manager?.connected || socketManager !== manager || session._closing
        || session.server !== manager.server || session.projectId !== manager.projectId
        || params.projectId !== session.projectId) {
        throw bridgeError('COMPILE_OFFLINE', 'Project connection changed before compilation');
      }
    };
    current();
    const captured = await session.captureBuild({ inspectOnly: true });
    const deadline = Date.now() + 15000;
    for (;;) {
      current();
      const status = await session.compileReady(captured);
      current();
      if (status.ready) break;
      if (Date.now() >= deadline) {
        throw bridgeError('COMPILE_PENDING', 'Saved revisions are still awaiting confirmation: ' + status.pending.join(', '));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return handlers.compile(params);
  },

  async downloadUrl(params) {
    const { cookie, url, fileName, outputDir } = params;
    if (!cookie || !url) {
      throw { code: 'MISSING_PARAM', message: 'cookie and url are required' };
    }

    return downloadArtifact(url, cookie, fileName ?? 'download', outputDir);
  },

  async downloadFile(params) {
    const { cookie, projectId, fileId, fileName, outputDir } = params;
    if (!cookie || typeof projectId !== 'string' || !projectId || typeof fileId !== 'string' || !fileId
      || ['.', '..'].includes(projectId) || ['.', '..'].includes(fileId)) {
      throw { code: 'MISSING_PARAM', message: 'cookie, projectId, and fileId are required' };
    }
    const url = `${BASE_URL}/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`;
    return downloadArtifact(url, cookie, fileName ?? fileId, outputDir);
  },

  async createDoc(params) {
    const { cookie, csrfToken, projectId, name, parentFolderId } = params;
    if (!cookie || !csrfToken || !projectId || !name) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and name are required' };
    }
    const res = await auth.httpPost(
      `${BASE_URL}/project/${projectId}/doc`,
      cookie, csrfToken,
      { name, parent_folder_id: parentFolderId || null }
    );
    if (res.status !== 200) {
      throw { code: 'CREATE_FAILED', message: `Create doc failed: ${res.status} ${res.body}` };
    }
    return JSON.parse(res.body);
  },

  async createFolder(params) {
    const { cookie, csrfToken, projectId, name, parentFolderId } = params;
    if (!cookie || !csrfToken || !projectId || !name) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and name are required' };
    }
    const res = await auth.httpPost(
      `${BASE_URL}/project/${projectId}/folder`,
      cookie, csrfToken,
      { name, parent_folder_id: parentFolderId || null }
    );
    if (res.status !== 200) {
      throw { code: 'CREATE_FAILED', message: `Create folder failed: ${res.status} ${res.body}` };
    }
    return JSON.parse(res.body);
  },

  async renameEntity(params) {
    const { cookie, csrfToken, projectId, entityId, entityType, newName } = params;
    if (!cookie || !csrfToken || !projectId || !entityId || !entityType || !newName) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, entityId, entityType, and newName are required' };
    }
    const res = await auth.httpPost(
      `${BASE_URL}/project/${projectId}/${entityType}/${entityId}/rename`,
      cookie, csrfToken,
      { name: newName }
    );
    if (res.status !== 204 && res.status !== 200) {
      throw { code: 'RENAME_FAILED', message: `Rename failed: ${res.status} ${res.body}` };
    }
    return {};
  },

  async deleteEntity(params) {
    const { cookie, csrfToken, projectId, entityId, entityType } = params;
    if (!cookie || !csrfToken || !projectId || !entityId || !entityType) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, entityId, and entityType are required' };
    }
    const res = await auth.httpDelete(
      `${BASE_URL}/project/${projectId}/${entityType}/${entityId}`,
      cookie, csrfToken
    );
    if (res.status !== 204 && res.status !== 200) {
      throw { code: 'DELETE_FAILED', message: `Delete failed: ${res.status}` };
    }
    return {};
  },

  async uploadFile(params) {
    const { cookie, csrfToken, projectId, filePath, fileName, parentFolderId } = params;
    if (!cookie || !csrfToken || !projectId || !filePath) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and filePath are required' };
    }
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      throw { code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` };
    }
    const folderId = parentFolderId || 'rootFolder';
    const url = `${BASE_URL}/project/${projectId}/upload?folder_id=${folderId}`;
    const res = await auth.httpPostMultipart(url, cookie, csrfToken, filePath, fileName);
    if (res.status !== 200) {
      throw { code: 'UPLOAD_FAILED', message: `Upload failed: ${res.status} ${res.body}` };
    }
    return JSON.parse(res.body);
  },

  async getHistory(params) {
    const { cookie, projectId, minCount } = params;
    if (!cookie || !projectId) {
      throw { code: 'MISSING_PARAM', message: 'cookie and projectId are required' };
    }
    const res = await auth.httpGet(
      `${BASE_URL}/project/${projectId}/updates?min_count=${minCount || 15}`,
      cookie
    );
    if (res.status !== 200) {
      throw { code: 'HISTORY_FAILED', message: `History request failed: ${res.status}` };
    }
    return JSON.parse(res.body);
  },

  async getThreads(params) {
    const { cookie, projectId } = params;
    if (!cookie || !projectId) {
      throw { code: 'MISSING_PARAM', message: 'cookie and projectId are required' };
    }
    const res = await auth.httpGet(
      `${BASE_URL}/project/${projectId}/threads`,
      cookie
    );
    if (res.status !== 200) {
      throw { code: 'THREADS_FAILED', message: `Get threads failed: ${res.status}` };
    }
    return JSON.parse(res.body);
  },

  async addComment(params) {
    const { cookie, csrfToken, projectId, threadId, content } = params;
    if (!cookie || !csrfToken || !projectId || !threadId || !content) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, threadId, and content are required' };
    }
    const res = await auth.httpPost(
      `${BASE_URL}/project/${projectId}/thread/${threadId}/messages`,
      cookie, csrfToken,
      { content }
    );
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw { code: 'COMMENT_FAILED', message: `Add comment failed: ${res.status}` };
    }
    try { return JSON.parse(res.body); } catch (e) { return {}; }
  },

  async resolveThread(params) {
    const { cookie, csrfToken, projectId, docId, threadId } = params;
    if (!cookie || !csrfToken || !projectId || !threadId) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and threadId are required' };
    }
    const url = docId
      ? `${BASE_URL}/project/${projectId}/doc/${docId}/thread/${threadId}/resolve`
      : `${BASE_URL}/project/${projectId}/thread/${threadId}/resolve`;
    const res = await auth.httpPost(url, cookie, csrfToken, {});
    if (res.status < 200 || res.status >= 300) {
      throw { code: 'RESOLVE_FAILED', message: `Resolve thread failed: ${res.status}` };
    }
    return {};
  },

  async reopenThread(params) {
    const { cookie, csrfToken, projectId, docId, threadId } = params;
    if (!cookie || !csrfToken || !projectId || !threadId) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and threadId are required' };
    }
    const url = docId
      ? `${BASE_URL}/project/${projectId}/doc/${docId}/thread/${threadId}/reopen`
      : `${BASE_URL}/project/${projectId}/thread/${threadId}/reopen`;
    const res = await auth.httpPost(url, cookie, csrfToken, {});
    if (res.status < 200 || res.status >= 300) {
      throw { code: 'REOPEN_FAILED', message: `Reopen thread failed: ${res.status}` };
    }
    return {};
  },

  async deleteThread(params) {
    const { cookie, csrfToken, projectId, docId, threadId } = params;
    if (!cookie || !csrfToken || !projectId || !threadId) {
      throw { code: 'MISSING_PARAM', message: 'cookie, csrfToken, projectId, and threadId are required' };
    }
    const url = docId
      ? `${BASE_URL}/project/${projectId}/doc/${docId}/thread/${threadId}`
      : `${BASE_URL}/project/${projectId}/thread/${threadId}`;
    const res = await auth.httpDelete(url, cookie, csrfToken);
    if (res.status !== 200 && res.status !== 204) {
      throw { code: 'DELETE_FAILED', message: `Delete thread failed: ${res.status}` };
    }
    return {};
  },

  async disconnect() {
    connectionGeneration++;
    if (socketManager) {
      socketManager.disconnect();
      socketManager = null;
    }
    return {};
  },
};

function maybeExit() {
  if (stdinClosed && (pendingRequests === 0 || (abandonNetwork && pendingSyncRequests === 0)) && !exiting) {
    exiting = true;
    if (socketManager) {
      socketManager.disconnect();
      socketManager = null;
    }
    Promise.all([...syncSessions.values()].map(session => session.close())).then(
      () => process.exit(0),
      error => { console.error('Recovery store close failed:', error.message); process.exit(1); }
    );
  }
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    console.log('Failed to parse message:', line);
    return;
  }

  const { id, method, params } = msg;
  if (!method || id === undefined) {
    console.log('Invalid message format:', line);
    return;
  }

  const handler = handlers[method];
  if (!handler) {
    sendError(id, 'UNKNOWN_METHOD', `Unknown method: ${method}`);
    return;
  }

  pendingRequests++;
  const persists = syncMethods.has(method);
  if (persists) pendingSyncRequests++;
  try {
    const result = await handler(params || {});
    sendResult(id, result);
  } catch (err) {
    const code = err.code || 'INTERNAL_ERROR';
    const message = err.message || String(err);
    sendError(id, code, message);
  } finally {
    pendingRequests--;
    if (persists) pendingSyncRequests--;
    maybeExit();
  }
}

// stdin line reader
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  if (line.trim()) {
    handleMessage(line.trim());
  }
});

rl.on('close', () => {
  console.log('stdin closed');
  stdinClosed = true;
  if (socketManager) {
    socketManager.disconnect();
    socketManager = null;
  }
  maybeExit();
  // A stalled network request must not prevent shutdown indefinitely, but this
  // deadline never interrupts an accepted recovery operation or store close.
  setTimeout(() => { abandonNetwork = true; maybeExit(); }, 5000).unref();
  // Clean EOF drains accepted persistence work. SIGTERM/SIGKILL remain abrupt
  // exits and deliberately leave writer locks for explicit recovery.
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  if (socketManager) {
    socketManager.disconnect();
  }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.log('Uncaught exception:', err.message);
  sendEvent('error', { message: err.message });
});

console.log('Bridge started');
