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

module.exports = { mergeText, validateText };
