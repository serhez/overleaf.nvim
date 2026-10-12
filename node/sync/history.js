'use strict';

const { mergeText, validateText } = require('./merge');
const { editorText, decodeText } = require('./codec');

// Full native history snapshots are bounded; exceeding this stages the incoming
// update rather than dropping history or allocating without a limit.
const MAX_NODES = 1000;
const MAX_BYTES = 16 * 1024 * 1024;

function captureHistory(history) {
  if (!Array.isArray(history?.nodes) || history.nodes.length === 0) {
    throw new TypeError('History must contain its root state');
  }
  if (history.nodes.length > MAX_NODES) {
    throw Object.assign(new Error('Undo history exceeds the automatic rebase limit'), { code: 'HISTORY_LIMIT' });
  }
  const nodes = history.nodes.map(node => ({
    seq: node.seq, parent: node.parent, content: node.content,
    ...(node.empty === undefined ? {} : { empty: node.empty }),
  }));
  nodes.sort((a, b) => a.seq - b.seq);
  const seen = new Set();
  let bytes = 0;
  for (const node of nodes) {
    validateText(node.content, 'history content');
    if (node.empty !== undefined && (typeof node.empty !== 'boolean' || (node.empty && node.content !== ''))) {
      throw new TypeError('Invalid native empty-buffer flag');
    }
    bytes += Buffer.byteLength(node.content);
    if (bytes > MAX_BYTES) {
      throw Object.assign(new Error('Undo history exceeds the automatic rebase limit'), { code: 'HISTORY_LIMIT' });
    }
    if (!Number.isSafeInteger(node.seq) || node.seq < 0 || seen.has(node.seq)
      || (node.seq === 0 ? node.parent !== null : !seen.has(node.parent))) {
      throw new TypeError('History must be a rooted tree of unique increasing sequence IDs');
    }
    seen.add(node.seq);
  }
  if (nodes[0].seq !== 0 || !seen.has(history.current) || !seen.has(history.preferred)) {
    throw new TypeError('History root, current state, or preferred branch is missing');
  }
  const parents = new Map(nodes.map(node => [node.seq, node.parent]));
  let selected = history.preferred;
  while (selected !== history.current && selected !== null) selected = parents.get(selected);
  if (selected === null) throw new TypeError('Preferred redo branch does not include the current state');
  return { current: history.current, preferred: history.preferred, nodes };
}

/** Rebase the complete native undo tree, including inactive branches. A conflict
 * holds the whole editor update; callers must never install a partial tree. */
async function rebaseHistory(history, content) {
  validateText(content, 'updated buffer content');
  const captured = captureHistory(history);
  const base = captured.nodes.find(node => node.seq === captured.current).content;
  const results = new Map();
  let bytes = 0;
  for (const node of captured.nodes) {
    let merged = results.get(node.content);
    if (!merged) {
      merged = await mergeText({ base, local: node.content, remote: content });
      results.set(node.content, merged);
    }
    if (merged.status === 'conflict') return { ...merged, seq: node.seq };
    bytes += Buffer.byteLength(merged.content);
    if (bytes > MAX_BYTES) {
      throw Object.assign(new Error('Rebased undo history exceeds the automatic rebase limit'), { code: 'HISTORY_LIMIT' });
    }
    if (node.empty !== undefined && merged.content !== node.content) node.empty = merged.content === '';
    node.content = merged.content;
  }
  return { status: 'clean', history: captured };
}

/** Native bytes are opaque to Node and are validated by Neovim before import.
 * Keep them with the text tree so a failed or interrupted install is recoverable. */
function captureEditorCheckpoint(checkpoint) {
  const history = captureHistory(checkpoint?.history);
  const { tree, options, undo } = checkpoint;
  if (!tree || tree.seq_cur !== history.current || !Number.isSafeInteger(tree.seq_last)
    || tree.seq_last < history.nodes.at(-1).seq) throw new TypeError('Invalid native undo metadata');
  if (!options || typeof options.endofline !== 'boolean' || typeof options.fixendofline !== 'boolean'
    || !['unix', 'dos', 'mac'].includes(options.fileformat) || typeof options.fileencoding !== 'string'
    || options.binary !== false || !Number.isSafeInteger(options.undolevels)) {
    throw new TypeError('Invalid editor text options');
  }
  for (const node of history.nodes) editorText({ ...node, options });
  if (history.nodes.length === 1 ? undo !== null
    : typeof undo !== 'string' || !undo.length || undo.length > 4 * Math.ceil(64 * 1024 * 1024 / 3)
      || Buffer.from(undo, 'base64').toString('base64') !== undo) {
    throw new TypeError('Invalid native undo recovery data');
  }
  return structuredClone({ history, tree, options, undo });
}

function currentText(checkpoint, options) {
  const node = checkpoint.history.nodes.find(node => node.seq === checkpoint.history.current);
  return editorText({ ...node, options: checkpoint.options }, options);
}

/** Merge exact file text, then return native joined lines under the existing
 * editor options. Native undo does not track option changes; hold any result
 * that cannot be represented without changing them. */
async function rebaseEditorHistory(checkpoint, content) {
  const { history, options } = captureEditorCheckpoint(checkpoint);
  const raw = {
    ...history,
    nodes: history.nodes.map(node => ({ seq: node.seq, parent: node.parent, content: editorText({ ...node, options }) })),
  };
  const result = await rebaseHistory(raw, content);
  if (result.status !== 'clean') return result;
  for (let index = 0; index < result.history.nodes.length; index++) {
    const node = result.history.nodes[index];
    const decoded = decodeText(node.content, options);
    // With noeol, a trailing separator is a native empty final line, not a
    // reason to change the user's endofline option during a history import.
    if (!options.endofline && decoded.options.endofline) decoded.content += '\n';
    const original = history.nodes[index];
    if (original.content === decoded.content && raw.nodes[index].content === node.content) decoded.empty = original.empty;
    if (editorText({ ...decoded, options }) !== node.content) {
      return { status: 'held', reason: 'text-options' };
    }
    node.content = decoded.content;
    node.empty = decoded.empty;
  }
  return result;
}

module.exports = { rebaseHistory, rebaseEditorHistory, captureEditorCheckpoint, currentText };
