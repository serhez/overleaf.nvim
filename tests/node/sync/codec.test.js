'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { decodeText, decodeBytes, editorText, encodeEditor } = require('../../../node/sync/codec');

const options = (changes = {}) => ({
  fileformat: 'unix', fileencoding: 'utf-8', binary: false,
  endofline: true, fixendofline: false, bomb: false, ...changes,
});
const view = (content, changes = {}, empty = false) => ({ content, empty, options: options(changes) });

test('round trips exact UTF-8 bytes without losing newlines, Unicode, or BOMs', () => {
  for (const fileformat of ['unix', 'dos']) {
    const eol = fileformat === 'dos' ? '\r\n' : '\n';
    for (const text of ['', eol, eol + eol, 'é😀', 'é😀' + eol, 'one' + eol + 'two', '\ufeff', '\ufeffone' + eol]) {
      const bytes = Buffer.from(text);
      const decoded = decodeBytes(bytes, options({ fileformat }));
      assert.equal(editorText(decoded), text);
      assert.deepEqual(encodeEditor(decoded), bytes);
      assert.deepEqual(decodeText(text, options({ fileformat })), decoded);
    }
  }
});

test('distinguishes an empty buffer from one blank line and does not invent a newline', () => {
  assert.equal(editorText(view('', {}, true)), '');
  assert.equal(editorText(view('')), '\n');
  assert.equal(editorText(view('', { endofline: false })), '');
  assert.equal(decodeText('', options()).empty, true);
  assert.equal(decodeText('\n', options()).empty, false);
  assert.equal(editorText(view('', { bomb: true }, true)), '\ufeff');
});

test('applies fixendofline only when explicitly describing a write', () => {
  const state = view('draft', { endofline: false, fixendofline: true });
  assert.equal(editorText(state), 'draft');
  assert.equal(editorText(state, { forWrite: true }), 'draft\n');
  assert.equal(editorText(view('', { fixendofline: true }, true), { forWrite: true }), '');
  assert.equal(editorText(view('', { endofline: false, fixendofline: true }), { forWrite: true }), '\n');
});

test('option-only changes alter bytes and all codec calls leave their input untouched', () => {
  const state = view('a\nb', { endofline: false });
  const before = structuredClone(state);
  assert.equal(editorText(state), 'a\nb');
  const dos = options({ fileformat: 'dos' });
  const decoded = decodeText('a\r\nb\r\n', dos);
  assert.equal(decoded.content, 'a\nb');
  assert.equal(editorText(decoded), 'a\r\nb\r\n');
  assert.deepEqual(dos, options({ fileformat: 'dos' }));
  assert.equal(editorText({ ...state, options: { ...state.options, bomb: true } }), '\ufeffa\nb');
  assert.equal(editorText({ ...state, options: { ...state.options, endofline: true } }), 'a\nb\n');
  assert.deepEqual(state, before);
});

test('rejects malformed UTF-8, NUL, unpaired surrogates, unsupported encoding and ambiguous DOS input', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
    assert.throws(() => decodeBytes(bytes, options()), { code: 'INVALID_TEXT' });
  }
  for (const text of ['a\0b', '\ud800', '\udfff']) assert.throws(() => decodeText(text, options()));
  for (const changes of [{ fileencoding: 'latin1' }, { binary: true }, { fileformat: 'mac' }]) {
    assert.throws(() => encodeEditor(view('text', changes)), { code: 'UNSUPPORTED_TEXT' });
  }
  assert.throws(() => decodeText('one\r\ntwo\n', options({ fileformat: 'dos' })), { code: 'UNSUPPORTED_TEXT' });
  assert.throws(() => editorText(view('not empty', {}, true)), /empty/i);
  // A CR in Unix text is literal, never silently stripped.
  assert.equal(editorText(decodeText('one\r\ntwo\n', options())), 'one\r\ntwo\n');
});

test('encoding agrees with real Neovim writes, including empty buffers and save-time options', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-codec-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cases = [];
  for (const fileformat of ['unix', 'dos']) {
    for (const endofline of [false, true]) {
      for (const fixendofline of [false, true]) {
        for (const bomb of [false, true]) {
          for (const [content, empty] of [['', true], ['', false], ['é😀\nlast', false], ['a\n', false]]) {
            cases.push(view(content, { fileformat, endofline, fixendofline, bomb }, empty));
          }
        }
      }
    }
  }
  await fs.writeFile(path.join(directory, 'cases.json'), JSON.stringify(cases));
  const script = `
local root = vim.env.OVERLEAF_CODEC_TEST
local cases = vim.json.decode(table.concat(vim.fn.readfile(root .. '/cases.json'), '\\n'))
local observed = {}
for i, case in ipairs(cases) do
  local buf = vim.api.nvim_create_buf(true, false)
  vim.api.nvim_set_current_buf(buf)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, case.empty and {} or vim.split(case.content, '\\n', {plain=true}))
  for key, value in pairs(case.options) do vim.bo[buf][key] = value end
  observed[i] = {empty = vim.fn.wordcount().chars == 0}
  vim.cmd('silent noautocmd write ' .. vim.fn.fnameescape(root .. '/' .. i))
  vim.api.nvim_buf_delete(buf, {force=true})
end
vim.fn.writefile({vim.json.encode(observed)}, root .. '/observed.json')
vim.cmd('qa!')
`;
  const scriptPath = path.join(directory, 'writes.lua');
  await fs.writeFile(scriptPath, script);
  await promisify(execFile)('nvim', ['--headless', '-u', 'NONE', '-i', 'NONE', '-l', scriptPath], {
    env: { ...process.env, OVERLEAF_CODEC_TEST: directory }, timeout: 30000,
  });
  const observed = JSON.parse(await fs.readFile(path.join(directory, 'observed.json'), 'utf8'));
  for (const [index, state] of cases.entries()) {
    assert.equal(observed[index].empty, state.empty, JSON.stringify(state));
    assert.deepEqual(encodeEditor(state, { forWrite: true }), await fs.readFile(path.join(directory, String(index + 1))), JSON.stringify(state));
  }
});
