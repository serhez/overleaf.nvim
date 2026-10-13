'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('node:events');
const { validateText } = require('./sync/merge');
const failure = (code, message) => Object.assign(new Error(message), { code });
const wireDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeWireText(value) {
  if (typeof value !== 'string' || /[^\x00-\xff]/.test(value)) throw failure('INVALID_SNAPSHOT', 'Snapshot text is not encoded as Latin-1 bytes');
  try {
    const decoded = wireDecoder.decode(Buffer.from(value, 'latin1'));
    validateText(decoded, 'decoded snapshot');
    return decoded;
  } catch { throw failure('INVALID_SNAPSHOT', 'Snapshot contains invalid UTF-8 text'); }
}

// Monkey-patch socket.io-client v0.9 to support extraHeaders in Node.js.
// The stock v0.9 client does not send Cookie/Origin headers in its
// handshake (xmlhttprequest blocks Cookie) or WebSocket transport.
(function patchSocketIO() {
  const io = require('socket.io-client');

  // 1. Replace handshake to use Node.js https (bypasses xmlhttprequest)
  io.Socket.prototype.handshake = function (fn) {
    const self = this;
    const options = this.options;
    const extraHeaders = options.extraHeaders || {};

    const scheme = options.secure === false ? 'http:/' : 'https:/';
    const handshakeUrl = [
      scheme,
      options.host + ':' + options.port,
      options.resource,
      io.protocol,
      '?t=' + Date.now(),
    ].join('/');
    const queryStr = options.query || '';
    const fullUrl = queryStr ? handshakeUrl + '&' + queryStr : handshakeUrl;
    const parsed = new (require('url').URL)(fullUrl);

    const httpModule = parsed.protocol === 'http:' ? require('http') : require('https');
    const req = httpModule.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: Object.assign({}, extraHeaders),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          fn.apply(null, body.split(':'));
        } else {
          self.connecting = false;
          self.onError(new Error('Handshake failed: ' + res.statusCode));
        }
      });
    });
    req.on('error', (err) => { self.connecting = false; self.onError(err); });
    req.setTimeout(15000, () => req.destroy(new Error('Handshake timeout')));
    req.end();
  };

  // 2. Replace WebSocket open to pass extraHeaders
  io.Transport.websocket.prototype.open = function () {
    const query = io.util.query(this.socket.options.query);
    const WS = require('ws');
    const wsOpts = {};
    if (this.socket.options.extraHeaders) {
      wsOpts.headers = this.socket.options.extraHeaders;
    }
    this.websocket = new WS(this.prepareUrl() + query, wsOpts);

    const self = this;
    this.websocket.onopen = function () { self.onOpen(); self.socket.setBuffer(false); };
    this.websocket.onmessage = function (ev) { self.onData(ev.data); };
    this.websocket.onclose = function () { self.onClose(); self.socket.setBuffer(true); };
    this.websocket.onerror = function (e) { self.onError(e); };
    return this;
  };
})();

class SocketManager {
  constructor(cookie, projectId, sendEvent) {
    this.cookie = cookie;
    this.projectId = projectId;
    this.server = new URL(process.env.OVERLEAF_URL || 'https://www.overleaf.com').href.replace(/\/+$/, '');
    this.sendEvent = sendEvent;
    this.socket = null;
    this.connected = false;
    this.events = new EventEmitter();
    this.documents = new Set();
    this.events.setMaxListeners(0); // One subscription per document, removed on detach.
  }

  connect() {
    if (this.socket) this.disconnect();
    return new Promise((resolve, reject) => {
      const io = require('socket.io-client');
      const url = this.server;

      // Connect with v2 scheme (projectId in query) - used by overleaf.com
      const queryUrl = `${url}?projectId=${this.projectId}&t=${Date.now()}`;
      this.socket = io.connect(queryUrl, {
        reconnect: false,
        'force new connection': true,
        extraHeaders: {
          'Cookie': this.cookie,
          'Origin': url,
        },
      });

      const timeout = setTimeout(() => {
        finish({ code: 'TIMEOUT', message: 'Connection timeout (15s)' });
      }, 15000);
      const socket = this.socket;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._cancelConnect = null;
        if (error) reject(error);
        else resolve(value);
      };
      this._cancelConnect = () => finish({ code: 'CONNECTION_REPLACED', message: 'Project connection was replaced or disconnected' });

      // v2 scheme: server sends joinProjectResponse automatically
      this.socket.on('joinProjectResponse', (data) => {
        if (settled || this.socket !== socket) return;
        this.connected = true;
        this.publicId = data.publicId;
        this._setupEventHandlers();
        finish(null, {
          publicId: data.publicId,
          project: data.project,
          permissionsLevel: data.permissionsLevel,
          protocolVersion: data.protocolVersion,
        });
      });

      // v1 scheme fallback: connectionAccepted (for self-hosted instances)
      this.socket.on('connectionAccepted', (_, publicId) => {
        if (settled || this.socket !== socket) return;
        console.log('connectionAccepted (v1), joining project...');
        this.socket.emit('joinProject', { project_id: this.projectId }, (err, project, permissionsLevel, protocolVersion) => {
          if (settled || this.socket !== socket) return;
          if (err) {
            finish({ code: 'JOIN_FAILED', message: err.message || String(err) });
            return;
          }
          this.connected = true;
          this.publicId = publicId;
          this._setupEventHandlers();
          finish(null, {
            publicId,
            project,
            permissionsLevel,
            protocolVersion,
          });
        });
      });

      this.socket.on('connect_failed', () => {
        finish({ code: 'CONNECT_FAILED', message: 'Socket.IO connection failed' });
      });

      this.socket.on('error', (err) => {
        finish({ code: 'SOCKET_ERROR', message: String(err) });
      });
    });
  }

  _setupEventHandlers() {
    const socket = this.socket;
    if (this._observedSocket === socket) return;
    this._observedSocket = socket;
    const active = () => this.socket === socket && this.connected;
    // Log ALL incoming socket events for debugging
    const originalOnevent = this.socket.onevent;
    this.socket.onevent = (packet) => {
      const eventName = packet.data ? packet.data[0] : 'unknown';
      if (!['clientTracking.clientUpdated'].includes(eventName)) {
        console.log('[socket event]', eventName);
      }
      originalOnevent.call(this.socket, packet);
    };

    this.socket.on('otUpdateApplied', (update) => {
      if (!active()) return;
      this.events.emit('applied', update);
      console.log('[otUpdateApplied] doc=' + (update && update.doc) + ' v=' + (update && update.v) + ' hasOp=' + !!(update && update.op));
      this.sendEvent('otUpdateApplied', update);
    });

    this.socket.on('otUpdateError', (err, metadata) => {
      if (!active()) return;
      this.events.emit('interrupted', { reason: 'ot-error', document: metadata?.doc_id ?? err?.doc, message: String(err?.message ?? err) });
      console.log('[otUpdateError]', JSON.stringify(err));
      this.sendEvent('otUpdateError', err);
    });

    this.socket.on('disconnect', (reason) => {
      if (!active()) return;
      this.events.emit('interrupted', { reason: 'disconnect' });
      console.log('[disconnect] reason=' + reason);
      this.connected = false;
      this.sendEvent('disconnect', { reason: reason || 'server disconnected' });
    });

    this.socket.on('forceDisconnect', (message, delay) => {
      if (!active()) return;
      this.events.emit('interrupted', { reason: 'disconnect' });
      console.log('[forceDisconnect] message=' + message);
      this.connected = false;
      this.sendEvent('disconnect', { reason: `force disconnect: ${message}` });
    });

    // File tree events (forward for future use)
    this.socket.on('reciveNewDoc', (parentFolderId, doc, meta, userId) => {
      if (!active()) return;
      this.sendEvent('reciveNewDoc', { parentFolderId, doc, meta: meta || {} });
    });

    this.socket.on('reciveNewFile', (parentFolderId, file, meta, userId) => {
      if (!active()) return;
      this.sendEvent('reciveNewFile', { parentFolderId, file, meta: meta || {} });
    });

    this.socket.on('removeEntity', (entityId, meta) => {
      if (!active()) return;
      this.sendEvent('removeEntity', { entityId, meta: meta || {} });
    });

    this.socket.on('rootDocUpdated', (newRootDocId) => {
      if (!active()) return;
      this.sendEvent('rootDocUpdated', { docId: newRootDocId });
    });

    this.socket.on('reciveEntityRename', (entityId, newName) => {
      if (active()) this.sendEvent('reciveEntityRename', { entityId, newName });
    });
    this.socket.on('reciveEntityMove', (entityId, folderId) => {
      if (active()) this.sendEvent('reciveEntityMove', { entityId, folderId });
    });
    this.socket.on('reciveNewFolder', (parentFolderId, folder) => {
      if (active()) this.sendEvent('reciveNewFolder', { parentFolderId, folder });
    });
    this.socket.on('projectNameUpdated', name => {
      if (active()) this.sendEvent('projectNameUpdated', { name });
    });

    // Comment/thread events
    this.socket.on('new-comment', (threadId, comment) => {
      if (!active()) return;
      this.sendEvent('newComment', { threadId, comment });
    });

    this.socket.on('resolve-thread', (threadId, user) => {
      if (!active()) return;
      this.sendEvent('resolveThread', { threadId, user });
    });

    this.socket.on('reopen-thread', (threadId) => {
      if (!active()) return;
      this.sendEvent('reopenThread', { threadId });
    });

    this.socket.on('delete-thread', (threadId) => {
      if (!active()) return;
      this.sendEvent('deleteThread', { threadId });
    });

    // Collaborator tracking
    this.socket.on('clientTracking.clientUpdated', (user) => {
      if (!active()) return;
      this.sendEvent('clientUpdated', user);
    });

    this.socket.on('clientTracking.clientDisconnected', (id) => {
      if (!active()) return;
      this.sendEvent('clientDisconnected', { id });
    });
  }

  _promisifiedEmit(event, ...args) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject({ code: 'TIMEOUT', message: `${event} timeout (10s)` });
      }, 10000);

      this.socket.emit(event, ...args, (err, ...data) => {
        clearTimeout(timeout);
        if (err) {
          console.log(`${event} error:`, JSON.stringify(err));
          reject({ code: 'EMIT_ERROR', message: err.message || String(err) });
        } else {
          resolve(data);
        }
      });
    });
  }

  async joinDoc(docId, fromVersion = -1) {
    const data = await this._promisifiedEmit('joinDoc', docId, fromVersion, { encodeRanges: true });
    const [docLines, version, updates, ranges, type, capabilities] = data;
    if (type !== undefined && type !== null && type !== 'sharejs-text-ot') {
      throw failure('UNSUPPORTED_OT', 'Document uses an unsupported operation format: ' + type);
    }
    if (!Array.isArray(docLines) || !Number.isSafeInteger(version) || version < 0 || (updates !== undefined && !Array.isArray(updates))) {
      throw failure('INVALID_SNAPSHOT', 'Document snapshot has an invalid shape or version');
    }
    const lines = docLines.map(decodeWireText);
    let decodedRanges;
    try { decodedRanges = typeof ranges === 'string' ? JSON.parse(ranges) : structuredClone(ranges ?? {}); }
    catch { throw failure('INVALID_SNAPSHOT', 'Document ranges are malformed'); }
    if (!decodedRanges || typeof decodedRanges !== 'object' || Array.isArray(decodedRanges)) {
      throw failure('INVALID_SNAPSHOT', 'Document ranges must be an object');
    }
    for (const key of ['comments', 'changes']) {
      if (decodedRanges[key] !== undefined && !Array.isArray(decodedRanges[key])) throw failure('INVALID_SNAPSHOT', 'Document ranges must be arrays');
      for (const range of decodedRanges[key] ?? []) {
        for (const field of ['c', 'i', 'd']) {
          if (range?.op?.[field] !== undefined) range.op[field] = decodeWireText(range.op[field]);
        }
      }
    }
    // Typed ShareJS joins use getDocAndRecentOpsWithLock, which drains queued
    // updates before reading the snapshot. Untyped older responses do not
    // establish that contract for negative acknowledgement recovery.
    return { lines, version, updates: updates ?? [], ranges: decodedRanges, type: type ?? 'sharejs-text-ot',
      queueDrained: type === 'sharejs-text-ot', capabilities: capabilities ?? {} };
  }

  observeDocument(document, handlers) {
    if (typeof handlers.failed !== 'function') throw new TypeError('Document observer needs a failure handler');
    if (this.documents.has(document)) throw failure('DOCUMENT_OWNED', 'Document already has a saved-change transport');
    this.documents.add(document);
    const failed = error => {
      try { Promise.resolve(handlers.failed(error)).catch(error => console.error('Document recovery failed:', error.message)); }
      catch (error) { console.error('Document recovery failed:', error.message); }
    };
    const deliver = (handler, value) => {
      try { Promise.resolve(handler(value)).catch(failed); }
      catch (error) { failed(error); }
    };
    const applied = update => { if (update?.doc === document) deliver(handlers.applied, update); };
    const interrupted = detail => {
      if (!detail.document || detail.document === document) deliver(handlers.interrupted, detail);
    };
    this.events.on('applied', applied);
    this.events.on('interrupted', interrupted);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.documents.delete(document);
      this.events.off('applied', applied); this.events.off('interrupted', interrupted);
    };
  }

  async sendUpdate(update) {
    if (!this.connected || !this.socket) throw failure('NOT_CONNECTED', 'Document connection is closed');
    await this._promisifiedEmit('applyOtUpdate', update.doc, structuredClone(update));
  }

  async leaveDoc(docId) {
    if (this.documents.has(docId)) throw failure('DOCUMENT_OWNED', 'Document subscription belongs to the saved-change transport');
    // leaveDoc is fire-and-forget (server may not send callback)
    this.socket.emit('leaveDoc', docId);
    return {};
  }

  async applyOtUpdate(docId, op, version, content) {
    if (this.documents.has(docId)) throw failure('DOCUMENT_OWNED', 'Save through the document session before uploading changes');
    const update = {
      doc: docId,
      op: op,
      v: version,
      lastV: version,
    };

    // Compute SHA1 hash on content AFTER applying ops (git blob format)
    // content param is the server_content BEFORE ops; apply ops to get new content
    if (content !== undefined && content !== null) {
      let newContent = content;
      for (const o of op) {
        if (o.d) {
          newContent = newContent.slice(0, o.p) + newContent.slice(o.p + o.d.length);
        }
        if (o.i) {
          newContent = newContent.slice(0, o.p) + o.i + newContent.slice(o.p);
        }
      }
      // Use JS string length (character count) - matches Overleaf's sharejs
      update.hash = crypto
        .createHash('sha1')
        .update('blob ' + newContent.length + '\x00' + newContent)
        .digest('hex');
    }

    await this._promisifiedEmit('applyOtUpdate', docId, update);
    return {};
  }

  disconnect() {
    this._cancelConnect?.();
    if (this.connected) this.events.emit('interrupted', { reason: 'disconnect' });
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch (e) {
        console.log('Error during disconnect:', e.message);
      }
      this.socket = null;
      this.connected = false;
    }
  }
}

module.exports = SocketManager;
