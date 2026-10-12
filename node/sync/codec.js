'use strict';

const { validateText } = require('./merge');
const failure = (code, message) => Object.assign(new Error(message), { code });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function checkOptions(options) {
  if (!options || !['unix', 'dos'].includes(options.fileformat)
    || !['', 'utf-8'].includes(options.fileencoding) || options.binary !== false) {
    throw failure('UNSUPPORTED_TEXT', 'Automatic text conversion requires UTF-8, Unix or DOS lines, and a nonbinary buffer');
  }
  for (const name of ['endofline', 'fixendofline', 'bomb']) {
    if (typeof options[name] !== 'boolean') throw new TypeError(`Missing editor option: ${name}`);
  }
}

/** Decode using an explicit file format; never guess, normalize mixed line
 * endings, replace invalid bytes, or remove a BOM without recording it. */
function decodeText(text, options) {
  checkOptions(options);
  validateText(text, 'file text');
  const bomb = text.startsWith('\ufeff');
  const body = bomb ? text.slice(1) : text;
  const separator = options.fileformat === 'dos' ? '\r\n' : '\n';
  if (options.fileformat === 'dos' && /(?<!\r)\n/.test(body)) {
    throw failure('UNSUPPORTED_TEXT', 'Mixed DOS and Unix line endings need explicit reconciliation');
  }
  const endofline = body.endsWith(separator);
  const content = (endofline ? body.slice(0, -separator.length) : body).split(separator).join('\n');
  return { content, empty: body === '', options: { ...options, bomb, endofline } };
}

function decodeBytes(bytes, options) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('File bytes must be a Buffer');
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw failure('INVALID_TEXT', 'File contains invalid UTF-8');
  }
  return decodeText(text, options);
}

/** Buffer lines alone omit both the native empty-buffer flag and final EOL.
 * forWrite includes fixendofline; ordinary observations describe current text.
 * This predicts ordinary full writes, not custom BufWriteCmd/filter output. */
function editorText(view, { forWrite = false } = {}) {
  checkOptions(view?.options);
  validateText(view.content, 'editor content');
  if (typeof view.empty !== 'boolean' || (view.empty && view.content !== '')) {
    throw new TypeError('The native empty-buffer flag must be explicit and agree with its content');
  }
  const { fileformat, endofline, fixendofline, bomb } = view.options;
  const separator = fileformat === 'dos' ? '\r\n' : '\n';
  const body = view.empty ? '' : view.content.split('\n').join(separator)
    + (endofline || (forWrite && fixendofline) ? separator : '');
  return (bomb ? '\ufeff' : '') + body;
}

function encodeEditor(view, options) {
  return Buffer.from(editorText(view, options), 'utf8');
}

module.exports = { decodeText, decodeBytes, editorText, encodeEditor };
