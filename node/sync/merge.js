'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function validateText(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError(`${name} must be Unicode text without NUL bytes`);
  }
}

/**
 * Reconcile immutable text snapshots. Only a clean result has publishable
 * `content`; conflicts retain the inputs and a separate resolution candidate.
 * A null base means unknown ancestry, not an empty original document.
 */
async function mergeText({ base, local, remote }, { gitPath = 'git' } = {}) {
  if (base !== null) validateText(base, 'base (string or null)');
  validateText(local, 'local');
  validateText(remote, 'remote');

  if (local === remote) return { status: 'clean', content: local };
  const inputs = { base, local, remote };
  if (base === null) {
    return { status: 'conflict', reason: 'missing-base', inputs, candidate: null };
  }
  if (local === base) return { status: 'clean', content: remote };
  if (remote === base) return { status: 'clean', content: local };

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-merge-'));
  try {
    await Promise.all(Object.entries(inputs).map(([name, text]) =>
      fs.writeFile(path.join(directory, name), text, { flag: 'wx', mode: 0o600 })));

    // File merging must not inherit a user's repository or Git configuration.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = os.devNull;
    const inputBytes = Object.values(inputs).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    const { stdout, conflicts } = await new Promise((resolve, reject) => {
      execFile(gitPath, [
        'merge-file', '--stdout', '--diff3',
        '-L', 'LOCAL', '-L', 'BASE', '-L', 'OVERLEAF',
        'local', 'base', 'remote',
      ], {
        cwd: directory, env, encoding: 'utf8', timeout: 10000,
        // Conflict labels can substantially expand many small conflicting lines.
        maxBuffer: 128 * inputBytes + 65536,
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, conflicts: false });
        // Git returns a conflict count (capped at 127); errors are not candidates.
        if (!error.killed && Number.isInteger(error.code) && error.code > 0 && error.code <= 127
          && /^<<<<<<< LOCAL\r?$/m.test(stdout) && /^\|{7} BASE\r?$/m.test(stdout)
          && /^>>>>>>> OVERLEAF\r?$/m.test(stdout)) {
          return resolve({ stdout, conflicts: true });
        }
        error.message = `Git text merge failed: ${stderr.trim() || error.message}`;
        reject(error);
      });
    });

    if (conflicts) return { status: 'conflict', reason: 'overlap', inputs, candidate: stdout };
    return { status: 'clean', content: stdout };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** A disposable repository for an external merge UI. All Git state is private;
 * original conflict output is retained separately because UIs may replace it. */
async function createConflictWorkspace(inputs, candidate, { root = os.tmpdir(), gitPath = 'git' } = {}) {
  if (inputs.base === null) throw Object.assign(new Error('Use the native review when ancestry is unknown'), { code: 'NO_MERGE_BASE' });
  for (const [name, value] of Object.entries({ base: inputs.base, local: inputs.local, remote: inputs.remote, candidate })) {
    validateText(value, name);
    if (Buffer.byteLength(value) > 16 * 1024 * 1024) throw Object.assign(new Error('Merge view exceeds the text limit'), { code: 'MERGE_LIMIT' });
  }
  const directory = await fs.mkdtemp(path.join(root, 'overleaf-merge-view-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = os.devNull;
  const git = (args, input) => new Promise((resolve, reject) => {
    const child = execFile(gitPath, args, { cwd: directory, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  try {
    await git(['init', '--quiet', '--template=']);
    const records = [];
    for (const [index, name] of ['base', 'local', 'remote'].entries()) {
      const hash = await git(['hash-object', '-w', '--stdin'], inputs[name]);
      if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Invalid Git object identity');
      records.push(`100644 ${hash} ${index + 1}\tresult\n`);
    }
    await git(['update-index', '--index-info'], records.join(''));
    const filename = path.join(directory, 'result'), original = path.join(directory, 'candidate');
    await fs.writeFile(filename, candidate, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(original, candidate, { flag: 'wx', mode: 0o600 });
    return { directory, path: filename, candidate: original };
  } catch (error) {
    // A failed preparation has never been handed to an editor or user.
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { mergeText, validateText, createConflictWorkspace };
