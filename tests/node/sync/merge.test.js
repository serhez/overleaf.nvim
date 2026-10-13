'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { mergeText, createConflictWorkspace } = require('../../../node/sync/merge');

test('combines independent edits using their actual common ancestor', async () => {
  const result = await mergeText({
    base: 'Introduction\nunchanged\nConclusion\n',
    local: 'Local introduction\nunchanged\nConclusion\n',
    remote: 'Introduction\nunchanged\nRemote conclusion\n',
  });
  assert.deepEqual(result, {
    status: 'clean', content: 'Local introduction\nunchanged\nRemote conclusion\n',
  });
});

test('keeps all conflicting versions and a separately marked resolution candidate', async () => {
  const inputs = { base: 'Original\n', local: 'My edit\n', remote: 'Their edit\n' };
  const result = await mergeText(inputs);
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'overlap');
  assert.deepEqual(result.inputs, inputs);
  assert.equal(result.content, undefined, 'a conflict is not publishable content');
  assert.match(result.candidate, /<<<<<<< LOCAL\nMy edit\n/);
  assert.match(result.candidate, /\|\|\|\|\|\|\| BASE\nOriginal\n/);
  assert.match(result.candidate, /=======\nTheir edit\n>>>>>>> OVERLEAF/);
  assert.deepEqual(inputs, { base: 'Original\n', local: 'My edit\n', remote: 'Their edit\n' });
});

test('does not guess an ancestor when a preexisting local file differs from Overleaf', async () => {
  const inputs = { base: null, local: 'Offline work', remote: 'Remote work' };
  const result = await mergeText(inputs);
  assert.deepEqual(result, {
    status: 'conflict', reason: 'missing-base', inputs, candidate: null,
  });
});

test('identical and one-sided changes do not require the Git executable', async () => {
  const options = { gitPath: '/nonexistent-overleaf-test-git' };
  for (const [inputs, expected] of [
    [{ base: 'base', local: 'same', remote: 'same' }, 'same'],
    [{ base: null, local: 'same', remote: 'same' }, 'same'],
    [{ base: 'base', local: 'base', remote: 'remote' }, 'remote'],
    [{ base: 'base', local: 'local', remote: 'base' }, 'local'],
    [{ base: 'base', local: '', remote: 'base' }, ''],
  ]) {
    assert.deepEqual(await mergeText(inputs, options), { status: 'clean', content: expected });
  }
});

test('preserves non-BMP Unicode and the absence of a final newline', async () => {
  assert.deepEqual(await mergeText({
    base: '😀 original\nseparator\n日本語',
    local: '😀 local\nseparator\n日本語',
    remote: '😀 original\nseparator\n日本語 remote',
  }), { status: 'clean', content: '😀 local\nseparator\n日本語 remote' });
});

test('preserves CRLF for independent edits', async () => {
  assert.deepEqual(await mergeText({
    base: 'first\r\nseparator\r\nlast\r\n',
    local: 'local\r\nseparator\r\nlast\r\n',
    remote: 'first\r\nseparator\r\nremote\r\n',
  }), { status: 'clean', content: 'local\r\nseparator\r\nremote\r\n' });
});

test('treats conflicting deletion as a conflict rather than silently restoring or deleting', async () => {
  const result = await mergeText({ base: 'paragraph\n', local: '', remote: 'changed paragraph\n' });
  assert.equal(result.status, 'conflict');
  assert.equal(result.inputs.local, '');
  assert.equal(result.inputs.remote, 'changed paragraph\n');
});

test('different edits to one line may require manual resolution', async () => {
  const result = await mergeText({ base: 'one two three\n', local: 'ONE two three\n', remote: 'one two THREE\n' });
  assert.equal(result.status, 'conflict');
});

test('reports a missing Git executable instead of treating failure as a conflict or clean merge', async () => {
  await assert.rejects(
    mergeText({ base: 'base', local: 'local', remote: 'remote' }, { gitPath: '/nonexistent-overleaf-test-git' }),
    { code: 'ENOENT' },
  );
});

test('does not accept arbitrary process failure as a merge conflict', async () => {
  await assert.rejects(
    mergeText({ base: 'base', local: 'local', remote: 'remote' }, { gitPath: process.execPath }),
    /Git text merge failed/,
  );
});

test('rejects binary input and malformed Unicode even on an equality fast path', async () => {
  for (const content of ['a\0b', '\uD800', '\uDC00']) {
    await assert.rejects(mergeText({ base: content, local: content, remote: content }), /text|Unicode/);
  }
});

test('rejects absent branches instead of interpreting them as empty documents', async () => {
  for (const inputs of [
    { base: 'base', remote: 'remote' },
    { base: 'base', local: 'local' },
    { base: undefined, local: 'local', remote: 'remote' },
  ]) await assert.rejects(mergeText(inputs), /string|null/);
});

test('captures input snapshots before asynchronous work', async () => {
  const inputs = { base: 'base\n', local: 'local\n', remote: 'remote\n' };
  const pending = mergeText(inputs);
  inputs.local = 'a newer unsaved edit';
  const result = await pending;
  assert.equal(result.inputs.local, 'local\n');
  assert.doesNotMatch(result.candidate, /newer unsaved/);
});

test('independent documents do not share temporary merge files', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => mergeText({
    base: `a${i}\nseparator\nb${i}\n`,
    local: `local${i}\nseparator\nb${i}\n`,
    remote: `a${i}\nseparator\nremote${i}\n`,
  })));
  results.forEach((result, i) => {
    assert.deepEqual(result, { status: 'clean', content: `local${i}\nseparator\nremote${i}\n` });
  });
});

test('CodeDiff workspaces isolate all index stages, preserve the marked candidate, and create no commits', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-review-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const user = path.join(parent, 'user'); await fs.mkdir(user);
  await run('git', ['init', '--quiet', user]);
  await fs.writeFile(path.join(user, 'keep'), 'user work');
  await run('git', ['-C', user, 'add', 'keep']);
  const index = await fs.readFile(path.join(user, '.git', 'index'));
  const inputs = { base: 'base\n', local: 'local\n', remote: 'remote\n' };
  const candidate = (await mergeText(inputs)).candidate;
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(user, '.git'); process.env.GIT_WORK_TREE = user;
  let review;
  try { review = await createConflictWorkspace(inputs, candidate, { root: parent }); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.deepEqual(await fs.readFile(path.join(user, '.git', 'index')), index);
  for (const [stage, content] of [[1, inputs.base], [2, inputs.local], [3, inputs.remote]]) {
    assert.equal((await run('git', ['-C', review.directory, 'show', `:${stage}:result`])).stdout, content);
  }
  assert.equal(await fs.readFile(review.path, 'utf8'), candidate);
  assert.equal(await fs.readFile(review.candidate, 'utf8'), candidate);
  assert.equal((await run('git', ['-C', review.directory, 'remote'])).stdout, '');
  await assert.rejects(run('git', ['-C', review.directory, 'rev-parse', '--verify', 'HEAD']));
  assert.equal((await fs.stat(review.directory)).mode & 0o077, 0);
});

test('CodeDiff preparation refuses unknown ancestry and unbounded or malformed inputs', async () => {
  await assert.rejects(createConflictWorkspace({ base: null, local: 'local', remote: 'remote' }, ''), { code: 'NO_MERGE_BASE' });
  await assert.rejects(createConflictWorkspace({ base: 'base', local: 'bad\0text', remote: 'remote' }, ''), /Unicode|text/);
  await assert.rejects(createConflictWorkspace({ base: '', local: 'a'.repeat(16 * 1024 * 1024 + 1), remote: '' }, ''), { code: 'MERGE_LIMIT' });
});
