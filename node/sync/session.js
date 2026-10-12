'use strict';

const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { SnapshotStore } = require('./store');
const { DocumentEngine } = require('./engine');
const { decodeBytes, editorText } = require('./codec');

const failure = (code, message) => Object.assign(new Error(message), { code });
const actions = new Set(['open', 'state', 'snapshot', 'remote', 'checkpoint', 'save', 'prepare', 'accept', 'hold']);

/** One project writer, with per-document ordering and a process-local identity.
 * This layer does not read/write project sources or send anything to Overleaf. */
class SyncSession {
  static async open({ root, server, projectId }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)
      || typeof projectId !== 'string' || !projectId.length) throw new TypeError('Recovery root and project ID are required');
    const url = new URL(server);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('Server must be an HTTP(S) base URL without credentials, query, or fragment');
    }
    const identity = JSON.stringify([url.href.replace(/\/+$/, ''), projectId]);
    const key = createHash('sha256').update(identity).digest('hex');
    return new SyncSession(await SnapshotStore.open(path.join(root, key)));
  }

  constructor(store) {
    this.id = randomUUID();
    this.directory = store.directory;
    this._store = store;
    this._documents = new Map();
    this._queues = new Map();
    this._closing = null;
  }

  document(params) {
    if (this._closing) return Promise.reject(failure('SESSION_CLOSED', 'Project session is closing or closed'));
    const captured = structuredClone(params);
    const { document, action } = captured;
    if (typeof document !== 'string' || !document.length) return Promise.reject(new TypeError('Document ID is required'));
    if (!actions.has(action)) return Promise.reject(failure('UNKNOWN_ACTION', 'Unsupported synchronization action'));
    const previous = this._queues.get(document) ?? Promise.resolve();
    const request = previous.catch(() => {}).then(async () => {
      let engine = this._documents.get(document);
      let result = null;
      if (action === 'open') {
        if (engine) throw failure('DOCUMENT_OPEN', 'Document already belongs to this session');
        engine = await DocumentEngine.open(this._store, document, captured.initial);
        this._documents.set(document, engine);
      } else {
        if (!engine) throw failure('DOCUMENT_NOT_OPEN', 'Open the document before submitting events');
        switch (action) {
          case 'snapshot': result = engine.snapshot(); break;
          case 'remote': await engine.receiveRemote(captured.remote); break;
          case 'checkpoint': await engine.checkpointEditor(captured.checkpoint, captured.revision); break;
          case 'save': {
            const encoded = captured.bytes;
            if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(16 * 1024 * 1024 / 3)
              || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
              throw new TypeError('Saved file bytes must be canonical base64 within the 16 MiB limit');
            }
            const content = editorText(decodeBytes(Buffer.from(encoded, 'base64'), captured.checkpoint?.options));
            result = await engine.saveEditor(captured.checkpoint, captured.revision, content);
            break;
          }
          case 'prepare': result = await engine.prepareEditorUpdate(captured.revision); break;
          case 'accept': await engine.acceptEditorUpdate(captured.token, captured.checkpoint); break;
          case 'hold': await engine.holdEditorUpdate(captured.token, captured.reason); break;
        }
      }
      const state = engine.snapshot();
      return {
        session: this.id, document, revision: state.revision, result,
        state: {
          buffer: state.buffer, saved: state.saved, remoteVersion: state.remote.version,
          conflict: state.conflict, held: state.editor?.held ?? null,
          editorAttached: !!state.editor,
        },
      };
    });
    this._queues.set(document, request);
    return request;
  }

  close() {
    if (!this._closing) {
      this._closing = (async () => {
        // Include engine work that has been accepted but has not yet enqueued
        // its store write. Store.close alone cannot drain those operations.
        await Promise.allSettled(this._queues.values());
        await this._store.close();
      })();
    }
    return this._closing;
  }
}

module.exports = { SyncSession };
