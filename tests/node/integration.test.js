#!/usr/bin/env node
'use strict';

/**
 * Integration tests for the overleaf-neovim bridge.
 *
 * Tests the full flow: bridge.js → socket.js → mock OT server,
 * exercising the JSON-RPC protocol, OT updates, hash validation,
 * and error handling.
 *
 * Usage: node tests/node/integration.test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createServer, getOrCreateDoc, resetDocs, broadcastEvent, simulateRestore } = require('./mock-server');

// ── Test framework ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error('Assertion failed: ' + message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(str, substr, message) {
  if (!str || !str.includes(substr)) {
    throw new Error(
      `${message || 'assertIncludes'}: expected "${str}" to include "${substr}"`
    );
  }
}

// ── Bridge process helper ──────────────────────────────────────────────
class BridgeClient {
  constructor(port) {
    this.port = port;
    this.proc = null;
    this.nextId = 1;
    this.pending = {};
    this.events = [];
    this.buffer = '';
  }

  start(bridgePath = path.join(__dirname, '..', '..', 'node', 'bridge.js')) {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [bridgePath], {
        env: {
          ...process.env,
          OVERLEAF_URL: `http://127.0.0.1:${this.port}`,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout.on('data', (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending[msg.id]) {
              this.pending[msg.id](msg);
              delete this.pending[msg.id];
            } else if (msg.event) {
              this.events.push(msg);
            }
          } catch (e) {
            // non-JSON line, ignore
          }
        }
      });

      this.proc.stderr.on('data', (data) => {
        // Bridge logs go to stderr - useful for debugging
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          if (process.env.DEBUG) console.log('  [bridge]', line);
        }
      });

      // Wait for bridge to start
      setTimeout(() => resolve(), 500);

      this.proc.on('error', reject);
    });
  }

  request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        delete this.pending[id];
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending[id] = (msg) => {
        clearTimeout(timer);
        if (msg.error) {
          reject(msg.error);
        } else {
          resolve(msg.result);
        }
      };

      const payload = JSON.stringify({ id, method, params: params || {} }) + '\n';
      this.proc.stdin.write(payload);
    });
  }

  clearEvents() {
    const events = [...this.events];
    this.events = [];
    return events;
  }

  waitForEvent(eventName, timeoutMs = 5000) {
    // Check if already received
    const idx = this.events.findIndex(e => e.event === eventName);
    if (idx >= 0) {
      return Promise.resolve(this.events.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for event: ${eventName}`)), timeoutMs);
      const check = setInterval(() => {
        const idx = this.events.findIndex(e => e.event === eventName);
        if (idx >= 0) {
          clearTimeout(timer);
          clearInterval(check);
          resolve(this.events.splice(idx, 1)[0]);
        }
      }, 50);
    });
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

// ── Test cases ─────────────────────────────────────────────────────────

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    errors.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

async function runTests() {
  console.log('\nStarting mock OT server...');
  const srv = await createServer(0); // random port
  const port = srv.server.address().port;
  console.log(`Mock server on port ${port}\n`);

  // ── Test Suite: Bridge Connection ────────────────────────────────
  console.log('Bridge Connection:');

  let bridge;

  await test('ping succeeds', async () => {
    bridge = new BridgeClient(port);
    await bridge.start();
    const result = await bridge.request('ping');
    assertEqual(result.status, 'ok', 'ping status');
  });

  await test('editor history can be rebased while disconnected from Overleaf', async () => {
    const result = await bridge.request('rebaseEditorHistory', {
      history: { current: 1, preferred: 1, nodes: [
        { seq: 0, parent: null, content: 'intro\nseparator\nending' },
        { seq: 1, parent: 0, content: 'MY intro\nseparator\nending' },
      ] },
      content: 'MY intro\nseparator\nTHEIR ending',
    });
    assertEqual(result.status, 'clean');
    assertEqual(result.history.nodes[0].content, 'intro\nseparator\nTHEIR ending');
    assertEqual(result.history.nodes[1].content, 'MY intro\nseparator\nTHEIR ending');
    assertEqual(result.history.nodes.length, 2, 'incoming changes do not create undo entries');
  });

  await test('editor history RPC returns conflicts without a partial installable tree', async () => {
    const result = await bridge.request('rebaseEditorHistory', {
      history: { current: 1, preferred: 1, nodes: [
        { seq: 0, parent: null, content: 'before' },
        { seq: 1, parent: 0, content: 'after' },
      ] },
      content: 'after expanded by colleague',
    });
    assertEqual(result.status, 'conflict');
    assertEqual(result.seq, 0);
    assertEqual(result.inputs.local, 'before');
    assertEqual(result.history, undefined);
  });

  await test('malformed editor history is rejected without stopping the bridge', async () => {
    let rejected = false;
    try {
      await bridge.request('rebaseEditorHistory', { history: { nodes: [] }, content: 'text' });
    } catch (error) {
      rejected = true;
      assertIncludes(error.message, 'root state');
    }
    assert(rejected, 'invalid history must be rejected');
    assertEqual((await bridge.request('ping')).status, 'ok');
  });

  await test('recovery sessions reject obsolete project tokens and retain incoming revisions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-session-'));
    const options = { root, server: 'https://example.test', projectId: 'project' };
    let session;
    try {
      session = (await bridge.request('syncOpen', options)).session;
      const ownership = await bridge.request('syncInspectLocks', options);
      assertEqual(ownership.locks[0].inspection.state, 'active');
      await bridge.request('syncRecoverLocks', { review: ownership }).then(
        () => { throw new Error('Running writer must not be released'); },
        error => assertEqual(error.code, 'WRITER_ACTIVE'),
      );
      const opened = await bridge.request('syncDocument', { session, document: 'doc', action: 'open', initial: { content: 'before', version: 1 } });
      assertEqual(opened.session, session);
      assertEqual(opened.document, 'doc');
      await bridge.request('syncDocument', { session, document: 'doc', action: 'remote', remote: { content: 'after', version: 2 } });
      const oldSession = session;
      await bridge.request('syncClose', { session });
      session = (await bridge.request('syncOpen', options)).session;
      const recovered = await bridge.request('syncDocument', { session, document: 'doc', action: 'open' });
      assertEqual(recovered.state.buffer, 'after');
      let rejected = false;
      try {
        await bridge.request('syncDocument', { session: oldSession, document: 'doc', action: 'remote', remote: { content: 'obsolete', version: 3 } });
      } catch (error) {
        rejected = true;
        assertEqual(error.code, 'STALE_SESSION');
      }
      assert(rejected, 'old sessions cannot mutate a reopened document');
    } finally {
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('clean bridge EOF drains accepted sync requests before releasing the writer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-eof-'));
    const client = new BridgeClient(port);
    const options = { root, server: 'https://example.test', projectId: 'project' };
    await client.start();
    try {
      const { session } = await client.request('syncOpen', options);
      await client.request('syncDocument', { session, document: 'doc', action: 'open', initial: { content: 'before', version: 1 } });
      const exit = new Promise(resolve => client.proc.once('exit', resolve));
      const pending = client.request('syncDocument', { session, document: 'doc', action: 'remote', remote: { content: 'after', version: 2 } });
      client.proc.stdin.end();
      assertEqual((await pending).state.buffer, 'after');
      assertEqual(await exit, 0);
      const { SyncSession } = require('../../node/sync/session');
      const reopened = await SyncSession.open(options);
      try {
        assertEqual((await reopened.document({ document: 'doc', action: 'open' })).state.buffer, 'after');
      } finally { await reopened.close(); }
    } finally {
      client.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('shutdown can abandon a stalled network request while preserving accepted recovery writes', async () => {
    let seen;
    const requested = new Promise(resolve => { seen = resolve; });
    const sockets = new Set();
    const stalled = require('http').createServer(() => seen());
    stalled.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
    const client = new BridgeClient(stalled.address().port);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-stalled-'));
    const options = { root, server: 'https://example.test', projectId: 'project' };
    await client.start();
    try {
      const { session } = await client.request('syncOpen', options);
      await client.request('syncDocument', { session, document: 'doc', action: 'open', initial: { content: 'before', version: 1 } });
      client.proc.stdin.write(JSON.stringify({ id: 99999, method: 'auth', params: { cookie: 'test' } }) + '\n');
      await requested;
      let timer;
      const exit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Network request prevented bridge shutdown')), 8000);
        client.proc.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      const pending = client.request('syncDocument', { session, document: 'doc', action: 'remote', remote: { content: 'after', version: 2 } });
      client.proc.stdin.end();
      assertEqual((await pending).state.buffer, 'after');
      assertEqual(await exit, 0);
      const { SyncSession } = require('../../node/sync/session');
      const reopened = await SyncSession.open(options);
      try {
        assertEqual((await reopened.document({ document: 'doc', action: 'open' })).state.buffer, 'after');
      } finally { await reopened.close(); }
    } finally {
      client.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => stalled.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('EOF closes recovery stores when a network request has no remaining event-loop handle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-no-handle-'));
    const bootstrap = path.join(root, 'bridge.cjs');
    const authPath = path.resolve(__dirname, '../../node/auth.js');
    const bridgePath = path.resolve(__dirname, '../../node/bridge.js');
    fs.writeFileSync(bootstrap, `require(${JSON.stringify(authPath)}).fetchProjectPage = () => new Promise(() => {});\nrequire(${JSON.stringify(bridgePath)});\n`);
    const sourceRoot = path.join(root, 'sources');
    fs.mkdirSync(sourceRoot);
    const options = { root: path.join(root, 'state'), sourceRoot, server: 'https://example.test', projectId: 'project' };
    const client = new BridgeClient(port);
    await client.start(bootstrap);
    try {
      const { session } = await client.request('syncOpen', options);
      await client.request('syncDocument', { session, document: 'doc', action: 'open', path: 'main.tex',
        initial: { content: 'saved source', version: 1 } });
      client.proc.stdin.write(JSON.stringify({ id: 99999, method: 'auth', params: { cookie: 'test' } }) + '\n');
      await client.request('ping');
      let timer;
      const exit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Bridge did not finish shutdown')), 8000);
        client.proc.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      client.proc.stdin.end();
      assertEqual(await exit, 0);
      const { SyncSession } = require('../../node/sync/session');
      const reopened = await SyncSession.open(options);
      try {
        const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
        assertEqual(restored.state.saved, 'saved source');
        assertEqual(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), 'saved source');
      } finally { await reopened.close(); }
    } finally {
      client.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('shutdown abandons an upload-review join while releasing its local stores', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-review-exit-')));
    const sourceRoot = path.join(root, 'sources'); fs.mkdirSync(sourceRoot);
    const bootstrap = path.join(root, 'bridge.cjs'), marker = path.join(root, 'joining');
    const socketPath = path.resolve(__dirname, '../../node/socket.js');
    const bridgePath = path.resolve(__dirname, '../../node/bridge.js');
    fs.writeFileSync(bootstrap, `
const SocketManager = require(${JSON.stringify(socketPath)});
const join = SocketManager.prototype.joinDoc;
let joined = false;
SocketManager.prototype.joinDoc = function (...args) {
  if (joined) {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'joining');
    return new Promise(() => {});
  }
  joined = true;
  return join.apply(this, args);
};
require(${JSON.stringify(bridgePath)});
`);
    const client = new BridgeClient(port), document = 'review-exit';
    const options = { root: path.join(root, 'state'), sourceRoot, server: `http://127.0.0.1:${port}`, projectId: 'test_project' };
    getOrCreateDoc(document, ['saved source']);
    await client.start(bootstrap);
    try {
      await client.request('connect', { cookie: 'test', projectId: 'test_project' });
      const { session } = await client.request('syncOpen', options);
      await client.request('syncDocument', { session, document, action: 'open', path: 'main.tex', initial: { content: 'saved source', version: 0 } });
      await client.request('syncConnect', { session, document });
      client.proc.stdin.write(JSON.stringify({ id: 99999, method: 'syncUploadReview', params: { session, document } }) + '\n');
      for (let count = 0; count < 200 && !fs.existsSync(marker); count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(fs.existsSync(marker), 'The join must be waiting before EOF');
      let timer;
      const exit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Upload-review network join prevented shutdown')), 8000);
        client.proc.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      client.proc.stdin.end();
      assertEqual(await exit, 0);
      const { SyncSession } = require('../../node/sync/session');
      const reopened = await SyncSession.open(options);
      try {
        assertEqual((await reopened.document({ document, action: 'open', path: 'main.tex' })).state.saved, 'saved source');
      } finally { await reopened.close(); }
    } finally { client.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('connect to mock server', async () => {
    // The connect handler needs a cookie, but our mock doesn't validate
    // We need to bypass the auth.updateCookies call — use a special flag
    // Actually, auth.updateCookies will fail because it tries to fetch from overleaf.com
    // Let's test at the socket level by connecting directly
    const result = await bridge.request('connect', {
      cookie: 'mock_session=test',
      projectId: 'test_project',
    });
    assert(result.project, 'should receive project data');
    assertEqual(result.project.name, 'Test Project', 'project name');
    assertEqual(result.permissionsLevel, 'owner', 'permissions');
  });

  await test('overlapping project connections cancel the obsolete request without leaving an old socket active', async () => {
    const first = bridge.request('connect', { cookie: 'mock_session=test', projectId: 'obsolete_project' });
    const second = bridge.request('connect', { cookie: 'mock_session=test', projectId: 'test_project' });
    const results = await Promise.allSettled([first, second]);
    assertEqual(results[0].status, 'rejected');
    assertEqual(results[0].reason.code, 'CONNECTION_REPLACED');
    assertEqual(results[1].status, 'fulfilled');
    const joined = await bridge.request('joinDoc', { docId: 'connection_check' });
    assert(Array.isArray(joined.lines), 'new connection remains usable');
  });

  await test('compile rewrites cached output URLs', async () => {
    const result = await bridge.request('compile', {
      cookie: 'mock_session=test',
      csrfToken: 'csrf',
      projectId: 'test_project',
    });

    assertEqual(result.status, 'success', 'compile status');
    assertIncludes(result.log, 'mock compile log', 'compile log');

    const pdf = result.outputFiles.find(f => f.path === 'output.pdf');
    assert(pdf, 'should include output.pdf');
    assertIncludes(pdf.url, `http://127.0.0.1:${port}/zone/zonea/project/test_project/user/user1/build/build1/output/output.pdf`, 'rewritten PDF URL');
    assertIncludes(pdf.url, 'compileGroup=standard', 'compile group query');
    assertIncludes(pdf.url, 'clsiserverid=one-two-three-four-zonea', 'clsi server query');
    assertIncludes(pdf.url, 'enable_pdf_caching=true', 'pdf caching query');
  });

  await test('merge review RPC creates private conflict stages under the current recovery directory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-merge-')));
    let session;
    try {
      const opened = await bridge.request('syncOpen', { root, server: `http://127.0.0.1:${port}`, projectId: 'merge-review' });
      session = opened.session;
      const review = await bridge.request('syncMergeView', { session,
        inputs: { base: 'base', local: 'local', remote: 'remote' }, candidate: 'retained candidate' });
      assert(review.directory.startsWith(opened.directory + path.sep + 'merge-views' + path.sep));
      assert(fs.existsSync(path.join(review.directory, '.git', 'index')));
      assertEqual(fs.readFileSync(review.path, 'utf8'), 'retained candidate');
      assertEqual(fs.readFileSync(review.candidate, 'utf8'), 'retained candidate');
    } finally {
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('comment messages and anchors use durable owned state without publishing the selected native view', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-comments-')));
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const base = 'é😀 abc', document = 'comment-doc';
    const doc = getOrCreateDoc(document, [base]);
    let session;
    try {
      session = (await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' })).session;
      await bridge.request('syncDocument', { session, document, action: 'open', path: 'main.tex', initial: { content: base, version: doc.version } });
      await bridge.request('syncConnect', { session, document });
      const result = await bridge.request('syncComment', { session, document, cookie: 'mock', csrfToken: 'mock',
        selection: { thread: 'thread-native', message: 'Please revise', view: 'UNSAVED ' + base,
          start: { row: 0, col: 15 }, end: { row: 0, col: 18 } } });
      assertEqual(result.status, 'queued');
      let state;
      for (let count = 0; count < 100; count++) {
        state = (await bridge.request('syncDocument', { session, document, action: 'snapshot' })).result;
        if (state.comments.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assertEqual(state.comments.length, 0);
      assertEqual(state.remote.comments[0].op.p, 4);
      assertEqual(doc.content, base);
      assertEqual(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), base);
      let failure;
      try { await bridge.request('syncComment', { session, document, cookie: 'mock', csrfToken: 'mock',
        selection: { thread: 'thread-lost', message: 'LOSE COMMENT RESPONSE', view: base,
          start: { row: 0, col: 7 }, end: { row: 0, col: 10 } } }); } catch (error) { failure = error; }
      assertEqual(failure.code, 'COMMENT_UNCERTAIN');
      state = (await bridge.request('syncDocument', { session, document, action: 'snapshot' })).result;
      assertEqual(state.comments.length, 1);
      assertEqual(state.comments[0].posted, false);
      const inspected = await bridge.request('syncComment', { session, document, action: 'inspect',
        token: state.comments[0].token, cookie: 'mock', csrfToken: 'mock' });
      assertEqual(inspected.status, 'queued');
    } finally {
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const phase of ['network', 'local checkpoint']) {
  await test(`shutdown preserves a comment draft while draining its ${phase} phase`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-comment-exit-')));
    const sourceRoot = path.join(root, 'sources'); fs.mkdirSync(sourceRoot);
    const client = new BridgeClient(port), document = 'comment-exit-' + phase;
    const thread = 'thread-' + phase, base = 'saved source';
    getOrCreateDoc(document, [base]);
    const options = { root: path.join(root, 'state'), sourceRoot, server: `http://127.0.0.1:${port}`, projectId: 'test_project' };
    const bootstrap = path.join(root, 'bridge.cjs'), marker = path.join(root, 'accepted');
    const bridgePath = path.resolve(__dirname, '../../node/bridge.js');
    const storePath = path.resolve(__dirname, '../../node/sync/store.js');
    fs.writeFileSync(bootstrap, `
const { SnapshotStore } = require(${JSON.stringify(storePath)});
const write = SnapshotStore.prototype.write;
SnapshotStore.prototype.write = async function (...args) {
  if (${JSON.stringify(phase)} === 'local checkpoint' && args[1].comments?.some(draft => draft.thread === ${JSON.stringify(thread)})) {
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'accepted');
    await new Promise(resolve => setTimeout(resolve, 6000));
  }
  return write.apply(this, args);
};
require(${JSON.stringify(bridgePath)});
`);
    await client.start(bootstrap);
    try {
      await client.request('connect', { cookie: 'test', projectId: 'test_project' });
      const { session } = await client.request('syncOpen', options);
      await client.request('syncDocument', { session, document, action: 'open', path: 'main.tex', initial: { content: base, version: 0 } });
      await client.request('syncConnect', { session, document });
      client.proc.stdin.write(JSON.stringify({ id: 99999, method: 'syncComment', params: {
        session, document, cookie: 'test', csrfToken: 'test', selection: {
          thread, message: 'STALL COMMENT RESPONSE', view: base, start: { row: 0, col: 0 }, end: { row: 0, col: 5 },
        },
      } }) + '\n');
      for (let count = 0; count < 200; count++) {
        if (phase === 'network' ? srv.commentPosts.some(post => post.thread === thread) : fs.existsSync(marker)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(phase === 'network' ? srv.commentPosts.some(post => post.thread === thread) : fs.existsSync(marker), 'The tested phase must be accepted before EOF');
      let timer;
      const exit = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Network phase prevented shutdown')), 9000);
        client.proc.once('exit', code => { clearTimeout(timer); resolve(code); });
      });
      client.proc.stdin.end();
      assertEqual(await exit, 0);
      const { SyncSession } = require('../../node/sync/session');
      const reopened = await SyncSession.open(options);
      try {
        const record = (await reopened.document({ document, action: 'open', path: 'main.tex' })).state;
        const snapshot = (await reopened.document({ document, action: 'snapshot' })).result;
        assertEqual(record.saved, base);
        assertEqual(snapshot.comments.length, 1);
        assertEqual(snapshot.comments[0].thread, thread);
        assertEqual(snapshot.comments[0].posted, false);
        assertEqual(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), base);
        if (phase === 'local checkpoint') assert(!srv.commentPosts.some(post => post.thread === thread), 'No network write may start after shutdown has abandoned network work');
      } finally { await reopened.close(); }
    } finally { client.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  }

  for (const format of [{ fileformat: 'unix', bomb: false }, { fileformat: 'dos', bomb: true }]) {
  await test(`guarded ${format.fileformat} workspace saves reach the server through confirmed transport and reject legacy writes`, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-transport-')));
    const sourceRoot = path.join(root, 'source');
    fs.mkdirSync(sourceRoot);
    const base = 'intro\nseparator\nending';
    const saved = 'SAVED é日本\nseparator\nending';
    const physical = (format.bomb ? '\ufeff' : '') + saved.replaceAll('\n', format.fileformat === 'dos' ? '\r\n' : '\n');
    const documentId = 'durable-wire-doc-' + format.fileformat;
    fs.writeFileSync(path.join(sourceRoot, 'main.tex'), base);
    const doc = getOrCreateDoc(documentId, base.split('\n'));
    let session;
    try {
      session = (await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' })).session;
      const opened = await bridge.request('syncDocument', { session, document: documentId,
        action: 'open', path: 'main.tex', initial: { content: base, version: doc.version } });
      const document = opened.document;
      const cp = (text, format = {}) => ({ history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content: text, empty: false }] },
        tree: { seq_cur: 0, seq_last: 0 }, undo: null,
        options: { fileformat: 'unix', fileencoding: '', binary: false, bomb: false, endofline: false, fixendofline: false, undolevels: 1000, ...format } });
      await bridge.request('syncDocument', { session, document, action: 'checkpoint', revision: opened.revision, checkpoint: cp(base) });
      await bridge.request('syncConnect', { session, document });
      let rejected = false;
      try { await bridge.request('applyOtUpdate', { docId: document, op: [{ p: 0, i: 'legacy' }], v: doc.version, content: base }); }
      catch (error) { rejected = true; assertEqual(error.code, 'DOCUMENT_OWNED'); }
      assert(rejected, 'legacy writes cannot share an acknowledgement stream');
      const before = await bridge.request('syncDocument', { session, document, action: 'state' });
      await bridge.request('syncDocument', { session, document, action: 'write', revision: before.revision, expected: base, checkpoint: cp(saved, format), undo: null });
      let state;
      for (let count = 0; count < 100; count++) {
        state = await bridge.request('syncDocument', { session, document, action: 'snapshot' });
        if (!state.result.pending && state.result.remote.wire === saved) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assertEqual(state.result.remote.content, physical);
      assertEqual(state.result.remote.wire, saved);
      assertEqual(state.result.pending, null);
      assertEqual(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), physical);
      assertEqual(doc.lines.join('\n'), saved);
    } finally {
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  }

  await test('unknown upload review inspects a drained server queue and never replays the old submission', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-uncertain-')));
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const document = 'uncertain-review-doc', base = 'base', saved = 'saved base';
    const doc = getOrCreateDoc(document, [base]);
    doc.holdApplied = true; doc.typedJoin = true;
    const checkpoint = content => ({ history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content, empty: false }] },
      tree: { seq_cur: 0, seq_last: 0 }, undo: null,
      options: { fileformat: 'unix', fileencoding: '', binary: false, bomb: false, endofline: false, fixendofline: false, undolevels: 1000 } });
    let session;
    try {
      session = (await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' })).session;
      const initial = await bridge.request('syncDocument', { session, document, action: 'open', path: 'main.tex', initial: { content: base, version: doc.version } });
      await bridge.request('syncDocument', { session, document, action: 'checkpoint', revision: initial.revision, checkpoint: checkpoint(base) });
      await bridge.request('syncConnect', { session, document });
      let state = await bridge.request('syncDocument', { session, document, action: 'state' });
      await bridge.request('syncDocument', { session, document, action: 'write', revision: state.revision, expected: base, checkpoint: checkpoint(saved) });
      let pending;
      for (let count = 0; count < 100; count++) {
        pending = (await bridge.request('syncDocument', { session, document, action: 'snapshot' })).result.pending;
        if (pending?.queued) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(pending?.queued, 'original queue receipt is durable');
      const review = await bridge.request('syncUploadReview', { session, document });
      assertEqual(review.canRetire, true);
      assertEqual(review.pending.token, pending.token);
      const accepted = await bridge.request('syncUploadReview', { session, document, accept: true, review });
      assertEqual(accepted.status, 'review-required');
      const result = (await bridge.request('syncDocument', { session, document, action: 'snapshot' })).result;
      assertEqual(result.pending, null);
      assertEqual(result.conflict.reason, 'reviewed-uncertainty');
      assertEqual(result.recovery.uploadDecision.pending.token, pending.token);
      assertEqual(doc.content, saved);
      assertEqual(doc.version, 1, 'no repeat operation was published');
    } finally {
      doc.holdApplied = false;
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('an unprovable upload can be kept local without claiming its remote outcome or losing its intent', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-rpc-local-')));
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const document = 'uncertain-local-doc', base = 'base', saved = 'saved base';
    const doc = getOrCreateDoc(document, [base]); doc.holdApplied = true;
    const checkpoint = content => ({ history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content, empty: false }] },
      tree: { seq_cur: 0, seq_last: 0 }, undo: null,
      options: { fileformat: 'unix', fileencoding: '', binary: false, bomb: false, endofline: false, fixendofline: false, undolevels: 1000 } });
    let session;
    try {
      session = (await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' })).session;
      const initial = await bridge.request('syncDocument', { session, document, action: 'open', path: 'main.tex', initial: { content: base, version: 0 } });
      await bridge.request('syncDocument', { session, document, action: 'checkpoint', revision: initial.revision, checkpoint: checkpoint(base) });
      await bridge.request('syncConnect', { session, document });
      const state = await bridge.request('syncDocument', { session, document, action: 'state' });
      await bridge.request('syncDocument', { session, document, action: 'write', revision: state.revision, expected: base, checkpoint: checkpoint(saved) });
      for (let count = 0; count < 100 && !doc.releaseApplied; count++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(doc.releaseApplied, 'submission reached server');
      const review = await bridge.request('syncUploadReview', { session, document });
      assertEqual(review.canRetire, false);
      const retained = await bridge.request('syncDocument', { session, document, action: 'keepUncertainLocal', review,
        checkpoint: checkpoint('UNSAVED ' + saved) });
      assertEqual(retained.state.publication, 'local-only');
      const result = (await bridge.request('syncDocument', { session, document, action: 'snapshot' })).result;
      assertEqual(result.buffer, 'UNSAVED ' + saved);
      assertEqual(result.recovery.localOnly.pending.token, review.pending.token);
      assertEqual(fs.readFileSync(path.join(sourceRoot, 'main.tex'), 'utf8'), saved);
      assertEqual(doc.version, 1);
    } finally {
      doc.holdApplied = false;
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('remote compile RPC waits for an applied saved revision before invoking the compiler', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-compile-gate-')));
    const sourceRoot = path.join(root, 'sources');
    fs.mkdirSync(sourceRoot);
    const document = 'compile-gated-doc', base = 'base source', saved = 'saved source';
    const doc = getOrCreateDoc(document, [base]);
    doc.holdApplied = true;
    let session;
    try {
      ({ session } = await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' }));
      let state = await bridge.request('syncDocument', { session, document, action: 'open', path: 'main.tex',
        initial: { content: base, version: doc.version } });
      await bridge.request('syncProject', { session, project: { name: 'Paper', tree: [{ id: document, path: 'main.tex', type: 'doc' }] } });
      const checkpoint = text => ({ history: { current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content: text, empty: false }] },
        tree: { seq_cur: 0, seq_last: 0 }, undo: null,
        options: { fileformat: 'unix', fileencoding: '', binary: false, bomb: false, endofline: false, fixendofline: false, undolevels: 1000 } });
      await bridge.request('syncDocument', { session, document, action: 'checkpoint', revision: state.revision, checkpoint: checkpoint(base) });
      await bridge.request('syncConnect', { session, document });
      state = await bridge.request('syncDocument', { session, document, action: 'state' });
      await bridge.request('syncDocument', { session, document, action: 'write', revision: state.revision, expected: base, checkpoint: checkpoint(saved) });
      let completed = false;
      const count = srv.compilations.length;
      const compile = bridge.request('syncCompile', { session, cookie: 'mock_session=test', csrfToken: 'test', projectId: 'test_project' })
        .then(value => ({ value }), error => ({ error })).then(result => { completed = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 150));
      const premature = completed;
      const invokedBeforeAck = srv.compilations.length;
      assert(doc.releaseApplied, 'server has received the saved update');
      doc.releaseApplied();
      const result = await compile;
      assertEqual(premature, false, 'compile waits for confirmed application');
      assertEqual(invokedBeforeAck, count, 'compiler not invoked before proof');
      assert(!result.error, JSON.stringify(result.error));
      assertEqual(result.value.status, 'success', 'compile completed');
      assertEqual(srv.compilations.length, count + 1, 'compiler invoked exactly once');
    } finally {
      doc.holdApplied = false;
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('compile does not duplicate zone when download domain includes zone', async () => {
    const result = await bridge.request('compile', {
      cookie: 'mock_session=test',
      csrfToken: 'csrf',
      projectId: 'test_project_domain_zone',
    });

    const pdf = result.outputFiles.find(f => f.path === 'output.pdf');
    assert(pdf, 'should include output.pdf');
    assertIncludes(pdf.url, `http://127.0.0.1:${port}/zone/zonea/project/test_project_domain_zone/user/user1/build/build1/output/output.pdf`, 'rewritten PDF URL');
    assert(!pdf.url.includes('/zone/zonea/zone/zonea/'), 'should not duplicate zone');
  });

  await test('compile does not duplicate zone when output path includes zone', async () => {
    const result = await bridge.request('compile', {
      cookie: 'mock_session=test',
      csrfToken: 'csrf',
      projectId: 'test_project_path_zone',
    });

    const pdf = result.outputFiles.find(f => f.path === 'output.pdf');
    assert(pdf, 'should include output.pdf');
    assertIncludes(pdf.url, `http://127.0.0.1:${port}/zone/zonea/project/test_project_path_zone/user/user1/build/build1/output/output.pdf`, 'rewritten PDF URL');
    assert(!pdf.url.includes('/zone/zonea/zone/zonea/'), 'should not duplicate zone');
  });

  await test('downloadUrl follows redirects and returns a non-empty file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-test-'));
    fs.writeFileSync(path.join(dir, 'overleaf_output.pdf'), 'previous complete PDF');
    const result = await bridge.request('downloadUrl', {
      cookie: 'mock_session=test',
      url: `http://127.0.0.1:${port}/download/redirect-pdf`,
      fileName: 'output.pdf',
      outputDir: dir,
    });

    assert(result.path, 'should return downloaded path');
    assert(result.bytes > 0, 'should return byte count');
    assertEqual(fs.statSync(result.path).size, result.bytes, 'downloaded file size');
    assertIncludes(fs.readFileSync(result.path, 'utf8'), '%PDF-1.4', 'downloaded PDF content');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('downloadUrl rejects empty files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-test-'));
    try {
      await bridge.request('downloadUrl', {
        cookie: 'mock_session=test',
        url: `http://127.0.0.1:${port}/download/empty`,
        fileName: 'empty.pdf',
        outputDir: dir,
      });
      throw new Error('downloadUrl should have rejected empty file');
    } catch (e) {
      assertEqual(e.code, 'EMPTY_DOWNLOAD', 'empty download error code');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Test Suite: Document Operations ──────────────────────────────
  await test('compile log downloads do not forward authentication to another origin', async () => {
    const http = require('node:http');
    let receivedCookie;
    const external = http.createServer((req, res) => { receivedCookie = req.headers.cookie; res.end('external compile log'); });
    await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
    const primary = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'success', outputFiles: [
        { path: 'output.log', url: `http://127.0.0.1:${external.address().port}/output.log` },
      ] }));
    });
    await new Promise(resolve => primary.listen(0, '127.0.0.1', resolve));
    const client = new BridgeClient(primary.address().port);
    try {
      await client.start();
      const result = await client.request('compile', { cookie: 'private-fixture-cookie', csrfToken: 'fixture', projectId: 'fixture' });
      assertEqual(result.log, 'external compile log', 'cross-origin output remains readable');
      assertEqual(receivedCookie, undefined, 'compile log receives no cookie');
    } finally {
      await client.stop();
      await Promise.all([primary, external].map(server => new Promise(resolve => server.close(resolve))));
    }
  });

  await test('download filenames cannot escape their output directory through either RPC', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-download-path-'));
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(path.join(outputDir, 'overleaf_nested'));
    const protectedFile = path.join(root, 'protected.pdf');
    fs.writeFileSync(protectedFile, 'keep this file');
    try {
      for (const method of ['downloadUrl', 'downloadFile']) {
        for (const fileName of ['nested/../../protected.pdf', '../protected.pdf', '..\\protected.pdf', '/absolute.pdf', '.', '..', 'bad\0name', '']) {
          let failure;
          try {
            await bridge.request(method, { cookie: 'mock_session=test', outputDir, fileName,
              url: `http://127.0.0.1:${port}/download/pdf`, projectId: 'test_project', fileId: 'asset_binary' });
          } catch (error) { failure = error; }
          assertEqual(failure?.code, 'INVALID_FILENAME', `${method}: reject ${JSON.stringify(fileName)}`);
          assertEqual(fs.readFileSync(protectedFile, 'utf8'), 'keep this file', 'outside source retained');
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('downloadFile installs complete binary bytes and keeps its filename fallback bounded', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-file-download-'));
    try {
      const result = await bridge.request('downloadFile', { cookie: 'mock_session=test', outputDir,
        projectId: 'test_project', fileId: 'asset_binary' });
      assertEqual(path.basename(result.path), 'overleaf_asset_binary', 'safe fallback name');
      assertEqual(fs.readFileSync(result.path).toString('hex'), '00ff800a0d', 'exact binary response');
      let failure;
      try { await bridge.request('downloadFile', { cookie: 'mock_session=test', outputDir,
        projectId: 'test_project', fileId: '../outside' }); } catch (error) { failure = error; }
      assertEqual(failure?.code, 'INVALID_FILENAME', 'fallback IDs cannot introduce a path');
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
  });

  await test('invalid redirects and oversized streams preserve the previous download', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-download-bounds-'));
    const destination = path.join(outputDir, 'overleaf_output.pdf');
    const server = require('node:http').createServer((req, res) => {
      if (req.url === '/large-header') { res.writeHead(200, { 'Content-Length': 65 * 1024 * 1024 }); res.end(); }
      else if (req.url === '/large-stream') {
        const chunk = Buffer.alloc(1024 * 1024);
        let count = 0;
        const write = () => {
          while (!res.destroyed && count++ < 65) if (!res.write(chunk)) { res.once('drain', write); return; }
          res.end();
        };
        write();
      } else {
        res.writeHead(302, { Location: req.url === '/loop' ? '/loop' : 'file:///unavailable' });
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const [endpoint, code] of [['/large-header', 'FILE_LIMIT'], ['/large-stream', 'FILE_LIMIT'],
        ['/loop', 'TOO_MANY_REDIRECTS'], ['/invalid', 'DOWNLOAD_FAILED']]) {
        fs.writeFileSync(destination, 'previous complete PDF');
        let failure;
        try { await bridge.request('downloadUrl', { cookie: 'fixture-cookie', outputDir, fileName: 'output.pdf',
          url: `http://127.0.0.1:${server.address().port}${endpoint}` }); } catch (error) { failure = error; }
        assertEqual(failure?.code, code, 'bounded download failure');
        assertEqual(fs.readFileSync(destination, 'utf8'), 'previous complete PDF', 'old download retained');
        assertEqual(fs.readdirSync(outputDir).join(','), 'overleaf_output.pdf', 'no partial stage remains');
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('failed downloads preserve an existing destination and remove private partial files', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-download-failure-'));
    const destination = path.join(outputDir, 'overleaf_output.pdf');
    try {
      for (const endpoint of ['/missing-download', '/download/empty', '/project/test_project/file/asset_truncated']) {
        fs.writeFileSync(destination, 'previous complete PDF');
        let failure;
        try { await bridge.request('downloadUrl', { cookie: 'mock_session=test', outputDir,
          fileName: 'output.pdf', url: `http://127.0.0.1:${port}${endpoint}` }); }
        catch (error) { failure = error; }
        assert(failure, 'incomplete response must fail');
        assertEqual(fs.readFileSync(destination, 'utf8'), 'previous complete PDF', 'failed download retained previous file');
        assertEqual(fs.readdirSync(outputDir).join(','), 'overleaf_output.pdf', 'no partial download remains');
      }
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
  });

  await test('downloads reject symlink and hard-link destinations without altering either file', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-download-links-'));
    const source = path.join(outputDir, 'keep.pdf'), destination = path.join(outputDir, 'overleaf_output.pdf');
    fs.writeFileSync(source, 'protected contents');
    try {
      for (const link of [() => fs.symlinkSync(source, destination), () => fs.linkSync(source, destination)]) {
        link();
        let failure;
        try { await bridge.request('downloadUrl', { cookie: 'mock_session=test', outputDir,
          fileName: 'output.pdf', url: `http://127.0.0.1:${port}/download/pdf` }); }
        catch (error) { failure = error; }
        assertEqual(failure?.code, 'UNSAFE_DOWNLOAD', 'linked destination rejected');
        assertEqual(fs.readFileSync(source, 'utf8'), 'protected contents', 'link target retained');
        assertEqual(fs.readFileSync(destination, 'utf8'), 'protected contents', 'destination retained');
        fs.unlinkSync(destination);
      }
    } finally { fs.rmSync(outputDir, { recursive: true, force: true }); }
  });

  await test('a destination changed during download is retained and cross-origin cookies are absent', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-download-race-'));
    const destination = path.join(outputDir, 'overleaf_output.pdf');
    fs.writeFileSync(destination, 'previous PDF');
    let receivedCookie;
    const server = require('node:http').createServer((req, res) => {
      receivedCookie = req.headers.cookie;
      fs.writeFileSync(destination, 'new external edit');
      res.end('complete downloaded PDF');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      let failure;
      try { await bridge.request('downloadUrl', { cookie: 'mock_session=test', outputDir,
        fileName: 'output.pdf', url: `http://127.0.0.1:${server.address().port}/pdf` }); }
      catch (error) { failure = error; }
      assertEqual(failure?.code, 'DOWNLOAD_CHANGED', 'intervening destination edit rejected');
      assertEqual(fs.readFileSync(destination, 'utf8'), 'new external edit', 'external edit retained');
      assertEqual(receivedCookie, undefined, 'cookie restricted to configured origin');
      assertEqual(fs.readdirSync(outputDir).join(','), 'overleaf_output.pdf', 'private stage removed');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  await test('workspace asset fetch preserves exact bytes, empty files, and independent local versions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-assets-rpc-'));
    const sourceRoot = path.join(root, 'sources');
    fs.mkdirSync(sourceRoot);
    let session;
    try {
      ({ session } = await bridge.request('syncOpen', { root: path.join(root, 'state'), sourceRoot,
        server: `http://127.0.0.1:${port}`, projectId: 'test_project' }));
      for (const document of ['asset_binary', 'asset_redirect', 'asset_empty']) {
        const reply = await bridge.request('syncFetchAsset', { session, document, path: `${document}.bin`, cookie: 'mock_session=test' });
        assertEqual(reply.state.status, 'synced');
        assertEqual(fs.readFileSync(path.join(sourceRoot, `${document}.bin`)).toString('hex'),
          document === 'asset_empty' ? '' : '00ff800a0d');
      }
      fs.writeFileSync(path.join(sourceRoot, 'asset_binary.bin'), 'local edit');
      const saved = await bridge.request('syncFetchAsset', { session, document: 'asset_binary', path: 'asset_binary.bin', cookie: 'mock_session=test' });
      assertEqual(saved.state.status, 'local-changes');
      assertEqual(fs.readFileSync(path.join(sourceRoot, 'asset_binary.bin'), 'utf8'), 'local edit');
      for (const document of ['asset_large', 'asset_truncated']) {
        let rejected;
        try { await bridge.request('syncFetchAsset', { session, document, path: `${document}.bin`, cookie: 'mock_session=test' }); }
        catch (error) { rejected = error; }
        assertEqual(rejected?.code, document === 'asset_large' ? 'FILE_LIMIT' : 'DOWNLOAD_FAILED');
        assert(!fs.existsSync(path.join(sourceRoot, `${document}.bin`)), 'incomplete asset must not be installed');
      }
    } finally {
      if (session) await bridge.request('syncClose', { session });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log('\nDocument Operations:');

  // Pre-create doc in mock server
  getOrCreateDoc('doc_main', [
    '\\documentclass{article}',
    '\\begin{document}',
    'Hello World',
    '\\end{document}',
  ]);

  await test('joinDoc returns document content', async () => {
    const result = await bridge.request('joinDoc', { docId: 'doc_main' });
    assert(result.lines, 'should have lines');
    assertEqual(result.lines.length, 4, 'line count');
    assertEqual(result.lines[2], 'Hello World', 'content line');
    assertEqual(result.version, 0, 'initial version');
  });

  await test('applyOtUpdate with insert succeeds', async () => {
    const content = '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}';
    // "Hello" starts at position 41, space at 46, "World" at 47
    // Insert " Beautiful" at position 46 (between "Hello" and " World")
    const op = [{ p: 46, i: ' Beautiful' }];
    const result = await bridge.request('applyOtUpdate', {
      docId: 'doc_main',
      op,
      v: 0,
      content,
    });
    // Should not throw
    assert(result !== undefined, 'should return result');
  });

  await test('document content updated after insert', async () => {
    // Re-join to get fresh content
    const result = await bridge.request('joinDoc', { docId: 'doc_main' });
    assertEqual(result.version, 1, 'version incremented');
    assertEqual(result.lines[2], 'Hello Beautiful World', 'updated content');
  });

  await test('applyOtUpdate with delete succeeds', async () => {
    const content = '\\documentclass{article}\n\\begin{document}\nHello Beautiful World\n\\end{document}';
    // Delete " Beautiful" at position 46
    const op = [{ p: 46, d: ' Beautiful' }];
    await bridge.request('applyOtUpdate', {
      docId: 'doc_main',
      op,
      v: 1,
      content,
    });
    const result = await bridge.request('joinDoc', { docId: 'doc_main' });
    assertEqual(result.lines[2], 'Hello World', 'content after delete');
    assertEqual(result.version, 2, 'version after delete');
  });

  // ── Test Suite: Error Handling ───────────────────────────────────
  console.log('\nError Handling:');

  await test('version mismatch triggers otUpdateError', async () => {
    bridge.clearEvents();
    const content = '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}';
    try {
      await bridge.request('applyOtUpdate', {
        docId: 'doc_main',
        op: [{ p: 0, i: 'x' }],
        v: 999, // Wrong version
        content,
      });
    } catch (e) {
      // Expected - the bridge may throw or the server sends otUpdateError
    }

    // Check for otUpdateError event
    try {
      const evt = await bridge.waitForEvent('otUpdateError', 2000);
      assert(evt, 'should receive otUpdateError event');
      assertIncludes(evt.data.message, 'version mismatch', 'error message');
    } catch (e) {
      // Also acceptable if the bridge threw the error directly
    }
  });

  await test('hash mismatch triggers otUpdateError', async () => {
    bridge.clearEvents();
    // Send update with correct version but content that produces wrong hash
    const wrongContent = 'THIS IS WRONG CONTENT';
    try {
      await bridge.request('applyOtUpdate', {
        docId: 'doc_main',
        op: [{ p: 0, i: 'x' }],
        v: 2,
        content: wrongContent, // Hash will be computed from this wrong content
      });
    } catch (e) {
      // Expected
    }

    try {
      const evt = await bridge.waitForEvent('otUpdateError', 2000);
      assert(evt, 'should receive otUpdateError event');
      assertIncludes(evt.data.message, 'hash mismatch', 'error message');
    } catch (e) {
      // Also acceptable
    }
  });

  await test('joinDoc on non-existent doc creates it', async () => {
    const result = await bridge.request('joinDoc', { docId: 'doc_new' });
    assert(result.lines, 'should have lines');
    assertEqual(result.version, 0, 'new doc version');
  });

  // ── Test Suite: Hash Validation ──────────────────────────────────
  console.log('\nHash Validation:');

  await test('correct hash is accepted', async () => {
    resetDocs();
    getOrCreateDoc('doc_hash', ['abc']);
    await bridge.request('joinDoc', { docId: 'doc_hash' });

    const content = 'abc';
    const op = [{ p: 3, i: 'def' }];
    // bridge.js computes hash automatically from content + ops
    const result = await bridge.request('applyOtUpdate', {
      docId: 'doc_hash',
      op,
      v: 0,
      content,
    });
    assert(result !== undefined, 'should succeed');

    // Verify content
    const doc = await bridge.request('joinDoc', { docId: 'doc_hash' });
    assertEqual(doc.lines[0], 'abcdef', 'content after insert');
  });

  await test('hash computed in bridge matches server expectation', async () => {
    // Test with multibyte characters
    resetDocs();
    getOrCreateDoc('doc_utf8', ['café']);
    await bridge.request('joinDoc', { docId: 'doc_utf8' });

    const content = 'café';
    const op = [{ p: 4, i: '!' }]; // char position after é
    const result = await bridge.request('applyOtUpdate', {
      docId: 'doc_utf8',
      op,
      v: 0,
      content,
    });
    assert(result !== undefined, 'should succeed with UTF-8');

    const doc = await bridge.request('joinDoc', { docId: 'doc_utf8' });
    assertEqual(doc.lines[0], 'café!', 'UTF-8 content after insert');
  });

  // ── Test Suite: Multi-client Broadcasting ────────────────────────
  console.log('\nMulti-client Broadcasting:');

  await test('second client receives remote op broadcast', async () => {
    resetDocs();
    getOrCreateDoc('doc_collab', ['shared doc']);

    // Client 1 (existing bridge) joins
    await bridge.request('joinDoc', { docId: 'doc_collab' });

    // Client 2
    const bridge2 = new BridgeClient(port);
    await bridge2.start();
    await bridge2.request('ping');
    await bridge2.request('connect', {
      cookie: 'mock_session=test2',
      projectId: 'test_project',
    });
    await bridge2.request('joinDoc', { docId: 'doc_collab' });

    // Client 2 sends an edit
    bridge.clearEvents();
    const content = 'shared doc';
    const op = [{ p: 0, i: 'my ' }];
    await bridge2.request('applyOtUpdate', {
      docId: 'doc_collab',
      op,
      v: 0,
      content,
    });

    // Client 1 should receive the remote op
    const evt = await bridge.waitForEvent('otUpdateApplied', 3000);
    assert(evt, 'should receive otUpdateApplied event');
    assert(evt.data.op, 'should have op field (remote update)');
    assertEqual(evt.data.op[0].i, 'my ', 'remote op insert text');

    bridge2.stop();
  });

  // ── Test Suite: History Restore ───────────────────────────────────
  console.log('\nHistory Restore:');

  await test('restore sends removeEntity then reciveNewDoc events', async () => {
    resetDocs();
    const oldDocId = 'doc_restore_old';
    const newDocId = 'doc_restore_new';
    getOrCreateDoc(oldDocId, ['old content']);
    await bridge.request('joinDoc', { docId: oldDocId });

    bridge.clearEvents();

    // Simulate restore from Overleaf history
    await simulateRestore(
      oldDocId,
      newDocId,
      'main.tex',
      '/main.tex',
      ['restored content from history']
    );

    // Wait a bit for events to arrive
    await new Promise(r => setTimeout(r, 200));

    // Client should receive removeEntity event
    const removeEvt = bridge.events.find(e => e.event === 'removeEntity');
    assert(removeEvt, 'should receive removeEntity event');
    assertEqual(removeEvt.data.entityId, oldDocId, 'removeEntity entityId');
    assertEqual(removeEvt.data.meta.kind, 'file-restore', 'removeEntity meta.kind');
    assertEqual(removeEvt.data.meta.path, '/main.tex', 'removeEntity meta.path');

    // Client should receive reciveNewDoc event
    const newDocEvt = bridge.events.find(e => e.event === 'reciveNewDoc');
    assert(newDocEvt, 'should receive reciveNewDoc event');
    assertEqual(newDocEvt.data.doc._id, newDocId, 'reciveNewDoc doc._id');
    assertEqual(newDocEvt.data.doc.name, 'main.tex', 'reciveNewDoc doc.name');
    assertEqual(newDocEvt.data.meta.kind, 'file-restore', 'reciveNewDoc meta.kind');
  });

  await test('new doc is joinable after restore', async () => {
    const result = await bridge.request('joinDoc', { docId: 'doc_restore_new' });
    assert(result.lines, 'should have lines');
    assertEqual(result.lines[0], 'restored content from history', 'restored content');
    assertEqual(result.version, 0, 'new doc starts at version 0');
  });

  await test('can edit restored doc', async () => {
    const content = 'restored content from history';
    const op = [{ p: 0, i: 'EDITED: ' }];
    await bridge.request('applyOtUpdate', {
      docId: 'doc_restore_new',
      op,
      v: 0,
      content,
    });

    const result = await bridge.request('joinDoc', { docId: 'doc_restore_new' });
    assertEqual(result.lines[0], 'EDITED: restored content from history', 'edited restored content');
    assertEqual(result.version, 1, 'version after edit');
  });

  // ── Test Suite: Concurrent Editing ──────────────────────────────
  console.log('\nConcurrent Editing:');

  await test('two clients can edit different positions without conflict', async () => {
    resetDocs();
    getOrCreateDoc('doc_concurrent', ['Hello World']);

    // Client 1 joins
    await bridge.request('joinDoc', { docId: 'doc_concurrent' });

    // Client 2
    const bridge2 = new BridgeClient(port);
    await bridge2.start();
    await bridge2.request('ping');
    await bridge2.request('connect', {
      cookie: 'mock_session=concurrent2',
      projectId: 'test_project',
    });
    await bridge2.request('joinDoc', { docId: 'doc_concurrent' });

    // Client 1 inserts at beginning
    const content = 'Hello World';
    await bridge.request('applyOtUpdate', {
      docId: 'doc_concurrent',
      op: [{ p: 0, i: 'Dear ' }],
      v: 0,
      content,
    });

    // Client 2 inserts at end (using original v=0, which will cause version mismatch
    // since client 1 already bumped version to 1)
    bridge2.clearEvents();
    try {
      await bridge2.request('applyOtUpdate', {
        docId: 'doc_concurrent',
        op: [{ p: 11, i: '!' }],
        v: 0, // stale version
        content,
      });
    } catch (e) {
      // Expected: version mismatch
    }

    // Client 2 should receive either an otUpdateError or version mismatch
    try {
      const evt = await bridge2.waitForEvent('otUpdateError', 2000);
      assert(evt, 'client 2 should get otUpdateError for stale version');
    } catch (e) {
      // Also ok if the request itself threw
    }

    // After client 1's edit, server content should be correct
    const result = await bridge.request('joinDoc', { docId: 'doc_concurrent' });
    assertEqual(result.lines[0], 'Dear Hello World', 'content after client 1 edit');
    assertEqual(result.version, 1, 'version after one edit');

    bridge2.stop();
  });

  await test('client receives remote ops from concurrent edit', async () => {
    resetDocs();
    getOrCreateDoc('doc_realtime', ['line one\nline two\nline three']);

    // Client 1
    await bridge.request('joinDoc', { docId: 'doc_realtime' });

    // Client 2
    const bridge2 = new BridgeClient(port);
    await bridge2.start();
    await bridge2.request('ping');
    await bridge2.request('connect', {
      cookie: 'mock_session=realtime2',
      projectId: 'test_project',
    });
    await bridge2.request('joinDoc', { docId: 'doc_realtime' });

    // Client 2 edits — client 1 should see the remote op
    bridge.clearEvents();
    const content = 'line one\nline two\nline three';
    await bridge2.request('applyOtUpdate', {
      docId: 'doc_realtime',
      op: [{ p: 0, i: 'REMOTE: ' }],
      v: 0,
      content,
    });

    const evt = await bridge.waitForEvent('otUpdateApplied', 3000);
    assert(evt, 'client 1 should receive remote op');
    assert(evt.data.op, 'should have op field');
    assertEqual(evt.data.op[0].i, 'REMOTE: ', 'remote insert text');
    assertEqual(evt.data.v, 0, 'op version');

    // Verify final server state
    const result = await bridge.request('joinDoc', { docId: 'doc_realtime' });
    assertEqual(result.lines[0], 'REMOTE: line one', 'server content updated');
    assertEqual(result.version, 1, 'version incremented');

    bridge2.stop();
  });

  await test('sequential edits from two clients maintain consistency', async () => {
    resetDocs();
    getOrCreateDoc('doc_seq', ['abc']);

    await bridge.request('joinDoc', { docId: 'doc_seq' });

    const bridge2 = new BridgeClient(port);
    await bridge2.start();
    await bridge2.request('ping');
    await bridge2.request('connect', {
      cookie: 'mock_session=seq2',
      projectId: 'test_project',
    });
    await bridge2.request('joinDoc', { docId: 'doc_seq' });

    // Client 1: insert 'X' at position 1 → "aXbc"
    await bridge.request('applyOtUpdate', {
      docId: 'doc_seq',
      op: [{ p: 1, i: 'X' }],
      v: 0,
      content: 'abc',
    });

    // Client 2: insert 'Y' at position 3 (after 'c'), using CORRECT version 1
    // After client 1's edit, content is "aXbc", so position 4 = end
    await bridge2.request('applyOtUpdate', {
      docId: 'doc_seq',
      op: [{ p: 4, i: 'Y' }],
      v: 1,
      content: 'aXbc',
    });

    const result = await bridge.request('joinDoc', { docId: 'doc_seq' });
    assertEqual(result.lines[0], 'aXbcY', 'both edits applied correctly');
    assertEqual(result.version, 2, 'version after two edits');

    bridge2.stop();
  });

  await test('restore during active editing session', async () => {
    resetDocs();
    const docId = 'doc_edit_restore';
    getOrCreateDoc(docId, ['original']);
    await bridge.request('joinDoc', { docId });

    // Client edits the doc
    await bridge.request('applyOtUpdate', {
      docId,
      op: [{ p: 8, i: ' edited' }],
      v: 0,
      content: 'original',
    });

    // Verify edit was applied
    let result = await bridge.request('joinDoc', { docId });
    assertEqual(result.lines[0], 'original edited', 'edit applied');

    // Now simulate a restore (another user restores from history)
    bridge.clearEvents();
    const newDocId = 'doc_edit_restore_v2';
    await simulateRestore(
      docId,
      newDocId,
      'restored.tex',
      '/restored.tex',
      ['content from v1 of history']
    );
    await new Promise(r => setTimeout(r, 200));

    // Client should receive both events
    const removeEvt = bridge.events.find(e => e.event === 'removeEntity');
    assert(removeEvt, 'should receive removeEntity during active session');
    assertEqual(removeEvt.data.entityId, docId, 'correct entity removed');

    const newDocEvt = bridge.events.find(e => e.event === 'reciveNewDoc');
    assert(newDocEvt, 'should receive reciveNewDoc during active session');
    assertEqual(newDocEvt.data.doc._id, newDocId, 'new doc id correct');

    // New doc should be joinable with restored content
    result = await bridge.request('joinDoc', { docId: newDocId });
    assertEqual(result.lines[0], 'content from v1 of history', 'restored content');
  });

  // ── Test Suite: File Tree Events ─────────────────────────────────
  console.log('\nFile Tree Events:');

  await test('reciveNewFile event is forwarded correctly', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: reciveNewFile(parentFolderId, file, meta, userId)
    broadcastEvent('reciveNewFile',
      'root_folder',
      { _id: 'file_img1', name: 'figure.png' },
      {},
      'mock_user_1'
    );
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'reciveNewFile');
    assert(evt, 'should receive reciveNewFile event');
    assertEqual(evt.data.file._id, 'file_img1', 'file id');
    assertEqual(evt.data.file.name, 'figure.png', 'file name');
    assertEqual(evt.data.parentFolderId, 'root_folder', 'parent folder');
  });

  await test('removeEntity event (normal, non-restore) is forwarded', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: removeEntity(entityId, meta)
    broadcastEvent('removeEntity',
      'doc_to_delete',
      {}
    );
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'removeEntity');
    assert(evt, 'should receive removeEntity event');
    assertEqual(evt.data.entityId, 'doc_to_delete', 'entity id');
  });

  await test('rootDocUpdated event is forwarded', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: rootDocUpdated(newRootDocId)
    broadcastEvent('rootDocUpdated', 'new_root_doc_id');
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'rootDocUpdated');
    assert(evt, 'should receive rootDocUpdated event');
    assertEqual(evt.data.docId, 'new_root_doc_id', 'new root doc id');
  });

  // ── Test Suite: Comment Events ─────────────────────────────────
  console.log('\nComment Events:');

  await test('new-comment event is forwarded as newComment', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: new-comment(threadId, comment)
    broadcastEvent('new-comment',
      'thread_abc123',
      { id: 'comment_1', content: 'Great work!', user_id: 'user_42', timestamp: '2026-01-01T00:00:00Z' }
    );
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'newComment');
    assert(evt, 'should receive newComment event');
    assertEqual(evt.data.threadId, 'thread_abc123', 'thread id');
    assertEqual(evt.data.comment.content, 'Great work!', 'comment content');
    assertEqual(evt.data.comment.id, 'comment_1', 'comment id');
  });

  await test('resolve-thread event is forwarded as resolveThread', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: resolve-thread(threadId, user)
    broadcastEvent('resolve-thread',
      'thread_abc123',
      { id: 'user_42', first_name: 'Test', email: 'test@example.com' }
    );
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'resolveThread');
    assert(evt, 'should receive resolveThread event');
    assertEqual(evt.data.threadId, 'thread_abc123', 'thread id');
    assertEqual(evt.data.user.id, 'user_42', 'user id');
  });

  await test('reopen-thread event is forwarded as reopenThread', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: reopen-thread(threadId)
    broadcastEvent('reopen-thread', 'thread_abc123');
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'reopenThread');
    assert(evt, 'should receive reopenThread event');
    assertEqual(evt.data.threadId, 'thread_abc123', 'thread id');
  });

  await test('delete-thread event is forwarded as deleteThread', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: delete-thread(threadId)
    broadcastEvent('delete-thread', 'thread_abc123');
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'deleteThread');
    assert(evt, 'should receive deleteThread event');
    assertEqual(evt.data.threadId, 'thread_abc123', 'thread id');
  });

  // ── Test Suite: Collaborator Tracking ──────────────────────────
  console.log('\nCollaborator Tracking:');

  await test('clientTracking.clientUpdated is forwarded as clientUpdated', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: clientTracking.clientUpdated(user)
    broadcastEvent('clientTracking.clientUpdated', {
      id: 'client_99',
      user_id: 'user_42',
      name: 'Test User',
      email: 'test@example.com',
      row: 5,
      column: 10,
      doc_id: 'doc_main',
    });
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'clientUpdated');
    assert(evt, 'should receive clientUpdated event');
    assertEqual(evt.data.id, 'client_99', 'client id');
    assertEqual(evt.data.user_id, 'user_42', 'user id');
    assertEqual(evt.data.row, 5, 'cursor row');
    assertEqual(evt.data.column, 10, 'cursor column');
    assertEqual(evt.data.doc_id, 'doc_main', 'doc id');
  });

  await test('clientTracking.clientDisconnected is forwarded as clientDisconnected', async () => {
    bridge.clearEvents();
    // Real Overleaf signature: clientTracking.clientDisconnected(id)
    broadcastEvent('clientTracking.clientDisconnected', 'client_99');
    await new Promise(r => setTimeout(r, 200));

    const evt = bridge.events.find(e => e.event === 'clientDisconnected');
    assert(evt, 'should receive clientDisconnected event');
    assertEqual(evt.data.id, 'client_99', 'disconnected client id');
  });

  // ── Cleanup ──────────────────────────────────────────────────────
  bridge.stop();
  await srv.close();

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (errors.length > 0) {
    console.log('\nFailures:');
    for (const { name, error } of errors) {
      console.log(`  ${name}:`);
      console.log(`    ${error.message}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
