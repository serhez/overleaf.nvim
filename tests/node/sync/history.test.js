'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { rebaseHistory } = require('../../../node/sync/history');

const base = 'intro\nseparator\nending';
const edited = 'MY intro\nseparator\nending';
const incoming = 'MY intro\nseparator\nTHEIR ending';
const history = () => ({
  current: 1, preferred: 1,
  nodes: [{ seq: 0, parent: null, content: base }, { seq: 1, parent: 0, content: edited }],
});

test('rebases the current text and every undo state without adding an incoming undo entry', async () => {
  const original = history();
  const result = await rebaseHistory(original, incoming);
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.history, {
    current: 1, preferred: 1,
    nodes: [
      { seq: 0, parent: null, content: 'intro\nseparator\nTHEIR ending' },
      { seq: 1, parent: 0, content: incoming },
    ],
  });
  assert.deepEqual(original, history());
});

test('preserves redo and alternate branches when rebasing from an undone state', async () => {
  const original = history();
  original.nodes.push(
    { seq: 2, parent: 1, content: 'MY second intro\nseparator\nending' },
    { seq: 3, parent: 1, content: 'MY alternate intro\nseparator\nending' },
  );
  original.preferred = 2;
  const result = await rebaseHistory(original, incoming);
  assert.equal(result.status, 'clean');
  assert.equal(result.history.current, 1);
  assert.equal(result.history.preferred, 2);
  assert.equal(result.history.nodes[2].content, 'MY second intro\nseparator\nTHEIR ending');
  assert.equal(result.history.nodes[3].content, 'MY alternate intro\nseparator\nTHEIR ending');
  assert.deepEqual(result.history.nodes.map(n => [n.seq, n.parent]), [[0, null], [1, 0], [2, 1], [3, 1]]);
});

test('an overlapping historical state holds the entire update and preserves the original history', async () => {
  const original = history();
  const before = structuredClone(original);
  const result = await rebaseHistory(original, 'MY intro expanded by colleague\nseparator\nending');
  assert.equal(result.status, 'conflict');
  assert.equal(result.seq, 0);
  assert.equal(result.inputs.base, edited);
  assert.equal(result.inputs.local, base);
  assert.equal(result.history, undefined, 'a partially rebased tree must never be installable');
  assert.deepEqual(original, before);
});

test('a conflict on an inactive branch also holds the update', async () => {
  const original = history();
  original.nodes.push({ seq: 2, parent: 0, content: 'intro\nseparator\nALTERNATE ending' });
  const result = await rebaseHistory(original, incoming);
  assert.equal(result.status, 'conflict');
  assert.equal(result.seq, 2);
});

test('identical independent text remains undoable once through the same local entry', async () => {
  const original = history();
  const result = await rebaseHistory(original, edited);
  assert.deepEqual(result.history, original);
  assert.notEqual(result.history, original);
  result.history.nodes[0].content = 'mutated result';
  assert.equal(original.nodes[0].content, base);
});

test('already reverted text retains a no-op undo and redo entry', async () => {
  const result = await rebaseHistory(history(), base);
  assert.equal(result.history.nodes.length, 2);
  assert.deepEqual(result.history.nodes.map(n => n.content), [base, base]);
});

test('a buffer with no undo history adopts incoming text without creating undo', async () => {
  const result = await rebaseHistory({ current: 0, preferred: 0, nodes: [{ seq: 0, parent: null, content: '' }] }, '😀\n');
  assert.deepEqual(result.history.nodes, [{ seq: 0, parent: null, content: '😀\n' }]);
});

test('preserves nonconsecutive native sequence IDs after history pruning', async () => {
  const original = history();
  original.nodes[1].seq = original.current = original.preferred = 37;
  const result = await rebaseHistory(original, incoming);
  assert.equal(result.history.nodes[1].seq, 37);
  assert.equal(result.history.current, 37);
});

test('captures submitted history before asynchronous merge work', async () => {
  const original = history();
  const pending = rebaseHistory(original, incoming);
  original.nodes[0].content = 'MUTATED';
  original.current = 0;
  const result = await pending;
  assert.equal(result.history.current, 1);
  assert.equal(result.history.nodes[0].content, 'intro\nseparator\nTHEIR ending');
});

test('rejects incomplete, cyclic, duplicate, and invalid history before producing an update', async () => {
  for (const change of [
    h => { h.current = 100; },
    h => { h.preferred = 100; },
    h => { h.nodes[1].parent = 1; },
    h => { h.nodes[1].parent = 100; },
    h => { h.nodes[1].seq = 0; },
    h => { h.nodes[0].parent = 1; },
    h => { h.nodes[1].content = '\uD800'; },
    h => { h.nodes[1].content = 'binary\0'; },
  ]) {
    const malformed = history();
    change(malformed);
    await assert.rejects(rebaseHistory(malformed, incoming));
  }
});

test('holds oversized histories and oversized rebased results rather than dropping undo states', async () => {
  const tooMany = { current: 0, preferred: 0, nodes: [] };
  for (let seq = 0; seq <= 1000; seq++) tooMany.nodes.push({ seq, parent: seq ? seq - 1 : null, content: '' });
  await assert.rejects(rebaseHistory(tooMany, ''), { code: 'HISTORY_LIMIT' });
  const large = 'x'.repeat(9 * 1024 * 1024);
  const small = { current: 1, preferred: 1, nodes: [
    { seq: 0, parent: null, content: '' }, { seq: 1, parent: 0, content: '' },
  ] };
  await assert.rejects(rebaseHistory(small, large), { code: 'HISTORY_LIMIT' });
  assert.deepEqual(small.nodes.map(node => node.content), ['', '']);
});
