'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

/**
 * Extract the Overleaf session cookie from Chromium-based browsers on macOS.
 * These browsers (Chrome, Arc, ...) all encrypt cookies with AES-128-CBC using
 * a key derived from a Keychain password via PBKDF2. The scheme is identical
 * across them; only the data directory and Keychain entry differ, so each one
 * is just an entry in the registry below.
 */

const HOME = os.homedir();

const BROWSERS = {
  chrome: {
    name: 'Chrome',
    baseDir: path.join(HOME, 'Library/Application Support/Google/Chrome'),
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  arc: {
    name: 'Arc',
    baseDir: path.join(HOME, 'Library/Application Support/Arc/User Data'),
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc',
  },
};

function getBrowser(id) {
  const browser = BROWSERS[id];
  if (!browser) {
    throw { code: 'UNSUPPORTED', message: `Unknown browser: ${id}` };
  }
  return browser;
}

/**
 * Locate a profile's Cookies SQLite DB. Newer Chromium stores it under a
 * `Network/` subdirectory; older versions keep it in the profile root.
 */
function findCookiesDb(profilePath) {
  const candidates = [
    path.join(profilePath, 'Network', 'Cookies'),
    path.join(profilePath, 'Cookies'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * List profiles for a single browser. Returns [] if the browser is not present.
 * Each entry is tagged with the browser id/name so callers can route extraction
 * back to the right browser.
 */
function listBrowserProfiles(id) {
  const browser = getBrowser(id);
  if (!fs.existsSync(browser.baseDir)) return [];

  const profiles = [];
  const entries = fs.readdirSync(browser.baseDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Chromium profiles are 'Default', 'Profile 1', 'Profile 2', etc.
    if (entry.name !== 'Default' && !entry.name.startsWith('Profile ')) continue;

    const profilePath = path.join(browser.baseDir, entry.name);
    if (!findCookiesDb(profilePath)) continue;

    let displayName = entry.name;
    let email = '';
    try {
      const prefsPath = path.join(profilePath, 'Preferences');
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
        // Try to get email from account_info
        if (prefs.account_info && Array.isArray(prefs.account_info) && prefs.account_info[0]) {
          email = prefs.account_info[0].email || '';
        }
        if (prefs.profile && prefs.profile.name) {
          displayName = email || prefs.profile.name;
        }
      }
    } catch (e) {
      // Use directory name as fallback
    }

    profiles.push({ browser: id, browserName: browser.name, dir: entry.name, name: displayName, email });
  }

  return profiles;
}

/**
 * List profiles across every supported browser that is installed.
 * A browser that is absent or fails to enumerate is silently skipped.
 */
function listProfiles() {
  if (os.platform() !== 'darwin') {
    throw { code: 'UNSUPPORTED', message: 'Browser cookie extraction only supported on macOS' };
  }

  const profiles = [];
  for (const id of Object.keys(BROWSERS)) {
    try {
      profiles.push(...listBrowserProfiles(id));
    } catch (e) {
      // Skip a browser that fails to enumerate.
    }
  }
  return profiles;
}

function getEncryptionKey(browser) {
  const password = execSync(
    `security find-generic-password -w -s "${browser.keychainService}" -a "${browser.keychainAccount}"`,
    { encoding: 'utf-8' }
  ).trim();

  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookieValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) {
    return '';
  }

  const prefix = encryptedValue.slice(0, 3).toString('utf-8');
  if (prefix !== 'v10') {
    return encryptedValue.toString('utf-8');
  }

  const encrypted = encryptedValue.slice(3);
  const iv = Buffer.alloc(16, ' ');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  const raw = decrypted.toString('utf-8');

  // Chromium's CBC decryption may produce garbage in the first block
  // due to IV mismatch on newer versions. Overleaf session cookies
  // always contain 's%3A' (URL-encoded 's:' Express session prefix).
  const idx = raw.indexOf('s%3A');
  if (idx >= 0) {
    return raw.substring(idx);
  }

  return raw;
}

/**
 * Extract the Overleaf cookie from a specific browser profile.
 * @param {string} browserId - Browser id from the registry (e.g. 'chrome', 'arc')
 * @param {string} profileDir - Profile directory name (e.g. 'Default', 'Profile 1')
 */
async function getOverleafCookie(browserId, profileDir) {
  browserId = browserId || 'chrome';
  profileDir = profileDir || 'Default';

  if (os.platform() !== 'darwin') {
    throw { code: 'UNSUPPORTED', message: 'Browser cookie extraction only supported on macOS' };
  }

  const browser = getBrowser(browserId);
  const profilePath = path.join(browser.baseDir, profileDir);
  const cookiesDb = findCookiesDb(profilePath);
  if (!cookiesDb) {
    throw { code: 'NOT_FOUND', message: `${browser.name} Cookies database not found for profile: ${profileDir}` };
  }

  const key = getEncryptionKey(browser);

  const tmpDb = path.join(os.tmpdir(), `overleaf_${browserId}_cookies_${process.pid}.db`);
  fs.copyFileSync(cookiesDb, tmpDb);

  try {
    // Extract domain from OVERLEAF_URL for self-hosted instances
    let cookieDomain = 'overleaf.com';
    if (process.env.OVERLEAF_URL) {
      try {
        const parsedUrl = new URL(process.env.OVERLEAF_URL);
        cookieDomain = parsedUrl.hostname;
      } catch (e) { /* keep default */ }
    }
    const query = `SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%${cookieDomain}' AND name = 'overleaf_session2' ORDER BY expires_utc DESC LIMIT 1;`;
    const result = execSync(
      `sqlite3 "${tmpDb}" "${query}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (!result) {
      throw { code: 'NO_COOKIE', message: `No overleaf_session2 cookie found in ${browser.name}. Log in to overleaf.com in ${browser.name} first.` };
    }

    const [name, hexValue] = result.split('|');
    if (!hexValue) {
      throw { code: 'NO_COOKIE', message: 'Cookie value is empty' };
    }

    const encryptedValue = Buffer.from(hexValue, 'hex');
    const value = decryptCookieValue(encryptedValue, key);

    if (!value || !value.startsWith('s%3A')) {
      throw { code: 'DECRYPT_FAILED', message: 'Failed to decrypt cookie. Try setting cookie manually.' };
    }

    return `${name}=${value}`;
  } finally {
    try { fs.unlinkSync(tmpDb); } catch (e) { /* ignore */ }
  }
}

module.exports = { getOverleafCookie, listProfiles };
