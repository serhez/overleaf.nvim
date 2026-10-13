'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { apply, transformPair, diff, utf16Position, bytePosition, proveUpload, updateComments, mapCursor } = require('../../../node/sync/ot');

function converge(base, left, right) {
  const [leftPrime, rightPrime] = transformPair(base, left, right);
  const a = apply(apply(base, right), leftPrime);
  const b = apply(apply(base, left), rightPrime);
  assert.equal(a, b, JSON.stringify({ base, left, right, leftPrime, rightPrime }));
  return a;
}

test('concurrent deletion across an insertion converges without leaving deleted characters', () => {
  assert.equal(converge('abc', [{ p: 0, d: 'abc' }], [{ p: 1, i: 'X' }]), 'X');
});

test('compound edits converge in both orderings with UTF-16 positions and non-BMP text', () => {
  const base = 'a😀bc日本';
  const left = [{ p: 1, d: '😀b' }, { p: 2, i: '🌎' }];
  const right = [{ p: 3, i: 'X' }, { p: 0, d: 'a' }, { p: 6, i: '語' }];
  assert.equal(converge(base, left, right), 'Xc🌎日語本');
  assert.equal(converge(base, right, left), 'Xc🌎日語本');
});

test('all single insert/delete pairs on a short document converge, including empty results', () => {
  const base = 'abcd';
  const edits = [[]];
  for (let p = 0; p <= base.length; p++) {
    edits.push([{ p, i: 'XY' }]);
    for (let end = p + 1; end <= base.length; end++) edits.push([{ p, d: base.slice(p, end) }]);
  }
  for (const left of edits) for (const right of edits) converge(base, left, right);
});

test('deterministic compound operation sequences converge without mutating inputs', () => {
  let seed = 12345;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const edit = base => {
    let text = base;
    const op = [];
    for (let n = 0; n < 4; n++) {
      const p = random(text.length + 1);
      const component = p < text.length && random(2) ? { p, d: text.slice(p, p + 1 + random(text.length - p)) } : { p, i: String.fromCharCode(65 + random(26)) };
      op.push(component);
      text = apply(text, [component]);
    }
    return op;
  };
  for (let n = 0; n < 400; n++) {
    const base = 'abcdefgh';
    const left = edit(base), right = edit(base);
    const before = structuredClone({ left, right });
    converge(base, left, right);
    assert.deepEqual({ left, right }, before);
  }
});

test('diff produces valid Unicode operations and preserves exact intended text', () => {
  const strings = ['', 'abc', 'a😀b', 'a😁b', 'é日本\n', '\ufeffa\r\n', '😀🌎'];
  for (const before of strings) for (const after of strings) {
    const op = diff(before, after);
    assert.equal(apply(before, op), after);
    if (before === after) assert.deepEqual(op, []);
  }
});

test('rejects invalid bounds, malformed Unicode, mismatched deletes and unsupported components', () => {
  for (const op of [
    [{ p: -1, i: 'x' }], [{ p: 100, i: 'x' }], [{ p: 0.5, i: 'x' }],
    [{ p: 2, i: 'x' }], [{ p: 1, d: '\ud83d' }], [{ p: 0, d: 'wrong' }],
    [{ p: 0, i: '\ud800' }], [{ p: 0, i: 'x', d: 'a' }],
    [{ p: 0, i: 'x', unsupported: true }], [{ p: 0 }],
    [{ p: 0, c: 'wrong', t: 'thread' }], [{ p: 0, c: 'a' }],
  ]) assert.throws(() => apply('a😀b', op), { code: 'INVALID_OP' });
  assert.throws(() => apply('a\ud800', []), /Unicode/);
  assert.throws(() => transformPair('abc', [{ p: 0, d: 'wrong' }], []), { code: 'INVALID_OP' });
});

test('comment operations preserve text and transform their checked range over edits', () => {
  const base = 'abc';
  const comment = [{ p: 0, c: 'abc', t: 'thread' }];
  assert.equal(apply(base, comment), base);
  const [moved, insertion] = transformPair(base, comment, [{ p: 1, i: 'X' }]);
  assert.equal(apply('aXbc', moved), 'aXbc');
  assert.equal(apply(base, insertion), 'aXbc');
  assert.equal(moved[0].t, 'thread');
  assert.equal(moved[0].c, 'aXbc');
});

test('translates Neovim byte columns and UTF-16 offsets with strict boundary validation', () => {
  const text = 'é😀\n日x';
  for (const [row, col, offset] of [[0, 0, 0], [0, 2, 1], [0, 6, 3], [1, 0, 4], [1, 3, 5], [1, 4, 6]]) {
    assert.equal(utf16Position(text, row, col), offset);
    assert.deepEqual(bytePosition(text, offset), { row, col });
  }
  for (const [row, col] of [[0, 1], [0, 3], [1, 1], [-1, 0], [2, 0], [0, 7]]) {
    assert.throws(() => utf16Position(text, row, col), { code: 'INVALID_POSITION' });
  }
  for (const offset of [-1, 2, 7, 1.5]) assert.throws(() => bytePosition(text, offset), { code: 'INVALID_POSITION' });
});

test('saved operations keep unchanged spans in place when edits occur on both sides of a colleague insert', () => {
  const before = 'abcde', saved = 'AbcdE';
  const operation = diff(before, saved);
  const peer = [{ p: 2, i: 'x' }];
  const [transformed] = transformPair(before, operation, peer);
  assert.equal(apply(apply(before, peer), transformed), 'AbxcdE');
});

test('saved diffs do not delete and reinsert unchanged supplementary Unicode between distant edits', () => {
  const before = 'before\n😀 unchanged\nending';
  const after = 'BEFORE\n😀 unchanged\nENDING';
  const operation = diff(before, after);
  assert.equal(apply(before, operation), after);
  assert.equal(operation.some(component => /[\uD800-\uDFFF]/.test(component.i ?? component.d)), false);
});

test('upload proof checks comment identity and location even when the resulting text is unchanged', () => {
  const base = 'abc abc';
  const pending = { source: 'connection', version: 7, base, content: base,
    operation: [{ p: 0, c: 'abc', t: 'thread' }] };
  const snapshot = { content: base, version: 8 };
  const history = op => [{ v: 7, op, meta: { source: 'connection' } }];
  assert.equal(proveUpload(pending, snapshot, history(pending.operation)), 'applied');
  for (const op of [[], [{ p: 4, c: 'abc', t: 'thread' }], [{ p: 0, c: 'abc', t: 'other' }],
    [{ p: 0, c: 'ab', t: 'thread' }]]) {
    assert.throws(() => proveUpload(pending, snapshot, history(op)), { code: 'UNPROVEN_UPLOAD' });
  }
  assert.equal(proveUpload(pending, { content: 'Xabc abc', version: 9 }, [
    { v: 7, op: [{ p: 0, i: 'X' }], meta: { source: 'peer' } },
    { v: 8, op: [{ p: 1, c: 'abc', t: 'thread' }], meta: { source: 'connection' } },
  ]), 'applied');
});

test('comment ranges follow compound text edits and replacements with UTF-16 positions', () => {
  const snapshot = 'é😀 abc end';
  const ranges = [{ id: 'thread', op: { p: 4, c: 'abc', t: 'thread' } }];
  const operation = [{ p: 0, i: 'prefix ' }, { p: 12, i: 'X' }, { p: 11, d: 'aX' }];
  const before = structuredClone(ranges);
  const moved = updateComments(snapshot, ranges, operation);
  assert.deepEqual(moved, [{ id: 'thread', op: { p: 11, c: 'bc', t: 'thread' } }]);
  assert.deepEqual(ranges, before);
  const changed = updateComments('abc', [{ id: 'thread', op: { p: 0, c: 'a', t: 'thread' } }], [
    { p: 1, c: 'bc', t: 'thread' }, { p: 1, i: 'X' },
  ]);
  assert.deepEqual(changed, [{ id: 'thread', op: { p: 2, c: 'bc', t: 'thread' } }]);
  assert.deepEqual(updateComments('abc', changed.map(range => ({ ...range, op: { p: 0, c: 'abc', t: 'thread' } })), [
    { p: 0, d: 'abc' },
  ]), [{ id: 'thread', op: { p: 0, c: '', t: 'thread' } }]);
});

test('comment range updates reject invalid ranges and do not mutate prior metadata on failure', () => {
  for (const ranges of [[{ id: 't', op: { p: 0, c: 'wrong', t: 't' } }],
    [{ id: 't', op: { p: 2, c: '', t: 't' } }],
    [{ id: 't', op: { p: 0, c: 'a', t: 't' } }, { id: 't', op: { p: 0, c: 'a', t: 't' } }]]) {
    assert.throws(() => updateComments('a😀b', ranges, []), { code: 'INVALID_RANGES' });
  }
  const ranges = [{ id: 't', op: { p: 0, c: 'abc', t: 't' } }];
  assert.throws(() => updateComments('abc', ranges, [{ p: 0, d: 'wrong' }]), { code: 'INVALID_OP' });
  assert.deepEqual(ranges, [{ id: 't', op: { p: 0, c: 'abc', t: 't' } }]);
});

test('cursor projection maps saved UTF-16 coordinates into dirty native byte positions', () => {
  const wire = 'é😀\n日本';
  const view = 'local\né😀\n日X本';
  assert.deepEqual(mapCursor(wire, view, { row: 0, column: 3 }), { row: 1, col: 6 });
  assert.deepEqual(mapCursor(wire, view, { row: 1, column: 1 }), { row: 2, col: 4 });
  assert.throws(() => mapCursor(wire, view, { row: 0, column: 2 }), { code: 'INVALID_POSITION' });
  assert.throws(() => mapCursor(wire, view, { row: 3, column: 0 }), { code: 'INVALID_POSITION' });
});
