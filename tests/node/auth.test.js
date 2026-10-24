'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const auth = require('../../node/auth');

async function fixture(t, respond) {
  const server = http.createServer((request, response) => {
    request.resume();
    respond(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-http-'));
  const filename = path.join(directory, 'asset.txt');
  await fs.writeFile(filename, 'upload bytes');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { url: 'http://127.0.0.1:' + server.address().port, filename };
}

async function within(operation, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP operation did not settle')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const requests = {
  GET: ({ url }) => auth.httpGet(url, 'test-cookie'),
  POST: ({ url }) => auth.httpPost(url, 'test-cookie', 'test-csrf', { test: true }),
  DELETE: ({ url }) => auth.httpDelete(url, 'test-cookie', 'test-csrf'),
  multipart: ({ url, filename }) => auth.httpPostMultipart(url, 'test-cookie', 'test-csrf', filename),
};

for (const [method, request] of Object.entries(requests)) {
  test(method + ' preserves status, headers, and UTF-8 split across response chunks', async t => {
    const bytes = Buffer.from('complete café 🌍');
    const options = await fixture(t, (incoming, response) => {
      assert.equal(incoming.headers.cookie, 'test-cookie');
      response.writeHead(201, { 'X-Response-Test': 'present' });
      response.write(bytes.subarray(0, bytes.length - 2));
      setImmediate(() => response.end(bytes.subarray(bytes.length - 2)));
    });
    const result = await within(request(options));
    assert.equal(result.status, 201);
    assert.equal(result.headers['x-response-test'], 'present');
    assert.equal(result.body, bytes.toString());
  });

  test(method + ' rejects a response interrupted after receiving its headers and partial body', async t => {
    const options = await fixture(t, (_, response) => {
      response.writeHead(200, { 'Content-Length': '1000' });
      response.write('incomplete');
      setImmediate(() => response.destroy());
    });
    await assert.rejects(within(request(options)), error => error.code === 'RESPONSE_INTERRUPTED');
  });

  test(method + ' rejects a connection lost before response headers', async t => {
    const options = await fixture(t, (_, response) => response.destroy());
    await assert.rejects(within(request(options)), error => error.code === 'ECONNRESET');
  });

  test(method + ' rejects an oversized declared response before buffering its body', async t => {
    const options = await fixture(t, (_, response) => {
      response.writeHead(200, { 'Content-Length': String(16 * 1024 * 1024 + 1) });
      response.flushHeaders();
    });
    await assert.rejects(within(request(options)), error => error.code === 'RESPONSE_TOO_LARGE');
  });

  test(method + ' bounds chunked bodies without relying on Content-Length', async t => {
    const options = await fixture(t, (_, response) => {
      response.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 'x');
      let sent = 0;
      const write = () => {
        while (!response.destroyed && sent++ < 17) {
          if (!response.write(chunk)) { response.once('drain', write); return; }
        }
        response.end();
      };
      write();
    });
    await assert.rejects(within(request(options), 5000), error => error.code === 'RESPONSE_TOO_LARGE');
  });
}

test('GET has a total deadline even while a peer keeps sending response data', async t => {
  const options = await fixture(t, (_, response) => {
    response.writeHead(200);
    response.write('still sending');
    const timer = setInterval(() => response.write('.'), 250);
    response.once('close', () => clearInterval(timer));
  });
  await assert.rejects(within(auth.httpGet(options.url, 'test-cookie'), 18000),
    error => error.code === 'REQUEST_TIMEOUT');
});

test('an exactly 16 MiB response is accepted intact', async t => {
  const body = 'x'.repeat(16 * 1024 * 1024);
  const options = await fixture(t, (_, response) => response.end(body));
  assert.equal((await within(auth.httpGet(options.url, 'test-cookie'), 5000)).body, body);
});

test('local POST encoding and upload read failures reject through the Promise API', async () => {
  const circular = {}; circular.self = circular;
  let post, upload;
  assert.doesNotThrow(() => { post = auth.httpPost('http://127.0.0.1', 'test', 'test', circular); });
  await assert.rejects(post, TypeError);
  assert.doesNotThrow(() => { upload = auth.httpPostMultipart('http://127.0.0.1', 'test', 'test', path.join(os.tmpdir(), 'overleaf-missing-upload', 'file')); });
  await assert.rejects(upload, { code: 'ENOENT' });
});

test('GET forwards explicit handshake headers and cancels a partial response with AbortSignal', async t => {
  let seen, closed, origin;
  const received = new Promise(resolve => { seen = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const options = await fixture(t, (request, response) => {
    origin = request.headers.origin;
    request.socket.once('close', closed);
    response.writeHead(200);
    response.write('partial');
    seen();
  });
  const controller = new AbortController();
  const result = auth.httpGet(options.url, 'test-cookie', { headers: { Origin: options.url }, signal: controller.signal });
  const rejected = assert.rejects(within(result), error => error.code === 'ABORT_ERR');
  await within(received);
  controller.abort();
  await rejected;
  await within(disconnected);
  assert.equal(origin, options.url);
});

test('disconnecting a project cancels an incomplete socket handshake and its socket', async t => {
  const SocketManager = require('../../node/socket');
  let seen, closed;
  const received = new Promise(resolve => { seen = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const options = await fixture(t, (request, response) => {
    request.socket.once('close', closed);
    response.writeHead(200);
    response.write('incomplete handshake');
    seen();
  });
  const previous = process.env.OVERLEAF_URL;
  process.env.OVERLEAF_URL = options.url;
  const manager = new SocketManager('test-cookie', 'project', () => {});
  if (previous === undefined) delete process.env.OVERLEAF_URL;
  else process.env.OVERLEAF_URL = previous;
  t.after(() => manager.disconnect());
  const result = manager.connect().then(() => null, error => error);
  await within(received);
  manager.disconnect();
  assert.equal((await within(result)).code, 'CONNECTION_REPLACED');
  await within(disconnected);
});
