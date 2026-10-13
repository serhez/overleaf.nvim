'use strict';

const text = require('../vendor/sharejs/text');
const { diffChars, diffLines } = require('diff');
const { validateText } = require('./merge');
const failure = (code, message) => Object.assign(new Error(message), { code });
const boundary = (value, offset) => !(offset > 0 && offset < value.length
  && /[\uD800-\uDBFF]/.test(value[offset - 1]) && /[\uDC00-\uDFFF]/.test(value[offset]));
const MAX_BYTES = 16 * 1024 * 1024;

function apply(snapshot, operation) {
  validateText(snapshot, 'OT snapshot');
  if (!Array.isArray(operation)) throw failure('INVALID_OP', 'Operation must be an array');
  if (operation.length > 4096) throw failure('OP_LIMIT', 'Operation has too many components');
  let result = snapshot;
  for (const component of operation) {
    const invalid = () => { throw failure('INVALID_OP', 'Operation does not match the text or supported UTF-16 coordinates'); };
    if (!component || typeof component !== 'object' || Array.isArray(component)) invalid();
    const kinds = ['i', 'd', 'c'].filter(key => Object.hasOwn(component, key));
    if (kinds.length !== 1) invalid();
    const kind = kinds[0], value = component[kind], p = component.p;
    if (typeof value !== 'string' || !Number.isSafeInteger(p) || p < 0 || p > result.length || !boundary(result, p)
      || Object.keys(component).some(key => ![kind, 'p', 'u', ...(kind === 'c' ? ['t'] : [])].includes(key))
      || (component.u !== undefined && typeof component.u !== 'boolean')
      || (kind === 'c' && (typeof component.t !== 'string' || !component.t.length))) invalid();
    try { validateText(value, 'operation text'); } catch { invalid(); }
    if (kind !== 'i' && (result.slice(p, p + value.length) !== value || !boundary(result, p + value.length))) invalid();
    result = text.apply(result, [component]);
    if (Buffer.byteLength(result) > MAX_BYTES) throw failure('OP_LIMIT', 'Operation exceeds the document limit');
  }
  return result;
}

/** The first operation wins coincident insert positions, matching Overleaf's
 * transform(submitted, prior, 'left'). Both inputs apply to the same snapshot. */
function transformPair(snapshot, left, right) {
  const afterLeft = apply(snapshot, left), afterRight = apply(snapshot, right);
  if (left.length * right.length > 1000000) throw failure('OP_LIMIT', 'Concurrent operations exceed the transform work limit');
  const pair = text.transformX(structuredClone(left), structuredClone(right));
  if (apply(afterRight, pair[0]) !== apply(afterLeft, pair[1])) {
    throw failure('OT_DIVERGENCE', 'Concurrent operations did not converge');
  }
  return pair;
}

/** Preserve unchanged spans so a colleague's edit between two saved changes
 * stays between them. Bound diff work rather than replacing the whole span. */
function diff(before, after) {
  validateText(before, 'original text');
  validateText(after, 'updated text');
  if (before === after) return [];
  const limit = () => { throw failure('OP_LIMIT', 'Saved changes exceed the bounded diff work limit'); };
  if (Buffer.byteLength(before) > MAX_BYTES || Buffer.byteLength(after) > MAX_BYTES) limit();
  const deadline = Date.now() + 100;
  const options = () => ({ maxEditLength: 4096, timeout: Math.max(1, deadline - Date.now()) });
  // Avoid constructing unbounded line-token arrays for very dense documents.
  let lines = 0;
  for (const value of [before, after]) for (let i = 0; i < value.length; i++) if (value[i] === '\n' && ++lines > 200000) limit();
  const chunks = diffLines(before, after, options());
  if (!chunks) limit();
  const result = [];
  let position = 0;
  const emit = chunk => {
    if (chunk.removed) result.push({ p: position, d: chunk.value });
    else {
      if (chunk.added) result.push({ p: position, i: chunk.value });
      position += chunk.value.length;
    }
    if (result.length > 4096) limit();
  };
  for (let index = 0; index < chunks.length;) {
    if (Date.now() > deadline) limit();
    if (!chunks[index].added && !chunks[index].removed) { emit(chunks[index++]); continue; }
    let removed = '', added = '';
    while (index < chunks.length && (chunks[index].added || chunks[index].removed)) {
      const chunk = chunks[index++];
      if (chunk.removed) removed += chunk.value; else added += chunk.value;
    }
    if (!removed) { emit({ added: true, value: added }); continue; }
    if (!added) { emit({ removed: true, value: removed }); continue; }
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(removed.length, added.length) && removed[prefix] === added[prefix]) prefix++;
    while (!boundary(removed, prefix) || !boundary(added, prefix)) prefix--;
    while (suffix < Math.min(removed.length, added.length) - prefix
      && removed[removed.length - suffix - 1] === added[added.length - suffix - 1]) suffix++;
    while (!boundary(removed, removed.length - suffix) || !boundary(added, added.length - suffix)) suffix--;
    position += prefix;
    const left = removed.slice(prefix, removed.length - suffix), right = added.slice(prefix, added.length - suffix);
    if (left.length + right.length > 262144) limit();
    const characters = diffChars(left, right, options());
    if (!characters) limit();
    for (const chunk of characters) emit(chunk);
    position += suffix;
  }
  if (apply(before, result) !== after) throw failure('INVALID_OP', 'Saved diff did not reproduce the requested content');
  return result;
}

function validateLegacyInsertions(operation) {
  // The supported server's UpdateManager._sanitizeUpdate replaces *all*
  // surrogate code units in inserts, including valid pairs. Refuse before
  // submission; changing already-present supplementary text elsewhere is fine.
  if (operation.some(component => /[\uD800-\uDFFF]/.test(component.i ?? ''))) {
    throw failure('UNSUPPORTED_INSERT', 'The legacy server cannot preserve supplementary Unicode in inserted text');
  }
}

/** Verify one unacknowledged submission against the complete server history
 * from its original version. Equal text without the connection source is not
 * evidence of application. Missing history remains an unknown outcome. */
function proveUpload(pending, snapshot, updates, queueDrained = false) {
  const invalid = () => { throw failure('UNPROVEN_UPLOAD', 'Operation history does not prove application of the pending save'); };
  const comments = operation => JSON.stringify(operation.filter(component => component.c !== undefined)
    .map(({ p, c, t, u }) => ({ p, c, t, u: u ?? false })));
  if (!pending.source || !Array.isArray(pending.operation) || !Array.isArray(updates)
    || updates.length > 4096 || snapshot.version - pending.version !== updates.length) invalid();
  let content = pending.base, operation = pending.operation, found = false;
  try {
    if (apply(content, operation) !== pending.content) invalid();
    for (let index = 0; index < updates.length; index++) {
      const update = updates[index];
      if (update?.v !== pending.version + index || !update.meta?.source) invalid();
      const next = apply(content, update.op);
      if (update.meta.source === pending.source) {
        if (found || next !== apply(content, operation) || comments(update.op) !== comments(operation)) invalid();
        found = true;
      } else if (!found) [operation] = transformPair(content, operation, update.op);
      content = next;
    }
    if (content !== snapshot.content || (!found && !(pending.queued && queueDrained))) invalid();
  } catch (error) {
    if (error.code === 'UNPROVEN_UPLOAD') throw error;
    invalid();
  }
  return found ? 'applied' : 'not-applied';
}

/** Input text uses joined native lines (LF); rows and UTF-8 byte columns are
 * zero-based. Reject a position inside a code point rather than rounding it. */
function utf16Position(snapshot, row, col) {
  validateText(snapshot, 'position text');
  const lines = snapshot.split('\n');
  if (!Number.isSafeInteger(row) || row < 0 || row >= lines.length || !Number.isSafeInteger(col) || col < 0) {
    throw failure('INVALID_POSITION', 'Position is outside the document');
  }
  const line = Buffer.from(lines[row]);
  const prefix = line.subarray(0, col).toString('utf8');
  if (col > line.length || !Buffer.from(prefix).equals(line.subarray(0, col))) {
    throw failure('INVALID_POSITION', 'Byte column is outside the line or inside a code point');
  }
  return lines.slice(0, row).reduce((sum, value) => sum + value.length + 1, 0) + prefix.length;
}

function bytePosition(snapshot, offset) {
  validateText(snapshot, 'position text');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.length || !boundary(snapshot, offset)) {
    throw failure('INVALID_POSITION', 'UTF-16 offset is outside the document or inside a code point');
  }
  const lines = snapshot.slice(0, offset).split('\n');
  return { row: lines.length - 1, col: Buffer.byteLength(lines.at(-1)) };
}

/** Comment IDs are thread IDs in the supported ranges-tracker contract. Keep
 * collapsed ranges: an empty selection still identifies an existing thread. */
function updateComments(snapshot, ranges, operation) {
  apply(snapshot, operation);
  const invalid = () => { throw failure('INVALID_RANGES', 'Comment ranges do not match the document snapshot'); };
  if (!Array.isArray(ranges) || ranges.length > 500) invalid();
  if (ranges.length * operation.length > 1000000) throw failure('OP_LIMIT', 'Comment transformation exceeds the work limit');
  const ids = new Set();
  let bytes = 0;
  let result = ranges.map(range => {
    const op = range?.op;
    if (!op || typeof range.id !== 'string' || !range.id || range.id !== op.t || ids.has(range.id)
      || typeof op.c !== 'string' || !Number.isSafeInteger(op.p) || op.p < 0 || op.p > snapshot.length
      || !boundary(snapshot, op.p) || !boundary(snapshot, op.p + op.c.length)
      || snapshot.slice(op.p, op.p + op.c.length) !== op.c) invalid();
    ids.add(range.id);
    bytes += Buffer.byteLength(op.c);
    if (bytes > MAX_BYTES) throw failure('OP_LIMIT', 'Comment ranges exceed the text limit');
    return { id: range.id, op: { p: op.p, c: op.c, t: op.t } };
  });
  let work = 0;
  for (const component of operation) {
    work += result.length;
    if (work > 1000000) throw failure('OP_LIMIT', 'Comment transformation exceeds the work limit');
    if (component.c !== undefined) {
      const range = { id: component.t, op: { p: component.p, c: component.c, t: component.t } };
      const index = result.findIndex(existing => existing.id === component.t);
      if (index < 0) result.push(range); else result[index] = range;
      if (result.length > 500) throw failure('OP_LIMIT', 'Too many comment ranges');
    } else {
      result = result.map(range => ({ id: range.id, op: text.transform([range.op], [component], 'left')[0] }));
    }
  }
  if (result.reduce((size, range) => size + Buffer.byteLength(range.op.c), 0) > MAX_BYTES) {
    throw failure('OP_LIMIT', 'Comment ranges exceed the text limit');
  }
  return result;
}

function mapCursor(snapshot, view, position) {
  const lines = snapshot.split('\n');
  const { row, column } = position;
  if (!Number.isSafeInteger(row) || row < 0 || row >= lines.length
    || !Number.isSafeInteger(column) || column < 0 || column > lines[row].length) {
    throw failure('INVALID_POSITION', 'Collaborator cursor is outside the saved snapshot');
  }
  const offset = lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + column;
  bytePosition(snapshot, offset);
  return bytePosition(view, text.transformCursor(offset, diff(snapshot, view), 'right'));
}

module.exports = { apply, transformPair, diff, proveUpload, validateLegacyInsertions, utf16Position, bytePosition, updateComments, mapCursor };
