'use strict';

const https = require('https');
const http = require('http');
const cheerio = require('cheerio');

const BASE_URL = process.env.OVERLEAF_URL || 'https://www.overleaf.com';

const RESPONSE_LIMIT = 16 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });

function httpRequest(url, cookie, { method = 'GET', timeout = 15000, csrfToken, body, contentType, extraHeaders, signal } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = {
      Cookie: cookie,
      'User-Agent': 'overleaf-neovim/0.1',
      Accept: method === 'GET' ? 'text/html,application/xhtml+xml' : 'application/json',
      ...extraHeaders,
    };
    if (csrfToken !== undefined) headers['X-Csrf-Token'] = csrfToken;
    if (body !== undefined) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    let timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { req.destroy(); reject(error); }
      else resolve(result);
    };
    const interrupted = () => finish(failure('RESPONSE_INTERRUPTED', 'HTTP response was interrupted'));
    const req = (parsed.protocol === 'http:' ? http : https).request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      signal,
    }, res => {
      res.once('error', interrupted);
      res.once('close', () => { if (!res.complete) interrupted(); });
      if (Number(res.headers['content-length']) > RESPONSE_LIMIT) {
        finish(failure('RESPONSE_TOO_LARGE', 'HTTP response exceeds 16 MiB'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) finish(failure('RESPONSE_TOO_LARGE', 'HTTP response exceeds 16 MiB'));
        else chunks.push(chunk);
      });
      res.once('end', () => {
        if (!res.complete) { interrupted(); return; }
        if (!settled) finish(null, { status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks, bytes).toString('utf8') });
      });
    });
    req.once('error', error => finish(error));
    // Bound the entire response, including peers that continuously trickle data.
    timer = setTimeout(() => finish(failure('REQUEST_TIMEOUT', 'HTTP request timed out')), timeout);
    req.end(body);
  });
}

function httpGet(url, cookie, options) {
  return httpRequest(url, cookie, { extraHeaders: options?.headers, signal: options?.signal });
}

async function fetchProjectPage(cookie) {
  const res = await httpGet(BASE_URL + '/project', cookie);

  if (res.status === 302) {
    throw { code: 'AUTH_FAILED', message: 'Cookie expired or invalid (redirected to login)' };
  }

  if (res.status !== 200) {
    throw { code: 'AUTH_FAILED', message: `Unexpected status: ${res.status}` };
  }

  const $ = cheerio.load(res.body);

  const csrfToken = $('meta[name="ol-csrfToken"]').attr('content');
  const userId = $('meta[name="ol-user_id"]').attr('content');
  const userEmail = $('meta[name="ol-usersEmail"]').attr('content') || '';

  if (!csrfToken || !userId) {
    throw { code: 'PARSE_ERROR', message: 'Failed to extract CSRF token or user ID from /project page' };
  }

  // Extract project list from prefetched blob
  let projects = [];
  const prefetchedBlob = $('meta[name="ol-prefetchedProjectsBlob"]').attr('content');
  if (prefetchedBlob) {
    try {
      const parsed = JSON.parse(prefetchedBlob);
      projects = (parsed.projects || parsed || []).map((p) => ({
        id: p._id || p.id,
        name: p.name,
        lastUpdated: p.lastUpdated,
        accessLevel: p.accessLevel || p.privileges || 'unknown',
        owner: p.owner_ref || p.owner || null,
      }));
    } catch (e) {
      console.log('Failed to parse prefetchedProjectsBlob:', e.message);
    }
  }

  // Fallback: try ol-projects meta tag
  if (projects.length === 0) {
    const projectsMeta = $('meta[name="ol-projects"]').attr('content');
    if (projectsMeta) {
      try {
        const parsed = JSON.parse(projectsMeta);
        projects = parsed.map((p) => ({
          id: p._id || p.id,
          name: p.name,
          lastUpdated: p.lastUpdated,
          accessLevel: p.accessLevel || 'unknown',
          owner: p.owner_ref || null,
        }));
      } catch (e) {
        console.log('Failed to parse ol-projects:', e.message);
      }
    }
  }

  return { csrfToken, userId, userEmail, projects };
}

/**
 * Fetch /socket.io/socket.io.js to get GCLB (load balancer) cookie.
 * This is required for session stickiness during Socket.IO handshake.
 * Returns the updated cookie string with GCLB appended.
 */
async function updateCookies(cookie) {
  const res = await httpGet(BASE_URL + '/socket.io/socket.io.js', cookie);

  // Extract set-cookie header
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) {
      const name_value = c.split(';')[0].trim();
      if (name_value) {
        cookie = cookie + '; ' + name_value;
      }
    }
  }

  return cookie;
}

async function httpPost(url, cookie, csrfToken, body) {
  return httpRequest(url, cookie, { method: 'POST', timeout: 30000, csrfToken,
    body: JSON.stringify(body), contentType: 'application/json' });
}

function httpDelete(url, cookie, csrfToken) {
  return httpRequest(url, cookie, { method: 'DELETE', csrfToken });
}

async function httpPostMultipart(url, cookie, csrfToken, filePath, fileName) {
  const fs = require('fs');
  const path = require('path');
  const boundary = '----OverleafNeovim' + Date.now().toString(36);
  fileName = fileName || path.basename(filePath);

  const fileData = fs.readFileSync(filePath);

  // Build multipart body
  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="qqfile"; filename="${fileName}"\r\n`);
  parts.push(`Content-Type: application/octet-stream\r\n\r\n`);
  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileData, footer]);

  return httpRequest(url, cookie, { method: 'POST', timeout: 60000, csrfToken,
    body, contentType: `multipart/form-data; boundary=${boundary}` });
}

module.exports = { fetchProjectPage, updateCookies, httpPost, httpGet, httpDelete, httpPostMultipart };
