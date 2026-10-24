'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { SyncSession } = require('../../../node/sync/session');
const { Workspace } = require('../../../node/sync/workspace');
const { SnapshotStore } = require('../../../node/sync/store');

const base = 'intro\nseparator\nending';
const checkpoint = contents => ({
  history: { current: contents.length - 1, preferred: contents.length - 1,
    nodes: contents.map((content, seq) => ({ seq, parent: seq ? seq - 1 : null, content, empty: content === '' })) },
  tree: { seq_cur: contents.length - 1, seq_last: contents.length - 1 },
  undo: contents.length > 1 ? Buffer.from('opaque fixture').toString('base64') : null,
  options: { fileformat: 'unix', fileencoding: '', endofline: false, fixendofline: false, bomb: false, binary: false, undolevels: 1000 },
});

test('native quit drains large accepted replies without hanging or retaining recovery locks', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-output-exit-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceRoot = path.join(directory, 'sources'); await fs.mkdir(sourceRoot);
  const content = base.repeat(10000);
  await fs.writeFile(path.join(sourceRoot, 'main.tex'), content);
  const options = { root: path.join(directory, 'state'), sourceRoot, server: 'https://example.test', projectId: 'project' };
  const scriptPath = path.join(directory, 'exit.lua');
  await fs.writeFile(scriptPath, `
vim.opt.rtp:append(vim.fn.getcwd())
local bridge = require('overleaf.bridge')
local function rpc(method, params)
  local done, failure, reply = false
  bridge.request(method, params, function(err, value) failure, reply, done = err, value, true end)
  assert(vim.wait(5000, function() return done end), method .. ' timed out')
  assert(not failure, vim.inspect(failure))
  return reply
end
local started = false
bridge.start(function(err) assert(not err, vim.inspect(err)); started = true end)
assert(vim.wait(5000, function() return started end))
local options = vim.json.decode(${JSON.stringify(JSON.stringify(options))})
local session = rpc('syncOpen', options)
local content = table.concat(vim.fn.readfile(options.sourceRoot .. '/main.tex', 'b'), '\\n')
rpc('syncDocument', {session=session.session, document='doc', action='open', path='main.tex', initial={content=content, version=1}})
for _=1,8 do
  bridge.request('syncDocument', {session=session.session, document='doc', action='snapshot'}, function()
    error('A reply resumed editor work during exit')
  end)
end
vim.cmd('q')
`);
  await promisify(execFile)('nvim', ['--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', scriptPath], {
    cwd: path.resolve(__dirname, '../../..'), timeout: 15000,
  });
  const reopened = await SyncSession.open(options);
  try {
    assert.equal((await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' })).state.saved, content);
    assert.equal(await fs.readFile(path.join(sourceRoot, 'main.tex'), 'utf8'), content);
  } finally { await reopened.close(); }
});

for (const [command, mode, count] of [
  ['x', 'edited', 1], ['wq', 'edited', 1], ['wqall', 'edited', 2],
  ['x', 'clean', 1], ['wq', 'clean', 1],
  ['x', 'post-edit', 1], ['wq', 'post-edit', 1],
  ['q', 'pending-checkpoint', 1],
  ['q', 'pending-checkpoint-slow', 1], ['q', 'pending-close', 1],
  ['q', 'pending-checkpoint-timeout', 1],
  ['wq', 'persistent-undo', 1],
  ['wq', 'persistent-undo-crlf', 1],
  ['wq', 'persistent-undo-trailing', 1],
  ['wq', 'persistent-undo-empty', 1],
]) {
  test(`native :${command} with ${mode} buffers preserves saves and workspace ownership across process exit`, async t => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-exit-test-')));
    let reopened;
    t.after(async () => {
      if (reopened) await reopened.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    const sourceRoot = path.join(directory, 'sources');
    await fs.mkdir(sourceRoot);
    const names = Array.from({ length: count }, (_, i) => `${i + 1}.tex`);
    const initial = mode === 'persistent-undo-crlf' ? '\ufeff' + base.replaceAll('\n', '\r\n') + '\r\n' : base;
    for (const name of names) await fs.writeFile(path.join(sourceRoot, name), initial);
    const options = { root: path.join(directory, 'state'), sourceRoot, server: 'https://example.test', projectId: 'project' };
    await fs.writeFile(path.join(directory, 'options.json'), JSON.stringify({ options, names, command, mode, initial }));
    if (mode.startsWith('pending-')) {
      // Intercept an actual fs operation inside the production bridge. The
      // marker is written only after persistence reaches the manifest boundary.
      await fs.writeFile(path.join(directory, 'slow-bridge.cjs'), String.raw`
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const root = process.env.OVERLEAF_EXIT_TEST;
const { mode } = JSON.parse(syncFs.readFileSync(path.join(root, 'options.json'), 'utf8'));
const rename = fs.rename;
let delayed = false;
fs.rename = async function (from, to) {
  if (mode === 'pending-close' && !delayed && syncFs.existsSync(path.join(root, 'arm-delay'))
      && path.basename(from) === 'writer.lock') {
    delayed = true;
    await fs.writeFile(path.join(root, 'accepted.json'), JSON.stringify({ closing: true }));
    await new Promise(resolve => setTimeout(resolve, 1500));
    await rename.call(fs, from, to);
    await fs.writeFile(path.join(root, 'completed'), 'lock released');
    return;
  }
  if (mode !== 'pending-close' && !delayed && syncFs.existsSync(path.join(root, 'arm-delay'))
      && path.basename(path.dirname(to)) === 'documents' && !to.includes('/workspace/')) {
    delayed = true;
    const manifest = JSON.parse(await fs.readFile(from, 'utf8'));
    const snapshot = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(to)), 'objects', manifest.snapshot), 'utf8'));
    await fs.writeFile(path.join(root, 'accepted.json'), JSON.stringify({ revision: snapshot.revision }));
    await new Promise(resolve => setTimeout(resolve, mode.endsWith('-slow') ? 6000 : 1500));
    await rename.call(fs, from, to);
    await fs.writeFile(path.join(root, 'completed'), 'manifest installed');
    return;
  }
  return rename.call(fs, from, to);
};
require(path.join(process.cwd(), 'node/bridge.js'));
`);
    }
    const script = String.raw`
vim.opt.rtp:append(vim.fn.getcwd())
local root = vim.env.OVERLEAF_EXIT_TEST
local case = vim.json.decode(table.concat(vim.fn.readfile(root .. '/options.json'), '\n'))
if case.mode:find('pending-', 1, true) == 1 then
  require('overleaf.config').bridge_script = function() return root .. '/slow-bridge.cjs' end
end
vim.api.nvim_create_autocmd('VimLeavePre', {
  callback = function() vim.fn.writefile({'exiting'}, root .. '/exit-started') end,
})
local bridge = require('overleaf.bridge')
local editor = require('overleaf.editor.session')
local function rpc(method, params)
  local done, failure, result = false, nil, nil
  bridge.request(method, params, function(err, reply) failure, result, done = err, reply, true end)
  assert(vim.wait(5000, function() return done end), method .. ' timed out')
  assert(not failure, vim.inspect(failure))
  return result
end
local started = false
bridge.start(function(err) assert(not err, vim.inspect(err)); started = true end)
assert(vim.wait(5000, function() return started end))
local session = rpc('syncOpen', case.options)
vim.fn.writefile({session.directory}, root .. '/store-path')
local writes, buffers, clients = 0, {}, {}
vim.api.nvim_create_autocmd('VimLeavePre', {
  callback = function()
    local start_error, request_error
    bridge.start(function(err) start_error = err end)
    bridge.request('ping', {}, function(err) request_error = err end)
    assert(start_error and start_error.code == 'STOPPING', 'Exit must prevent bridge restarts')
    assert(request_error and request_error.code == 'STOPPING', 'Exit must reject new requests')
    vim.fn.writefile({vim.json.encode({writes = writes})}, root .. '/exit.json')
  end,
})
for _, name in ipairs(case.names) do
  vim.cmd('silent noautocmd hide edit ' .. vim.fn.fnameescape(case.options.sourceRoot .. '/' .. name))
  local buf = vim.api.nvim_get_current_buf()
  buffers[#buffers + 1] = buf
  vim.bo[buf].fixendofline = false
  if case.mode:find('persistent-undo', 1, true) == 1 then
    vim.o.undodir, vim.bo[buf].undofile = '.', true
  end
  if case.mode == 'persistent-undo-crlf' then
    vim.bo[buf].fileformat, vim.bo[buf].bomb, vim.bo[buf].endofline = 'dos', true, true
  end
  local binding = rpc('syncDocument', {
    session = session.session, document = name, action = 'open', path = name,
    initial = {content = case.initial, version = 1},
  })
  local client = editor.attach(buf, binding, {
    on_status = function() end,
    request = function(method, params, callback)
      if params.action == 'write' then writes = writes + 1 end
      bridge.request(method, params, function(err, reply)
        if vim.fn.filereadable(root .. '/exit-started') == 1 then
          vim.fn.writefile({'late callback'}, root .. '/callback-after-exit')
        end
        callback(err, reply)
      end)
    end,
  })
  assert(vim.wait(5000, function() return client:idle() end))
  assert(not client.paused)
  clients[#clients + 1] = client
end
if case.mode ~= 'clean' then
  for _, buf in ipairs(buffers) do
    local lines = {'SAVED intro', 'separator', 'ending'}
    if case.mode == 'persistent-undo-trailing' then lines[#lines + 1] = '' end
    if case.mode == 'persistent-undo-empty' then lines = {''} end
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].undolevels = vim.bo[buf].undolevels
  end
end
if case.mode:find('pending-', 1, true) == 1 then
  vim.cmd('silent write')
  assert(vim.wait(5000, function() return clients[1]:idle() end))
  assert(not clients[1].paused)
  vim.fn.writefile({'armed'}, root .. '/arm-delay')
  if case.mode ~= 'pending-close' then
    local original_timer_start, timeout_callback = vim.fn.timer_start, nil
    if case.mode == 'pending-checkpoint-timeout' then
      vim.fn.timer_start = function(ms, callback, ...)
        if ms == 30000 and not timeout_callback then timeout_callback = callback end
        return original_timer_start(ms, callback, ...)
      end
    end
    vim.bo[buffers[1]].undolevels = 987
    clients[1]:refresh()
    assert(vim.wait(5000, function() return vim.fn.filereadable(root .. '/accepted.json') == 1 end))
    assert(vim.fn.filereadable(root .. '/completed') == 0, 'Persistence completed before the exit test')
    assert(not clients[1]:idle(), 'The checkpoint must still be in progress')
    vim.fn.timer_start = original_timer_start
    if case.mode == 'pending-checkpoint-timeout' then
      -- Queue the real request timeout callback immediately before final exit.
      -- It must not resume editor work when the shutdown wait pumps the loop.
      assert(timeout_callback)
      timeout_callback()
    end
  end
  assert(not vim.bo[buffers[1]].modified, 'Quit must not require discarding unsaved text')
end
if case.mode == 'post-edit' then
  local buf = buffers[1]
  vim.api.nvim_create_autocmd('BufWritePost', {
    buffer = buf, once = true, callback = function()
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'UNSAVED post-write edit'})
      vim.bo[buf].undolevels = vim.bo[buf].undolevels
    end,
  })
  local ok, err = pcall(vim.cmd, 'silent ' .. case.command)
  assert(not ok and tostring(err):find('SAVE_CHANGED', 1, true), tostring(err))
  assert(vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified)
  assert(vim.fn.filereadable(root .. '/exit.json') == 0, 'Exit hooks ran despite unsaved edits')
  assert(vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1] == 'UNSAVED post-write edit')
  vim.fn.writefile({'exit prevented'}, root .. '/prevented')
  -- Explicitly discard only this disposable test buffer after proving the
  -- ordinary save-and-quit command refused to exit. No production drain helper.
  vim.cmd('qa!')
end
-- Exercise the production exit path: no test-only close or bridge drain.
vim.cmd('silent ' .. case.command)
error('Quit command returned without exiting')
`;
    const scriptPath = path.join(directory, 'exit.lua');
    await fs.writeFile(scriptPath, script);
    await promisify(execFile)('nvim', ['--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', scriptPath], {
      cwd: path.resolve(__dirname, '../../..'), timeout: 15000,
      env: { ...process.env, OVERLEAF_EXIT_TEST: directory },
    });
    const expected = mode === 'persistent-undo-crlf' ? '\ufeffSAVED ' + base.replaceAll('\n', '\r\n') + '\r\n'
      : mode === 'persistent-undo-trailing' ? 'SAVED ' + base + '\n'
        : mode === 'persistent-undo-empty' ? ''
          : mode === 'clean' ? base : 'SAVED ' + base;
    const report = JSON.parse(await fs.readFile(path.join(directory, 'exit.json'), 'utf8'));
    await assert.rejects(fs.stat(path.join(directory, 'callback-after-exit')), { code: 'ENOENT' });
    assert.equal(report.writes, mode === 'clean' && command === 'x' ? 0 : count);
    if (mode === 'post-edit') assert.equal(await fs.readFile(path.join(directory, 'prevented'), 'utf8'), 'exit prevented\n');
    const storePath = (await fs.readFile(path.join(directory, 'store-path'), 'utf8')).trim();
    for (const name of names) {
      assert.equal(await fs.readFile(path.join(sourceRoot, name), 'utf8'), expected);
      const record = await new SnapshotStore(storePath).read(name);
      assert.equal(record.state.saved, expected);
      assert.equal(record.state.disk.pending, null);
      if (mode.startsWith('pending-checkpoint')) {
        const accepted = JSON.parse(await fs.readFile(path.join(directory, 'accepted.json'), 'utf8'));
        assert.ok(record.revision >= accepted.revision, 'Exit must finish the accepted recovery checkpoint');
        assert.equal(record.state.editor.checkpoint.options.undolevels, 987);
        assert.equal(await fs.readFile(path.join(directory, 'completed'), 'utf8'), 'manifest installed');
      }
    }
    if (mode === 'pending-close') {
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'accepted.json'), 'utf8')), { closing: true });
      assert.equal(await fs.readFile(path.join(directory, 'completed'), 'utf8'), 'lock released');
    }
    if (mode.startsWith('persistent-undo')) {
      const reopenScript = path.join(directory, 'reopen.lua');
      await fs.writeFile(reopenScript, String.raw`
vim.o.undodir = '.'
vim.o.undofile = true
vim.cmd('silent edit ' .. vim.fn.fnameescape(vim.env.OVERLEAF_REOPEN_SOURCE))
assert(vim.api.nvim_get_current_line() == (vim.env.OVERLEAF_REOPEN_EMPTY == 'true' and '' or 'SAVED intro'))
assert(vim.fn.undotree().save_last == 1)
assert(not vim.bo.modified)
vim.cmd('silent undo')
assert(vim.api.nvim_get_current_line() == 'intro')
assert(vim.bo.modified)
vim.cmd('silent redo')
assert(vim.api.nvim_get_current_line() == (vim.env.OVERLEAF_REOPEN_EMPTY == 'true' and '' or 'SAVED intro'))
assert(not vim.bo.modified)
`);
      await promisify(execFile)('nvim', ['--headless', '--noplugin', '-u', 'NONE', '-i', 'NONE', '-l', reopenScript], {
        timeout: 10000, env: { ...process.env, OVERLEAF_REOPEN_SOURCE: path.join(sourceRoot, names[0]), OVERLEAF_REOPEN_EMPTY: String(mode === 'persistent-undo-empty') },
      });
    }
    reopened = await SyncSession.open(options);
    for (const name of names) {
      const restored = await reopened.document({ document: name, action: 'open', path: name });
      assert.equal(restored.state.saved, expected);
    }
    await reopened.close();
  });
}

async function fixture(t, content = base, initial = base) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-coordinator-')));
  const sourceRoot = path.join(directory, 'sources');
  await fs.mkdir(sourceRoot);
  const filename = path.join(sourceRoot, 'main.tex');
  if (content !== null) await fs.writeFile(filename, content);
  const options = { root: path.join(directory, 'state'), sourceRoot, server: 'https://example.test', projectId: 'project' };
  const events = [];
  const sessions = [];
  const openSession = async () => {
    const session = await SyncSession.open(options, event => events.push(event));
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    for (const session of sessions) await session.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const session = await openSession();
  const call = (action, fields = {}) => session.document({ document: 'doc', action, ...fields });
  const binding = await call('open', { path: 'main.tex', initial: { content: initial, version: 1 } });
  return { session, call, binding, filename, sourceRoot, events, openSession };
}

test('migration rejects changed legacy evidence without changing saved or native branches', async t => {
  const { session, call, binding, filename, sourceRoot } = await fixture(t);
  const attached = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const legacy = path.join(path.dirname(sourceRoot), 'legacy.tex');
  await fs.writeFile(legacy, 'reviewed legacy');
  const source = await Workspace.readLegacy(legacy);
  await fs.writeFile(legacy, 'newer legacy');
  await assert.rejects(call('importBranch', { source, checkpoint: checkpoint([base]), revision: attached.revision }),
    { code: 'STALE_FILE' });
  const state = await call('snapshot');
  assert.equal(state.result.conflict, null);
  assert.equal(state.result.saved, base);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'newer legacy');
  await session.project({ name: 'Paper', tree: [] });
  await assert.rejects(call('importBranch', { source: await Workspace.readLegacy(legacy),
    checkpoint: checkpoint([base]), revision: state.revision }), { code: 'MIGRATION_HELD' });
});

test('binding materializes a new file but preserves an existing independent local branch', async t => {
  const fresh = await fixture(t, null);
  assert.equal(await fs.readFile(fresh.filename, 'utf8'), base);
  assert.equal(fresh.binding.state.disk.content, base);
  const divergent = await fixture(t, 'independent local');
  assert.equal(await fs.readFile(divergent.filename, 'utf8'), 'independent local');
  assert.equal(divergent.binding.state.conflict.inputs.base, null);
  assert.equal(divergent.binding.state.buffer, 'independent local');
});

test('periodic rescans recover dropped watchers across many background documents', async t => {
  const { session, call, sourceRoot } = await fixture(t);
  const documents = Array.from({ length: 24 }, (_, i) => ({ id: 'background-' + i, path: 'chapters/' + i + '.tex' }));
  await Promise.all(documents.map(entry => session.document({ document: entry.id, action: 'open', path: entry.path,
    initial: { content: base, version: 1 } })));
  for (const watcher of session._watchers.values()) watcher.close();
  session._watchers.clear();
  await Promise.all(documents.map(entry => fs.writeFile(path.join(sourceRoot, entry.path), entry.id + '\n' + base)));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && documents.some(entry => session._documents.get(entry.id).snapshot().saved !== entry.id + '\n' + base)) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  for (const entry of documents) {
    const state = session._documents.get(entry.id).snapshot();
    assert.equal(state.saved, entry.id + '\n' + base);
    assert.equal(state.editor ?? null, null);
    assert.equal(state.conflict, null);
    assert.equal(await fs.readFile(path.join(sourceRoot, entry.path), 'utf8'), state.saved);
  }
  assert.ok(session._watchers.size > 0);
  assert.equal((await call('snapshot')).result.saved, base);
});

test('binary assets install exact bytes and update only an unchanged local branch', async t => {
  const { session, sourceRoot } = await fixture(t);
  const first = Buffer.from([0, 255, 13, 10, 128]);
  const second = Buffer.from([255, 0, 128]);
  const asset = bytes => session.asset({ document: 'image', path: 'images/plot.png', bytes: bytes.toString('base64') });
  assert.equal((await asset(first)).state.status, 'synced');
  const filename = path.join(sourceRoot, 'images/plot.png');
  assert.deepEqual(await fs.readFile(filename), first);
  assert.equal((await asset(second)).state.status, 'synced');
  assert.deepEqual(await fs.readFile(filename), second);
  await fs.writeFile(filename, first);
  assert.equal((await asset(second)).state.status, 'local-changes');
  assert.deepEqual(await fs.readFile(filename), first);
});

test('binary divergence and unrelated preexisting files retain every branch without overwriting source', async t => {
  const { session, sourceRoot } = await fixture(t);
  const asset = bytes => session.asset({ document: 'image', path: 'plot.png', bytes: Buffer.from(bytes).toString('base64') });
  await asset('base');
  const filename = path.join(sourceRoot, 'plot.png');
  await fs.writeFile(filename, 'local');
  const reply = await asset('remote');
  assert.equal(reply.state.status, 'conflict');
  assert.deepEqual(reply.state.conflict, { base: Buffer.from('base').toString('base64'),
    local: Buffer.from('local').toString('base64'), remote: Buffer.from('remote').toString('base64') });
  assert.equal(await fs.readFile(filename, 'utf8'), 'local');
  await fs.writeFile(path.join(sourceRoot, 'independent.bin'), 'unrelated');
  const independent = await session.asset({ document: 'other', path: 'independent.bin', bytes: Buffer.from('remote').toString('base64') });
  assert.equal(independent.state.conflict.base, null);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'independent.bin'), 'utf8'), 'unrelated');
});

test('binary baselines survive reopen and a missing known source requires explicit recovery', async t => {
  const { session, sourceRoot, openSession } = await fixture(t);
  const params = { document: 'image', path: 'plot.png', bytes: Buffer.from('base').toString('base64') };
  await session.asset(params);
  await session.close();
  const next = await openSession();
  await fs.unlink(path.join(sourceRoot, 'plot.png'));
  assert.equal((await next.asset({ ...params, bytes: Buffer.from('remote').toString('base64') })).state.status, 'missing-file');
  await assert.rejects(fs.stat(path.join(sourceRoot, 'plot.png')), { code: 'ENOENT' });
  await assert.rejects(next.asset({ ...params, path: 'renamed.png' }), { code: 'PATH_BOUND' });
});

test('binary observation detects a competing writer before installation and retains the candidate', async t => {
  const { session, sourceRoot } = await fixture(t);
  const params = { document: 'image', path: 'plot.png', bytes: Buffer.from('base').toString('base64') };
  await session.asset(params);
  const write = session._workspace.write.bind(session._workspace);
  session._workspace.write = async (...args) => {
    await fs.writeFile(path.join(sourceRoot, 'plot.png'), 'external');
    return write(...args);
  };
  const held = await session.asset({ ...params, bytes: Buffer.from('remote').toString('base64') });
  assert.equal(held.state.status, 'write-recovery');
  assert.equal(held.state.pending.bytes, Buffer.from('remote').toString('base64'));
  assert.equal(await fs.readFile(path.join(sourceRoot, 'plot.png'), 'utf8'), 'external');
  session._workspace.write = write;
  const retry = await session.asset(params);
  assert.equal(retry.state.status, 'write-recovery');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'plot.png'), 'utf8'), 'external');
});

test('binary ownership excludes document sources and accepts a genuinely empty remote file', async t => {
  const { session, sourceRoot } = await fixture(t);
  await assert.rejects(session.asset({ document: 'image', path: 'main.tex', bytes: '' }), { code: 'PATH_BOUND' });
  const empty = await session.asset({ document: 'empty', path: 'empty.bin', bytes: '' });
  assert.equal(empty.state.status, 'synced');
  assert.equal((await fs.stat(path.join(sourceRoot, 'empty.bin'))).size, 0);
  await assert.rejects(session.asset({ document: 'invalid', path: 'invalid.bin', bytes: 'bad base64' }));
  await assert.rejects(fs.stat(path.join(sourceRoot, 'invalid.bin')), { code: 'ENOENT' });
});

test('binary conflict choices are explicit and stale reviews cannot replace a newer local file', async t => {
  const { session, sourceRoot } = await fixture(t);
  const params = { document: 'image', path: 'plot.png' };
  const asset = content => session.asset({ ...params, bytes: Buffer.from(content).toString('base64') });
  await asset('base');
  const filename = path.join(sourceRoot, 'plot.png');
  await fs.writeFile(filename, 'local');
  const review = await asset('remote');
  await fs.writeFile(filename, 'newer local');
  await assert.rejects(session.asset({ ...params, choice: 'remote', revision: review.revision,
    observation: review.observation }), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'newer local');
  const fresh = await asset('remote');
  const kept = await session.asset({ ...params, choice: 'local', revision: fresh.revision, observation: fresh.observation });
  assert.equal(kept.state.status, 'local-changes');
  assert.equal(kept.state.recovery.conflict.local, Buffer.from('local').toString('base64'));
  assert.equal(await fs.readFile(filename, 'utf8'), 'newer local');
  const conflict = await asset('remote again');
  assert.equal(conflict.state.status, 'conflict');
  const accepted = await session.asset({ ...params, choice: 'remote', revision: conflict.revision,
    observation: conflict.observation });
  assert.equal(accepted.state.status, 'synced');
  assert.equal(await fs.readFile(filename, 'utf8'), 'remote again');
  assert.equal(accepted.state.recovery.local, Buffer.from('newer local').toString('base64'));
});

test('binary interrupted writes can adopt the reviewed current source without retrying the candidate', async t => {
  const { session, sourceRoot } = await fixture(t);
  const params = { document: 'image', path: 'plot.png', bytes: Buffer.from('base').toString('base64') };
  await session.asset(params);
  const filename = path.join(sourceRoot, 'plot.png');
  const write = session._workspace.write.bind(session._workspace);
  session._workspace.write = async (...args) => {
    await write(...args);
    throw new Error('confirmation lost');
  };
  const held = await session.asset({ ...params, bytes: Buffer.from('remote').toString('base64') });
  assert.equal(held.state.status, 'write-recovery');
  session._workspace.write = write;
  await fs.writeFile(filename, 'actual current');
  const review = await session.asset({ document: 'image', path: 'plot.png' });
  const recovered = await session.asset({ document: 'image', path: 'plot.png', choice: 'local',
    revision: review.revision, observation: review.observation });
  assert.equal(recovered.state.status, 'local-changes');
  assert.equal(recovered.state.pending, null);
  assert.equal(recovered.state.recovery.pending.bytes, Buffer.from('remote').toString('base64'));
  assert.equal(await fs.readFile(filename, 'utf8'), 'actual current');
});

test('binary lifecycle rename and replacement preserve bytes and separate identities', async t => {
  const { session, sourceRoot } = await fixture(t);
  const local = Buffer.from([0, 255, 13, 10]);
  await session.asset({ document: 'image', path: 'plot.png', bytes: local.toString('base64') });
  await session.project({ name: 'Paper', tree: [{ id: 'image', path: 'figures/plot.png', type: 'file' }] });
  let review = await session.assetLifecycle({ document: 'image', action: 'review' });
  let accepted = await session.assetLifecycle({ document: 'image', action: 'rename', review });
  assert.equal(accepted.state.path, 'figures/plot.png');
  assert.equal(accepted.state.lifecycle, null);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'plot.png')), local);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'figures/plot.png')), local);
  await session.project({ name: 'Paper', tree: [{ id: 'new-image', path: 'figures/plot.png', type: 'file' }] });
  review = await session.assetLifecycle({ document: 'image', action: 'review' });
  accepted = await session.assetLifecycle({ document: 'image', action: 'archive', review });
  assert.equal(accepted.state.status, 'local-only');
  assert.notEqual(accepted.state.path, 'figures/plot.png');
  const remote = Buffer.from([1, 2, 3]);
  const fresh = await session.asset({ document: 'new-image', path: 'figures/plot.png', bytes: remote.toString('base64') });
  assert.equal(fresh.state.status, 'conflict');
  assert.equal(fresh.state.conflict.base, null);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, accepted.state.path)), local);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'figures/plot.png')), local);
});

test('binary lifecycle decisions require unchanged source and remote identity', async t => {
  const { session, sourceRoot } = await fixture(t);
  await session.asset({ document: 'image', path: 'plot.png', bytes: Buffer.from('base').toString('base64') });
  await session.project({ name: 'Paper', tree: [] });
  let review = await session.assetLifecycle({ document: 'image', action: 'review' });
  await fs.writeFile(path.join(sourceRoot, 'plot.png'), 'external');
  await assert.rejects(session.assetLifecycle({ document: 'image', action: 'local', review }), { code: 'STALE_FILE' });
  review = await session.assetLifecycle({ document: 'image', action: 'review' });
  await session.project({ name: 'Paper', tree: [{ id: 'replacement', path: 'plot.png', type: 'file' }] });
  await assert.rejects(session.assetLifecycle({ document: 'image', action: 'local', review }), { code: 'STALE_LIFECYCLE' });
  review = await session.assetLifecycle({ document: 'image', action: 'review' });
  const kept = await session.assetLifecycle({ document: 'image', action: 'local', review });
  assert.equal(kept.state.status, 'local-only');
  await session.asset({ document: 'image', path: 'plot.png', bytes: Buffer.from('late').toString('base64') });
  assert.equal(await fs.readFile(path.join(sourceRoot, 'plot.png'), 'utf8'), 'external');
});

test('blocked text archive destinations still allow keeping the source local', async t => {
  for (const obstruction of ['binding', 'link']) {
    const { session, call, sourceRoot, filename } = await fixture(t);
    await session.project({ name: 'Paper', tree: [] });
    const target = (await call('reviewLifecycle')).result.workspace.to;
    if (obstruction === 'binding') await session._workspace.bind(target, 'other');
    else await fs.symlink(filename, path.join(sourceRoot, target));
    const review = (await call('reviewLifecycle')).result;
    assert.equal(review.workspace, null);
    assert.equal(review.workspaceError.code, obstruction === 'binding' ? 'PATH_BOUND' : 'UNSAFE_PATH');
    await assert.rejects(call('archiveLocal', { review }), { code: 'STALE_LIFECYCLE' });
    const kept = await call('keepLocal', { review });
    assert.equal(kept.state.publication, 'local-only');
    assert.equal(await fs.readFile(filename, 'utf8'), base);
  }
});

test('a text rename review explains a bound destination without blocking local retention', async t => {
  const { session, call, filename } = await fixture(t);
  await session._workspace.bind('moved.tex', 'other');
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'moved.tex', type: 'doc' }] });
  const rename = (await call('reviewRelocation')).result;
  assert.equal(rename.workspace, null);
  assert.equal(rename.workspaceError.code, 'PATH_BOUND');
  const review = (await call('reviewLifecycle')).result;
  await call('keepLocal', { review });
  assert.equal((await call('state')).state.publication, 'local-only');
  assert.equal(await fs.readFile(filename, 'utf8'), base);
});

test('blocked binary rename and archive destinations still allow keeping the source local', async t => {
  const { session, sourceRoot } = await fixture(t);
  const bytes = Buffer.from([0, 255, 1]);
  await session.asset({ document: 'image', path: 'plot.png', bytes: bytes.toString('base64') });
  await session.project({ name: 'Paper', tree: [{ id: 'image', path: 'moved.png', type: 'file' }] });
  const first = await session.assetLifecycle({ document: 'image', action: 'review' });
  await session._workspace.bind('moved.png', 'other');
  await fs.symlink(path.join(sourceRoot, 'plot.png'), path.join(sourceRoot, first.archive.to));
  const review = await session.assetLifecycle({ document: 'image', action: 'review' });
  assert.equal(review.relocation, null);
  assert.equal(review.relocationError.code, 'PATH_BOUND');
  assert.equal(review.archive, null);
  assert.equal(review.archiveError.code, 'UNSAFE_PATH');
  const kept = await session.assetLifecycle({ document: 'image', action: 'local', review });
  assert.equal(kept.state.status, 'local-only');
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'plot.png')), bytes);
});

test('binary relocation completes its committed binding after an interrupted record update', async t => {
  const { session, sourceRoot, openSession } = await fixture(t);
  await session.asset({ document: 'image', path: 'plot.png', bytes: Buffer.from('base').toString('base64') });
  await session.project({ name: 'Paper', tree: [{ id: 'image', path: 'new.png', type: 'file' }] });
  const review = await session.assetLifecycle({ document: 'image', action: 'review' });
  const write = session._store.write.bind(session._store);
  const injected = t.mock.method(session._store, 'write', async (key, ...args) => {
    if (key === JSON.stringify(['asset', 'image'])) throw new Error('interrupted asset persistence');
    return write(key, ...args);
  });
  await assert.rejects(session.assetLifecycle({ document: 'image', action: 'rename', review }), /interrupted asset persistence/);
  injected.mock.restore();
  await session.close();
  const reopened = await openSession();
  const next = await reopened.asset({ document: 'image', path: 'new.png' });
  assert.equal(next.state.lifecycle, null);
  assert.equal(next.state.status, 'synced');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'new.png'), 'utf8'), 'base');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'plot.png'), 'utf8'), 'base');
});

test('remote tree deletion and rename hold automatic source updates while preserving local saves', async t => {
  const { session, call, filename, binding } = await fixture(t);
  await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'renamed.tex', type: 'doc' }] });
  let reply = await call('state');
  assert.equal(reply.state.lifecycle.reason, 'remote-renamed');
  await call('remote', { remote: { content: base.replace('ending', 'REMOTE ending'), version: 2 } });
  await call('scan');
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  reply = await call('state');
  await call('write', { checkpoint: checkpoint([base, 'SAVED ' + base]), expected: base, revision: reply.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), 'SAVED ' + base);
  await session.project({ name: 'Paper', tree: [] });
  assert.equal((await call('state')).state.lifecycle.reason, 'remote-deleted');
  assert.equal((await call('snapshot')).result.disk.content, 'SAVED ' + base);
  await session.project({ name: 'Paper', tree: [{ id: 'replacement', path: 'main.tex', type: 'doc' }] });
  assert.equal((await call('state')).state.lifecycle.reason, 'remote-replaced');
  await assert.rejects(session.document({ document: 'replacement', action: 'open', path: 'main.tex',
    initial: { content: 'restored', version: 1 } }), { code: 'PATH_BOUND' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'SAVED ' + base);
});

test('keeping a deleted source locally preserves editor history and disables remote publication across restart', async t => {
  const { session, call, binding, filename, openSession } = await fixture(t);
  const attached = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const local = checkpoint([base, 'UNSAVED ' + base]);
  await call('checkpoint', { checkpoint: local, revision: attached.revision });
  await session.project({ name: 'Paper', tree: [] });
  await call('remote', { remote: { content: 'remote target', version: 2 } });
  const review = (await call('reviewLifecycle')).result;
  const kept = await call('keepLocal', { review, checkpoint: local });
  assert.equal(kept.state.lifecycle, null);
  assert.equal(kept.state.publication, 'local-only');
  assert.equal(kept.state.buffer, 'UNSAVED ' + base);
  assert.equal(kept.state.saved, base);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  let snapshot = (await call('snapshot')).result;
  assert.deepEqual(snapshot.editor.checkpoint, local);
  assert.equal(snapshot.recovery.localOnly.remote.content, 'remote target');
  await call('remote', { remote: { content: 'late remote', version: 3 } });
  assert.equal((await call('snapshot')).result.remote.content, 'remote target');
  await call('write', { checkpoint: local, expected: base, revision: kept.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), 'UNSAVED ' + base);
  assert.equal(await session._documents.get('doc').prepareUpload('connection'), null);
  await session.close();
  const reopened = await openSession();
  const next = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(next.state.publication, 'local-only');
  assert.equal(next.state.lifecycle, null);
  assert.equal(next.state.saved, 'UNSAVED ' + base);
  assert.equal(await reopened._documents.get('doc').prepareUpload('connection'), null);
});

test('keeping a source locally retires its transport and never rejoins it on reconnect', async t => {
  const { session, call, binding } = await fixture(t);
  let observer, stopped = false, joins = 0;
  const sent = [];
  const socket = { server: 'https://example.test', projectId: 'project', publicId: 'connection', connected: true,
    observeDocument(_id, handlers) { observer = handlers; return () => { stopped = true; }; },
    async joinDoc() { joins++; return { lines: base.split('\n'), version: 1, updates: [] }; },
    sendUpdate(update) { sent.push(update); return new Promise(() => {}); },
  };
  await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await session.connectDocument('doc', socket);
  const state = await call('state');
  const local = checkpoint([base, 'SAVED ' + base]);
  await call('write', { checkpoint: local, expected: base, revision: state.revision });
  await session.transportIdle('doc');
  assert.equal(sent.length, 1);
  await session.project({ name: 'Paper', tree: [] });
  const review = (await call('reviewLifecycle')).result;
  await call('keepLocal', { review, checkpoint: local });
  await observer.applied({ doc: 'doc', v: 1 });
  assert.equal(stopped, true);
  assert.equal((await call('snapshot')).result.recovery.localOnly.pending.content, 'SAVED ' + base);
  assert.equal((await session.connectDocument('doc', socket)).state, 'local-only');
  assert.equal(joins, 1);
  assert.equal(sent.length, 1);
});

test('keeping a source locally refuses stale reviews and keeps a replacement identity separate', async t => {
  for (const change of ['tree', 'source', 'document']) {
    const { session, call, filename } = await fixture(t);
    await session.project({ name: 'Paper', tree: [] });
    const review = (await call('reviewLifecycle')).result;
    if (change === 'tree') await session.project({ name: 'Paper', tree: [{ id: 'new', path: 'main.tex', type: 'doc' }] });
    if (change === 'source') await fs.writeFile(filename, 'external');
    if (change === 'document') await call('remote', { remote: { content: 'late', version: 2 } });
    await assert.rejects(call('keepLocal', { review }), { code: change === 'source' ? 'STALE_FILE' : 'STALE_LIFECYCLE' });
    assert.notEqual((await call('state')).state.publication, 'local-only');
    const current = (await call('reviewLifecycle')).result;
    await call('keepLocal', { review: current });
    await assert.rejects(session.document({ document: 'new', action: 'open', path: 'main.tex', initial: { content: 'restored', version: 1 } }), { code: 'PATH_BOUND' });
    assert.equal(await fs.readFile(filename, 'utf8'), change === 'source' ? 'external' : base);
  }
});

test('archiving a replaced generation frees its path without reusing its editor or remote identity', async t => {
  const { session, call, binding, sourceRoot, filename } = await fixture(t);
  const attached = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const local = checkpoint([base, 'OLD UNSAVED ' + base]);
  await call('checkpoint', { checkpoint: local, revision: attached.revision });
  await session.project({ name: 'Paper', tree: [{ id: 'new', path: 'main.tex', type: 'doc' }] });
  const review = (await call('reviewLifecycle')).result;
  assert.notEqual(review.workspace.to, 'main.tex');
  const archived = await call('archiveLocal', { review, checkpoint: local });
  assert.equal(archived.state.publication, 'local-only');
  assert.equal(archived.state.lifecycle, null);
  assert.equal(archived.state.buffer, 'OLD UNSAVED ' + base);
  assert.equal(await fs.readFile(path.join(sourceRoot, archived.workspace.path), 'utf8'), base);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  const fresh = await session.document({ document: 'new', action: 'open', path: 'main.tex', initial: { content: 'new remote generation', version: 1 } });
  assert.equal(fresh.state.conflict.inputs.base, null);
  assert.equal(fresh.state.conflict.inputs.local, base);
  assert.equal(fresh.state.conflict.inputs.remote, 'new remote generation');
  assert.equal(fresh.state.editorAttached, false);
  await call('write', { checkpoint: local, expected: base, revision: archived.revision });
  assert.equal(await fs.readFile(path.join(sourceRoot, archived.workspace.path), 'utf8'), 'OLD UNSAVED ' + base);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
});

test('an interrupted local archive remains reviewable and can be abandoned without losing either copy', async t => {
  const { session, call, filename, sourceRoot } = await fixture(t);
  await session.project({ name: 'Paper', tree: [] });
  const review = (await call('reviewLifecycle')).result;
  const write = session._workspace._store.write.bind(session._workspace._store);
  const injected = t.mock.method(session._workspace._store, 'write', async (key, ...args) => {
    if (key === 'bindings') throw new Error('binding interrupted');
    return write(key, ...args);
  });
  await assert.rejects(call('archiveLocal', { review }), /binding interrupted/);
  injected.mock.restore();
  assert.equal((await call('state')).state.lifecycle.reason, 'local-archive');
  const current = (await call('reviewLifecycle')).result;
  await call('keepLocal', { review: current });
  assert.equal((await call('state')).state.lifecycle, null);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal(await fs.readFile(path.join(sourceRoot, review.workspace.to), 'utf8'), base);
});

test('archive review refuses a remote tree entry at its proposed local path', async t => {
  const { session, call, filename } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'new', path: 'main.tex', type: 'doc' }] });
  const review = (await call('reviewLifecycle')).result;
  await session.project({ name: 'Paper', tree: [
    { id: 'new', path: 'main.tex', type: 'doc' },
    { id: 'occupied', path: review.workspace.to, type: 'doc' },
  ] });
  await assert.rejects(call('archiveLocal', { review }), { code: 'PATH_BOUND' });
  assert.equal((await call('state')).workspace.path, 'main.tex');
  assert.equal(await fs.readFile(filename, 'utf8'), base);
});

test('a retained local generation can still be archived after reviewing its replacement again', async t => {
  const { session, call, filename } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'new', path: 'main.tex', type: 'doc' }] });
  let review = (await call('reviewLifecycle')).result;
  await call('keepLocal', { review });
  const retained = (await call('snapshot')).result.recovery.localOnly;
  assert.equal((await call('state')).state.lifecycle.reason, 'remote-replaced');
  review = (await call('reviewLifecycle')).result;
  const archived = await call('archiveLocal', { review });
  assert.equal(archived.state.lifecycle, null);
  assert.equal(archived.state.publication, 'local-only');
  assert.deepEqual((await call('snapshot')).result.recovery.localOnly, retained);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
});

test('reviewed remote relocation preserves saved bytes and unsaved editor history', async t => {
  const { session, call, filename, binding, sourceRoot } = await fixture(t);
  const local = checkpoint([base, 'UNSAVED ' + base]);
  const attached = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await call('checkpoint', { checkpoint: local, revision: attached.revision });
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'chapters/new.tex', type: 'doc' }] });
  const before = (await call('snapshot')).result;
  const review = (await call('reviewRelocation')).result;
  const moved = await call('relocate', { review });
  assert.equal(moved.workspace.path, 'chapters/new.tex');
  assert.equal(moved.state.lifecycle, null);
  assert.equal(moved.state.buffer, 'UNSAVED ' + base);
  assert.equal(moved.state.saved, base);
  assert.deepEqual((await call('snapshot')).result.editor, before.editor);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'chapters/new.tex'), 'utf8'), base);
  await call('write', { checkpoint: local, expected: base, revision: moved.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'chapters/new.tex'), 'utf8'), 'UNSAVED ' + base);
});

test('remote relocation refuses a stale editor save after the binding changed', async t => {
  const { session, call, filename, sourceRoot } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'new.tex', type: 'doc' }] });
  const review = (await call('reviewRelocation')).result;
  const moved = await call('relocate', { review });
  await assert.rejects(call('write', { sourcePath: 'main.tex', checkpoint: checkpoint([base, 'wrong path']),
    expected: base, revision: moved.revision }), { code: 'PATH_BOUND' });
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'new.tex'), 'utf8'), base);
});

test('remote relocation retains an uninstalled persistent history proposal and both existing archives', async t => {
  const { session, call, filename, sourceRoot, target, saved } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const proposal = await call('scan');
  assert.equal(proposal.result.status, 'undo-required');
  const undo = await fs.readFile(target);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'new.tex', type: 'doc' }] });
  const review = (await call('reviewRelocation')).result;
  const moved = await call('relocate', { review });
  const state = (await call('snapshot')).result;
  assert.equal(moved.state.disk.pending, null);
  assert.equal(state.recovery.relocationDisk.pending.token, proposal.result.token);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'new.tex'), 'utf8'), saved);
  assert.deepEqual(await fs.readFile(target), undo);
});

test('remote relocation rejects stale tree, document, and source reviews', async t => {
  for (const change of ['tree', 'document', 'source']) {
    const { session, call, filename, sourceRoot } = await fixture(t);
    await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'new.tex', type: 'doc' }] });
    const review = (await call('reviewRelocation')).result;
    if (change === 'tree') await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'different.tex', type: 'doc' }] });
    if (change === 'document') await call('remote', { remote: { content: base + ' remote', version: 2 } });
    if (change === 'source') await fs.writeFile(filename, 'external');
    await assert.rejects(call('relocate', { review }), { code: change === 'source' ? 'STALE_FILE' : 'STALE_RELOCATION' });
    assert.equal((await call('state')).workspace.path, 'main.tex');
    await assert.rejects(fs.stat(path.join(sourceRoot, 'new.tex')), { code: 'ENOENT' });
  }
});

test('remote relocation completes its proven binding after interrupted document persistence', async t => {
  const { session, call, filename, openSession, sourceRoot } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'new.tex', type: 'doc' }] });
  const review = (await call('reviewRelocation')).result;
  const write = session._store.write.bind(session._store);
  const injected = t.mock.method(session._store, 'write', async (key, ...args) => {
    if (key === 'doc') throw new Error('interrupted document persistence');
    return write(key, ...args);
  });
  await assert.rejects(call('relocate', { review }), /interrupted document persistence/);
  injected.mock.restore();
  await session.close();
  const reopened = await openSession();
  try {
    const result = await reopened.document({ document: 'doc', action: 'open', path: 'new.tex' });
    assert.equal(result.workspace.path, 'new.tex');
    assert.equal(result.state.lifecycle, null);
    assert.equal(result.state.saved, base);
    assert.equal(await fs.readFile(filename, 'utf8'), base);
    assert.equal(await fs.readFile(path.join(sourceRoot, 'new.tex'), 'utf8'), base);
  } finally { await reopened.close(); }
});

test('feature positions project remote comments and cursors into an unsaved native view without publishing it', async t => {
  const wire = 'é😀 abc';
  const { session, call, filename } = await fixture(t, wire, wire);
  const sent = [];
  await session.connectDocument('doc', { server: 'https://example.test', projectId: 'project', publicId: 'connection', connected: true,
    observeDocument() { return () => {}; },
    async joinDoc() { return { lines: [wire], version: 1, ranges: { comments: [{ id: 'thread', op: { p: 4, c: 'abc', t: 'thread' } }] } }; },
    async sendUpdate(update) { sent.push(update); },
  });
  const before = (await call('snapshot')).result;
  const view = 'UNSAVED ' + wire;
  const comments = (await call('features', { view })).result;
  assert.deepEqual(comments.comments, [{ id: 'thread', content: 'abc', start: { row: 0, col: 15 }, end: { row: 0, col: 18 } }]);
  const cursor = (await call('features', { view, cursor: { row: 0, column: 4 } })).result;
  assert.deepEqual(cursor.cursor, { row: 0, col: 15 });
  await assert.rejects(call('features', { view, cursor: { row: 0, column: 2 } }), { code: 'INVALID_POSITION' });
  assert.deepEqual((await call('snapshot')).result, before);
  assert.equal(await fs.readFile(filename, 'utf8'), wire);
  assert.equal(sent.length, 0);
});

test('local builds capture exact saved sources and binaries in a separate immutable input directory', async t => {
  const { session, call, binding, filename, sourceRoot } = await fixture(t);
  const attached = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await call('checkpoint', { checkpoint: checkpoint([base, 'UNSAVED ' + base]), revision: attached.revision });
  const image = Buffer.from([0, 255, 10, 13]);
  await session.asset({ document: 'image', path: 'figures/plot.png', bytes: image.toString('base64') });
  await session.project({ name: 'Paper', tree: [
    { id: 'doc', type: 'doc', path: 'main.tex' },
    { id: 'image', type: 'file', path: 'figures/plot.png' },
  ] });
  const build = await session.captureBuild();
  assert.ok(!build.directory.startsWith(sourceRoot + path.sep));
  assert.equal(await fs.readFile(path.join(build.directory, 'main.tex'), 'utf8'), base);
  assert.deepEqual(await fs.readFile(path.join(build.directory, 'figures/plot.png')), image);
  assert.equal((await call('state')).state.buffer, 'UNSAVED ' + base);
  await fs.writeFile(filename, 'later external save');
  assert.equal(await fs.readFile(path.join(build.directory, 'main.tex'), 'utf8'), base);
  const next = await session.captureBuild();
  assert.notEqual(next.fingerprint, build.fingerprint);
  assert.notEqual(next.directory, build.directory);
  assert.equal(await fs.readFile(path.join(next.directory, 'main.tex'), 'utf8'), 'later external save');
  assert.equal(await fs.readFile(filename, 'utf8'), 'later external save');
});

test('build retention removes only completed private captures and survives reopening', async t => {
  const { session, openSession, sourceRoot, filename } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', type: 'doc', path: 'main.tex' }] });
  const active = await session.captureBuild();
  const finished = [];
  for (let i = 0; i < 12; i++) {
    const build = await session.captureBuild();
    await session.finishBuild({ token: build.token });
    finished.push(build);
  }
  await fs.stat(active.directory);
  await assert.rejects(fs.stat(finished[0].directory), { code: 'ENOENT' });
  await assert.rejects(fs.stat(finished[1].directory), { code: 'ENOENT' });
  for (const build of finished.slice(2)) await fs.stat(build.directory);
  await session.close();
  const reopened = await openSession();
  try {
    const next = await reopened.captureBuild();
    await reopened.finishBuild({ token: next.token });
    await assert.rejects(fs.stat(finished[2].directory), { code: 'ENOENT' });
    await fs.stat(active.directory);
    await assert.rejects(reopened.finishBuild({ token: active.token }), { code: 'STALE_BUILD' });
    await assert.rejects(reopened.finishBuild({ token: '../sources' }), { code: 'STALE_BUILD' });
    assert.equal(await fs.readFile(filename, 'utf8'), base);
    assert.ok(!next.directory.startsWith(sourceRoot + path.sep));
  } finally { await reopened.close(); }
});

test('local builds reject moving inputs instead of capturing a mixture of saves', async t => {
  const { session, filename } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', type: 'doc', path: 'main.tex' }] });
  const inspect = session._workspace.inspect.bind(session._workspace);
  let first = true;
  session._workspace.inspect = async relative => {
    const result = await inspect(relative);
    if (first) { first = false; await fs.writeFile(filename, 'changed during capture'); }
    return result;
  };
  await assert.rejects(session.captureBuild(), { code: 'BUILD_INPUT_CHANGED' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'changed during capture');
});

test('local builds reject missing and unresolved renamed inputs', async t => {
  const { session, filename } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', type: 'doc', path: 'renamed.tex' }] });
  await assert.rejects(session.captureBuild(), { code: 'BUILD_INPUT_UNAVAILABLE' });
  await session.project({ name: 'Paper', tree: [{ id: 'doc', type: 'doc', path: 'main.tex' }] });
  await fs.unlink(filename);
  await assert.rejects(session.captureBuild(), { code: 'BUILD_INPUT_UNAVAILABLE' });
});

test('remote compilation waits for the captured saved revision to be applied and excludes later unsaved edits', async t => {
  const { session, call, binding, filename } = await fixture(t);
  let observer;
  const sent = [];
  const connection = { server: 'https://example.test', projectId: 'project', publicId: 'compile-connection', connected: true,
    observeDocument(_id, handlers) { observer = handlers; return () => {}; },
    async joinDoc() { return { lines: base.split('\n'), version: 1, updates: [] }; },
    sendUpdate(update) { sent.push(update); return Promise.resolve({ queued: true }); },
  };
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'main.tex', type: 'doc' }] });
  await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await session.connectDocument('doc', connection);
  let state = await call('state');
  const saved = 'SAVED ' + base;
  state = await call('write', { checkpoint: checkpoint([base, saved]), revision: state.revision, expected: base });
  await session.transportIdle('doc');
  const captured = await session.captureBuild({ inspectOnly: true });
  assert.equal(captured.directory, undefined);
  assert.equal((await session.compileReady(captured)).ready, false);
  state = await call('state');
  await call('checkpoint', { checkpoint: checkpoint([base, saved, 'UNSAVED ' + saved]), revision: state.revision });
  assert.equal((await session.compileReady(captured)).ready, false);
  await observer.applied({ doc: 'doc', v: 1 });
  assert.equal((await session.compileReady(captured)).ready, true);
  assert.equal(sent.length, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await call('state')).state.buffer, 'UNSAVED ' + saved);
  await fs.writeFile(filename, 'new saved revision');
  await assert.rejects(session.compileReady(captured), { code: 'BUILD_INPUT_CHANGED' });
});

test('remote compilation refuses offline, changed-tree, and local binary inputs', async t => {
  const { session, sourceRoot } = await fixture(t);
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'main.tex', type: 'doc' }] });
  const captured = await session.captureBuild({ inspectOnly: true });
  await assert.rejects(session.compileReady(captured), { code: 'COMPILE_OFFLINE' });
  await session.project({ name: 'Paper', tree: [] });
  await assert.rejects(session.compileReady(captured), { code: 'BUILD_INPUT_CHANGED' });
  await session.project({ name: 'Paper', tree: [{ id: 'image', path: 'plot.png', type: 'file' }] });
  await session.asset({ document: 'image', path: 'plot.png', bytes: Buffer.from('remote image').toString('base64') });
  await fs.writeFile(path.join(sourceRoot, 'plot.png'), 'LOCAL image');
  const binary = await session.captureBuild({ inspectOnly: true });
  await assert.rejects(session.compileReady(binary), { code: 'COMPILE_HELD' });
});

test('remote compilation refuses unconfirmed upload outcomes', async t => {
  const { session, call, binding } = await fixture(t);
  let observer;
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'main.tex', type: 'doc' }] });
  await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await session.connectDocument('doc', { server: 'https://example.test', projectId: 'project', publicId: 'compile-connection', connected: true,
    observeDocument(_id, handlers) { observer = handlers; return () => {}; },
    async joinDoc() { return { lines: base.split('\n'), version: 1, updates: [] }; },
    sendUpdate() { return new Promise(() => {}); },
  });
  const state = await call('state');
  await call('write', { checkpoint: checkpoint([base, 'SAVED ' + base]), revision: state.revision, expected: base });
  await session.transportIdle('doc');
  const captured = await session.captureBuild({ inspectOnly: true });
  await observer.applied({ doc: 'doc', v: 40 });
  await assert.rejects(session.compileReady(captured), { code: 'COMPILE_HELD' });
});

test('saved A plus incoming C reaches disk while unsaved B stays only in the buffer', async t => {
  const { call, filename, binding } = await fixture(t);
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const a = 'A intro\nseparator\nending';
  const b = 'A plus unsaved B\nseparator\nending';
  reply = await call('write', { checkpoint: checkpoint([base, a]), expected: base, revision: reply.revision });
  reply = await call('checkpoint', { checkpoint: checkpoint([base, a, b]), revision: reply.revision });
  await call('remote', { remote: { content: base.replace('ending', 'C ending'), version: 2 } });
  reply = await call('state');
  const prepared = await call('prepare', { revision: reply.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), a.replace('ending', 'C ending'));
  assert.equal(prepared.state.saved, a.replace('ending', 'C ending'));
  assert.equal(prepared.state.buffer, b.replace('ending', 'C ending'));
  assert.equal(prepared.result.history.nodes[0].content, base.replace('ending', 'C ending'));
  assert.equal(prepared.state.disk.pending, null);
  assert.equal(prepared.state.disk.content, prepared.state.saved);
});

test('reconciles external atomic saves and ignores its own write echo without losing unsaved text', async t => {
  const { call, filename, binding } = await fixture(t);
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  reply = await call('checkpoint', { checkpoint: checkpoint([base, 'MY ' + base]), revision: reply.revision });
  const external = base.replace('ending', 'external ending');
  await fs.writeFile(filename + '.new', external);
  await fs.rename(filename + '.new', filename);
  reply = await call('prepare', { revision: reply.revision });
  assert.equal(reply.state.saved, external);
  assert.equal(reply.state.buffer, 'MY ' + external);
  const snapshot = await call('snapshot');
  const scanned = await call('scan');
  assert.equal(scanned.revision, snapshot.revision);
  assert.equal(await fs.readFile(filename, 'utf8'), external);
});

test('disk changes during installation hold recovery instead of overwriting the external writer', async t => {
  const { call, filename } = await fixture(t);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (String(name).endsWith('.overleaf-tmp')) await fs.writeFile(filename, 'external during staging');
    return handle;
  });
  const reply = await call('remote', { remote: { content: 'remote', version: 2 } });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external during staging');
  assert.equal(reply.state.disk.held.reason, 'write-recovery');
  assert.equal(reply.state.disk.pending.content, 'remote');
  const recovery = (await call('diskState')).result;
  assert.equal(Buffer.from(recovery.observed.bytes, 'base64').toString(), 'external during staging');
  assert.equal(Buffer.from(recovery.record.state.pending.bytes, 'base64').toString(), 'remote');
});

test('a race before source staging can rescan and merge rather than retry a stale replacement', async t => {
  const { call, filename } = await fixture(t);
  const write = Workspace.prototype.write;
  let raced = false;
  t.mock.method(Workspace.prototype, 'write', async function (...args) {
    if (!raced) {
      raced = true;
      await fs.writeFile(filename, 'LOCAL ' + base);
    }
    return write.apply(this, args);
  });
  const remote = base.replace('ending', 'THEIR ending');
  const reply = await call('remote', { remote: { content: remote, version: 2 } });
  assert.equal(await fs.readFile(filename, 'utf8'), 'LOCAL ' + remote);
  assert.equal(reply.state.disk.pending, null);
  assert.equal(reply.state.conflict, null);
});

test('restart rescans saved changes that never reached the engine and retains previous unsaved checkpoints', async t => {
  const { call, filename, binding, session, openSession } = await fixture(t);
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await call('checkpoint', { checkpoint: checkpoint([base, 'UNSAVED ' + base]), revision: reply.revision });
  await session.close();
  const external = base.replace('ending', 'offline ending');
  await fs.writeFile(filename, external);
  const reopened = await openSession();
  const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(restored.state.saved, external);
  assert.equal(restored.state.buffer, 'UNSAVED ' + external);
  const snapshot = (await reopened.document({ document: 'doc', action: 'snapshot' })).result;
  assert.equal(snapshot.editor.checkpoint.history.nodes[1].content, 'UNSAVED ' + base);
  assert.equal(await fs.readFile(filename, 'utf8'), external);
});

test('restart retains an interrupted write even when the candidate is now on disk', async t => {
  const { call, filename, session, openSession } = await fixture(t);
  const write = Workspace.prototype.write;
  t.mock.method(Workspace.prototype, 'write', async function (...args) {
    await write.apply(this, args);
    throw new Error('injected lost completion');
  });
  const failed = await call('remote', { remote: { content: 'incoming', version: 2 } });
  assert.ok(failed.state.disk.pending);
  assert.equal(await fs.readFile(filename, 'utf8'), 'incoming');
  await session.close();
  const reopened = await openSession();
  const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(restored.state.disk.held.reason, 'write-recovery');
  assert.equal(restored.state.disk.pending.content, 'incoming');
  assert.equal(restored.state.disk.content, base);
});

test('missing bound files hold synchronization and never authorize remote deletion or resurrection', async t => {
  const { call, filename } = await fixture(t);
  await fs.unlink(filename);
  const reply = await call('scan');
  assert.equal(reply.state.disk.held.reason, 'missing-file');
  assert.equal(reply.state.saved, base);
  await call('remote', { remote: { content: 'new remote', version: 2 } });
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('binding identity survives restart and prevents two documents from owning the same path', async t => {
  const { call, session, openSession } = await fixture(t);
  await assert.rejects(session.document({ document: 'another', action: 'open', path: 'main.tex', initial: { content: base, version: 1 } }), { code: 'PATH_BOUND' });
  await session.close();
  const reopened = await openSession();
  await assert.rejects(reopened.document({ document: 'doc', action: 'open', path: 'renamed.tex' }), { code: 'PATH_BOUND' });
  assert.ok(call);
});

test('directory notifications detect repeated atomic saves and stop when the session closes', async t => {
  const { filename, events, session } = await fixture(t);
  const waitForEvent = async start => {
    const deadline = Date.now() + 3000;
    while (events.length === start && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.length > start, 'directory change was not reported');
    assert.equal(events.at(-1).document, 'doc');
    assert.equal(events.at(-1).session, session.id);
  };
  for (const text of ['first', 'second']) {
    const start = events.length;
    await fs.writeFile(filename + '.new', text);
    await fs.rename(filename + '.new', filename);
    await waitForEvent(start);
  }
  await session.close();
  const stopped = events.length;
  await fs.writeFile(filename, 'after close');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(events.length, stopped);
});


test('guarded editor saves durably record exact checkpoint bytes before reporting success', async t => {
  const { call, filename, binding, session, openSession } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const edited = 'MY ' + base;
  const reply = await call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: observed.revision });
  assert.equal(reply.result.content, edited);
  assert.equal(await fs.readFile(filename, 'utf8'), edited);
  assert.equal(reply.state.saved, edited);
  assert.equal(reply.state.disk.pending, null);
  await session.close();
  const reopened = await openSession();
  const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(restored.state.saved, edited);
  assert.equal(restored.state.disk.content, edited);
});

// Header fixtures exercise the coordinator's text-hash check; native format
// validity and complete imports are exercised in the actual Neovim exit test.
function undoHeader(text) {
  const header = Buffer.alloc(47);
  Buffer.from('Vim\x9fUnDo\xe5', 'latin1').copy(header);
  header.writeUInt16BE(3, 9);
  createHash('sha256').update(text.split('\n').map(line => line + '\0').join('')).digest().copy(header, 11);
  header.writeUInt32BE(text.split('\n').length, 43);
  return header.toString('base64');
}

test('guarded write RPC publishes frozen undo and prepares incoming changes without a source-only write', async t => {
  const { call, filename, binding, sourceRoot } = await fixture(t);
  let observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const edited = 'MY ' + base;
  const target = path.join(sourceRoot, '.main.tex.un~');
  const encoded = undoHeader(edited);
  observed = await call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: observed.revision,
    undo: { path: target, bytes: encoded } });
  assert.equal(observed.result.status, 'written');
  assert.equal((await fs.readFile(target)).toString('base64'), encoded);
  assert.equal((await call('diskState')).result.record.state.pending, null);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  assert.equal(await fs.readFile(filename, 'utf8'), edited);
  assert.equal((await fs.readFile(target)).toString('base64'), encoded);
  assert.equal(prepared.result.status, 'undo-required');
  assert.equal(prepared.result.checkpoint.history.nodes[1].content, edited);
  assert.equal(prepared.result.history.nodes[1].content, edited.replace('ending', 'THEIR ending'));
});

async function savedUndoFixture(t, source = base) {
  const fixtureState = await fixture(t, source, source);
  const { call, binding, sourceRoot } = fixtureState;
  const observed = await call('checkpoint', { checkpoint: checkpoint([source]), revision: binding.revision });
  const saved = 'MY ' + source;
  const target = path.join(sourceRoot, '.main.tex.un~');
  const reply = await call('write', { checkpoint: checkpoint([source, saved]), expected: source, revision: observed.revision,
    undo: { path: target, bytes: undoHeader(saved) } });
  return { ...fixtureState, reply, saved, target };
}

function preparedUndo(result) {
  const current = result.history.nodes.find(node => node.seq === result.history.current).content;
  const bytes = undoHeader(current);
  return { token: result.token, checkpoint: { ...result.checkpoint, history: result.history, undo: bytes }, bytes };
}

test('incoming persistent history survives a live undo join which removed the saved state', async t => {
  const { call, reply, saved, target, filename } = await savedUndoFixture(t);
  await call('checkpoint', { checkpoint: checkpoint([base, 'UNSAVED ' + base]), revision: reply.revision });
  const remote = await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('prepare', { revision: remote.revision });
  assert.equal(prepared.result.status, 'undo-required');
  assert.equal(prepared.result.checkpoint.history.nodes[1].content, saved);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  const written = await call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: prepared.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), saved.replace('ending', 'THEIR ending'));
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved.replace('ending', 'THEIR ending')));
  assert.equal(written.state.buffer, 'UNSAVED ' + base.replace('ending', 'THEIR ending'));
  assert.equal(written.state.disk.pending, null);
  const record = (await call('diskState')).result.record;
  assert.deepEqual(record.state.undo.checkpoint.history, prepared.result.history);
});

test('a newer remote revision invalidates prepared persistent history without changing either file', async t => {
  const { call, saved, filename, target } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const newer = await call('remote', { remote: { content: base.replace('ending', 'NEWER ending'), version: 3 } });
  await assert.rejects(call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: newer.revision }), { code: 'STALE_DISK_WRITE' });
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
  const retried = await call('prepare', { revision: newer.revision });
  assert.notEqual(retried.result.token, prepared.result.token);
  assert.equal(retried.result.content, saved.replace('ending', 'NEWER ending'));
});

test('a remote rename invalidates prepared persistent publication without changing source or undo', async t => {
  const { session, call, saved, filename, target } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  assert.equal(prepared.result.status, 'undo-required');
  await session.project({ name: 'Paper', tree: [{ id: 'doc', path: 'renamed.tex', type: 'doc' }] });
  await assert.rejects(call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: prepared.revision }),
    { code: 'LIFECYCLE_HELD' });
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
});

test('source operations wait for earlier metadata persistence before deciding whether to install', async t => {
  const { session, call, filename } = await fixture(t);
  const write = session._store.write.bind(session._store);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  session._store.write = async (key, ...args) => {
    if (key === JSON.stringify(['project'])) { entered(); await blocked; }
    return write(key, ...args);
  };
  const changed = session.project({ name: 'Paper', tree: [] });
  await started;
  let finished = false;
  const received = call('remote', { remote: { content: 'remote replacement', version: 2 } }).then(value => {
    finished = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const ranBeforeMetadata = finished;
  release();
  await changed;
  await received;
  assert.equal(ranBeforeMetadata, false);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal((await call('state')).state.lifecycle.reason, 'remote-deleted');
});

test('binary generations hold an older fetched response after deletion or rename', async t => {
  const { session, sourceRoot } = await fixture(t);
  const params = { document: 'asset', path: 'plot.png' };
  await session.asset({ ...params, bytes: Buffer.from('old bytes').toString('base64') });
  await session.project({ name: 'Paper', tree: [] });
  const held = await session.asset({ ...params, bytes: Buffer.from('late bytes').toString('base64') });
  assert.equal(held.state.lifecycle.reason, 'remote-deleted');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'plot.png'), 'utf8'), 'old bytes');
});

test('native rejection cancels only preparation and leaves ordinary saves available', async t => {
  const { call, filename, saved } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const held = await call('holdDiskUndo', { token: prepared.result.token, reason: 'undo-metadata' });
  assert.equal(held.result.status, 'held');
  assert.equal(held.state.disk.pending, null);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  const target = prepared.result.path;
  const written = await call('write', { revision: held.revision, expected: saved,
    checkpoint: checkpoint([base, 'NEW ' + base]), undo: { path: target, bytes: undoHeader('NEW ' + base) } });
  assert.equal(written.result.status, 'written');
});

test('a different native tree cannot satisfy a prepared persistent update', async t => {
  const { call, filename, saved } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const fields = preparedUndo(prepared.result);
  fields.checkpoint.history.nodes[0].content = 'discarded original history';
  await assert.rejects(call('writeDiskUndo', { ...fields, revision: prepared.revision }), { code: 'INVALID_UNDO' });
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
});

test('an ordinary save supersedes an uninstalled persistent undo proposal', async t => {
  const { call, saved, target, filename } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const content = 'NEW ' + base;
  const written = await call('write', { revision: prepared.revision, expected: saved,
    checkpoint: checkpoint([base, content]), undo: { path: target, bytes: undoHeader(content) } });
  assert.equal(written.result.status, 'written');
  assert.equal(await fs.readFile(filename, 'utf8'), content);
  await assert.rejects(call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: written.revision }), { code: 'STALE_DISK_WRITE' });
});

test('a source edit before prepared undo installation is preserved and can be reconciled again', async t => {
  const source = 'intro\nseparator\nmiddle\nseparator\nending';
  const { call, saved, target, filename } = await savedUndoFixture(t, source);
  await call('remote', { remote: { content: source.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const external = saved.replace('middle', 'EXTERNAL middle');
  await fs.writeFile(filename, external);
  await assert.rejects(call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: prepared.revision }), { code: 'STALE_DISK_WRITE' });
  assert.equal(await fs.readFile(filename, 'utf8'), external);
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
  const again = await call('scan');
  assert.equal(again.result.content, external.replace('ending', 'THEIR ending'));
});

test('restarting with a prepared persistent update retains it for recovery without changing source or undo', async t => {
  const { call, saved, target, filename, session, openSession } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  await session.close();
  const reopened = await openSession();
  const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(restored.state.disk.held.reason, 'write-recovery');
  assert.equal(restored.state.disk.pending.token, prepared.result.token);
  assert.equal(restored.state.disk.pending.undo.checkpoint.history.nodes[1].content, saved);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
});

test('an inactive persistent branch conflict holds the disk update and preserves every saved undo state', async t => {
  const { call, binding, sourceRoot, filename } = await fixture(t);
  const initial = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const saved = 'MY ' + base, archive = checkpoint([base, saved]);
  archive.history.nodes.push({ seq: 2, parent: 0, content: base.replace('ending', 'ALTERNATE ending'), empty: false });
  archive.tree.seq_last = 2;
  const target = path.join(sourceRoot, '.main.tex.un~');
  await call('write', { checkpoint: archive, expected: base, revision: initial.revision,
    undo: { path: target, bytes: undoHeader(saved) } });
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const held = await call('scan');
  assert.equal(held.state.conflict, null);
  assert.equal(held.result.status, 'held');
  assert.equal(held.result.reason, 'persistent-undo');
  assert.equal(held.result.seq, 2);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
  assert.deepEqual((await call('diskState')).result.record.state.undo.checkpoint.history, archive.history);
});

test('a failed incoming undo publication cannot be cancelled as an uninstalled preparation', async t => {
  const { call, saved, target, filename } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const prepared = await call('scan');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === target) throw new Error('injected undo installation failure');
    return rename(from, to);
  });
  await assert.rejects(call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: prepared.revision }), { code: 'WRITE_UNCERTAIN' });
  assert.equal(await fs.readFile(filename, 'utf8'), saved.replace('ending', 'THEIR ending'));
  assert.equal((await fs.readFile(target)).toString('base64'), undoHeader(saved));
  await assert.rejects(call('holdDiskUndo', { token: prepared.result.token, reason: 'undo-metadata' }), { code: 'STALE_DISK_WRITE' });
  const disk = (await call('diskState')).result.record;
  assert.ok(disk.state.pending.sourceInstalled);
  assert.deepEqual(disk.state.pending.undo.checkpoint.history, prepared.result.history);
});

test('rejects undo artifacts for different text, malformed base64, or missing captured history before saving', async t => {
  const { call, filename, binding, sourceRoot } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const edited = 'MY ' + base;
  for (const bytes of [undoHeader(base), undoHeader(edited) + '\n', Buffer.from('invalid').toString('base64'), null]) {
    await assert.rejects(call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: observed.revision,
      undo: { path: path.join(sourceRoot, '.main.tex.un~'), bytes } }), { code: 'INVALID_UNDO' });
  }
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  assert.equal((await call('snapshot')).result.disk.pending, null);
});

test('a history-free checkpoint requires null undo bytes and clears obsolete history on a clean save', async t => {
  const { call, filename, binding, sourceRoot } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const target = path.join(sourceRoot, '.main.tex.un~');
  await fs.writeFile(target, Buffer.from(undoHeader(base), 'base64'));
  const fields = { checkpoint: checkpoint([base]), expected: base, revision: observed.revision };
  await assert.rejects(call('write', { ...fields, undo: { path: target, bytes: undoHeader(base) } }), { code: 'INVALID_UNDO' });
  const written = await call('write', { ...fields, undo: { path: target, bytes: null } });
  assert.equal(written.result.status, 'written');
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const disk = (await call('diskState')).result.record;
  assert.equal(disk.state.pending, null);
  assert.equal(disk.state.undo.observed.exists, false);
});

test('undo publication failure keeps the engine save uncertain with both artifacts available after restart', async t => {
  const { call, filename, binding, sourceRoot, session, openSession } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const target = path.join(sourceRoot, '.main.tex.un~');
  const edited = 'MY ' + base;
  const link = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === target) throw Object.assign(new Error('denied undo write'), { code: 'EACCES' });
    return link(from, to);
  });
  await assert.rejects(call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: observed.revision,
    undo: { path: target, bytes: undoHeader(edited) } }), { code: 'WRITE_UNCERTAIN' });
  assert.equal(await fs.readFile(filename, 'utf8'), edited);
  await session.close();
  const reopened = await openSession();
  const restored = await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  assert.equal(restored.state.saved, base);
  assert.equal(restored.state.disk.held.reason, 'write-recovery');
  const disk = await reopened.document({ document: 'doc', action: 'diskState' });
  assert.equal(disk.result.record.state.pending.undo.bytes, undoHeader(edited));
  assert.equal(disk.result.record.state.pending.sourceInstalled.bytes, Buffer.from(edited).toString('base64'));
});

test('guarded saves reject unseen disk bytes and stale revisions without changing sources', async t => {
  const { call, filename, binding } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const fields = { checkpoint: checkpoint([base, 'MY ' + base]), expected: base, revision: observed.revision };
  await fs.writeFile(filename, 'external');
  await assert.rejects(call('write', fields), { code: 'DISK_CHANGED' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external');
  assert.equal((await call('snapshot')).result.saved, base);
  await assert.rejects(call('write', { ...fields, revision: binding.revision }), { code: 'STALE_REVISION' });
});

test('uncertain editor writes retain the original, candidate, and checkpoint across restart', async t => {
  const { call, filename, binding, session, openSession } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const write = Workspace.prototype.write;
  t.mock.method(Workspace.prototype, 'write', async function (...args) {
    await write.apply(this, args);
    throw new Error('injected lost write completion');
  });
  const edited = 'MY ' + base;
  await assert.rejects(call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: observed.revision }),
    { code: 'WRITE_UNCERTAIN' });
  assert.equal(await fs.readFile(filename, 'utf8'), edited);
  await session.close();
  const reopened = await openSession();
  await reopened.document({ document: 'doc', action: 'open', path: 'main.tex' });
  const restored = (await reopened.document({ document: 'doc', action: 'snapshot' })).result;
  assert.equal(restored.saved, base);
  assert.equal(restored.disk.pending.before, base);
  assert.equal(restored.disk.pending.content, edited);
  assert.equal(restored.disk.pending.checkpoint.history.nodes[1].content, edited);
  assert.equal(restored.disk.held.reason, 'write-recovery');
});

test('an external change during guarded save staging is preserved with recovery evidence', async t => {
  const { call, filename, binding } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (String(name).endsWith('.overleaf-tmp')) await fs.writeFile(filename, 'external during save');
    return handle;
  });
  await assert.rejects(call('write', { checkpoint: checkpoint([base, 'MY ' + base]), expected: base, revision: observed.revision }),
    { code: 'WRITE_UNCERTAIN' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external during save');
  const state = (await call('snapshot')).result;
  assert.equal(state.saved, base);
  assert.equal(state.disk.pending.content, 'MY ' + base);
});


test('workspace sessions reject bypass saves and read-only source files', async t => {
  const { call, filename, binding } = await fixture(t);
  const observed = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await assert.rejects(call('save', { checkpoint: checkpoint([base, 'MY ' + base]),
    bytes: Buffer.from('MY ' + base).toString('base64'), revision: observed.revision }), { code: 'GUARDED_SAVE_REQUIRED' });
  await fs.chmod(filename, 0o444);
  await assert.rejects(call('write', { checkpoint: checkpoint([base, 'MY ' + base]), expected: base,
    revision: observed.revision }), { code: 'READ_ONLY' });
  assert.equal(await fs.readFile(filename, 'utf8'), base);
});


test('explicit disk recovery uses the inspected source and retains the unsaved save candidate', async t => {
  const { call, filename, binding } = await fixture(t);
  const edited = 'SAVED ' + base;
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw new Error('interrupted source');
    return rename(from, to);
  });
  await assert.rejects(call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: reply.revision }), { code: 'WRITE_UNCERTAIN' });
  injected.mock.restore();
  const inspected = await call('diskState');
  reply = await call('recoverDisk', { revision: inspected.revision, choice: 'keep-current', inspection: inspected.result });
  assert.equal(reply.state.saved, base);
  assert.equal(reply.state.disk.pending, null);
  assert.equal(reply.state.disk.held, null);
  assert.equal(reply.state.held.reason, 'recovery');
  const state = (await call('snapshot')).result;
  assert.equal(state.recovery.disk.pending.content, edited);
  assert.equal(await fs.readFile(filename, 'utf8'), base);
  reply = await call('checkpoint', { checkpoint: checkpoint([base, edited]), revision: reply.revision });
  reply = await call('write', { checkpoint: checkpoint([base, edited]), expected: base, revision: reply.revision });
  assert.equal(reply.result.status, 'written');
  assert.equal(await fs.readFile(filename, 'utf8'), edited);
});

test('disk recovery rejects obsolete choices and observations before changing either recovery record', async t => {
  const { call, filename, binding } = await fixture(t);
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const rename = fs.rename.bind(fs);
  const injected = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === filename) throw new Error('interrupted source');
    return rename(from, to);
  });
  await assert.rejects(call('write', { checkpoint: checkpoint([base, 'SAVED ' + base]), expected: base, revision: reply.revision }), { code: 'WRITE_UNCERTAIN' });
  injected.mock.restore();
  const inspected = await call('diskState');
  const fields = { revision: inspected.revision, choice: 'keep-current', inspection: inspected.result };
  await assert.rejects(call('recoverDisk', { ...fields, choice: 'overwrite' }), { code: 'INVALID_RECOVERY' });
  await fs.writeFile(filename, 'external edit');
  await assert.rejects(call('recoverDisk', fields), { code: 'STALE_FILE' });
  const current = await call('diskState');
  assert.deepEqual(current.result.record, inspected.result.record);
  await call('remote', { remote: { content: base + ' remote', version: 2 } });
  await assert.rejects(call('recoverDisk', { ...fields, inspection: current.result }), { code: 'STALE_REVISION' });
  assert.deepEqual((await call('diskState')).result.record, inspected.result.record);
});

test('an applied network ACK waits for the complete local save transaction and publishes only its committed successor', async t => {
  const { session, call, binding, filename } = await fixture(t);
  let observer;
  const sent = [];
  const socket = { server: 'https://example.test', projectId: 'project', publicId: 'connection', connected: true,
    observeDocument(_id, handlers) { observer = handlers; return () => {}; },
    async joinDoc() { return { lines: base.split('\n'), version: 1, updates: [] }; },
    sendUpdate(update) { sent.push(update); return new Promise(() => {}); },
  };
  let reply = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  await session.connectDocument('doc', socket);
  reply = await call('state');
  const first = 'FIRST ' + base, second = 'SECOND ' + base;
  await call('write', { checkpoint: checkpoint([base, first]), revision: reply.revision, expected: base });
  await session.transportIdle('doc');
  reply = await call('state');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const write = session._workspace.write.bind(session._workspace);
  const mocked = t.mock.method(session._workspace, 'write', async (...args) => { entered(); await gate; return write(...args); });
  const saving = call('write', { checkpoint: checkpoint([base, first, second]), revision: reply.revision, expected: first });
  await started;
  let ackFinished = false;
  const ack = observer.applied({ doc: 'doc', v: 1 }).then(() => { ackFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ackFinished, false);
  assert.equal(sent.length, 1);
  release();
  await Promise.all([saving, ack]);
  mocked.mock.restore();
  await session.transportIdle('doc');
  assert.equal(await fs.readFile(filename, 'utf8'), second);
  const state = (await call('snapshot')).result;
  assert.equal(state.remote.content, first);
  assert.equal(state.saved, second);
  assert.equal(state.pending.content, second);
  assert.equal(state.disk.pending, null);
  assert.equal(sent.length, 2);
});

test('explicit persistent-history resolution retains every saved branch and requires separate publication', async t => {
  const { call, binding, sourceRoot, filename } = await fixture(t);
  const initial = await call('checkpoint', { checkpoint: checkpoint([base]), revision: binding.revision });
  const saved = 'MY ' + base, archive = checkpoint([base, saved]);
  archive.history.nodes.push({ seq: 2, parent: 0, content: base.replace('ending', 'ALTERNATE ending'), empty: false });
  archive.tree.seq_last = 2;
  const target = path.join(sourceRoot, '.main.tex.un~');
  await call('write', { checkpoint: archive, expected: base, revision: initial.revision,
    undo: { path: target, bytes: undoHeader(saved) } });
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const inspection = await call('diskState');
  const choice = base.replace('ending', 'ALTERNATE with THEIR ending');
  const prepared = await call('prepareDiskUndoResolution', { revision: inspection.revision,
    workspaceRevision: inspection.result.record.revision, resolutions: { 2: choice } });
  assert.equal(prepared.result.status, 'undo-required');
  assert.equal(prepared.result.history.nodes[2].content, choice);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  const automatic = await call('scan');
  assert.equal(automatic.result.reason, 'persistent-undo-review');
  await call('writeDiskUndo', { ...preparedUndo(prepared.result), revision: automatic.revision });
  assert.equal(await fs.readFile(filename, 'utf8'), saved.replace('ending', 'THEIR ending'));
  const state = (await call('diskState')).result.record.state.undo.checkpoint;
  assert.equal(state.history.nodes[2].content, choice);
  assert.equal(state.history.nodes.length, 3);
});

test('persistent-history review refuses an intervening source edit before preparing any publication', async t => {
  const { call, filename } = await savedUndoFixture(t);
  await call('remote', { remote: { content: base.replace('ending', 'THEIR ending'), version: 2 } });
  const inspected = await call('diskState');
  await fs.writeFile(filename, 'external source');
  await assert.rejects(call('prepareDiskUndoResolution', { revision: inspected.revision,
    workspaceRevision: inspected.result.record.revision, resolutions: {} }), { code: 'STALE_FILE' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'external source');
});

test('an external BOM/CRLF-only save stays local and incoming logical text preserves that disk format', async t => {
  const { session, call, filename } = await fixture(t);
  let observer;
  const sent = [];
  await session.connectDocument('doc', { server: 'https://example.test', projectId: 'project', publicId: 'connection', connected: true,
    observeDocument(_id, handlers) { observer = handlers; return () => {}; },
    async joinDoc() { return { lines: base.split('\n'), version: 1, updates: [] }; },
    sendUpdate(update) { sent.push(update); return new Promise(() => {}); },
  });
  const physical = '\ufeff' + base.replaceAll('\n', '\r\n');
  await fs.writeFile(filename, physical);
  await call('scan');
  await session.transportIdle('doc');
  assert.equal(sent.length, 0);
  assert.equal((await call('snapshot')).result.remote.wire, base);
  await observer.applied({ doc: 'doc', v: 1, op: [{ p: base.length, i: '\nPEER' }] });
  await call('scan');
  assert.equal(await fs.readFile(filename, 'utf8'), physical + '\r\nPEER');
  assert.equal((await call('state')).state.conflict, null);
});
