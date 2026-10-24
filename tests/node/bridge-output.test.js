'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createOutput } = require('../../node/bridge-output');

class Sink extends EventEmitter {
  constructor(available = true) { super(); this.available = available; this.messages = []; }
  write(line) { this.messages.push(JSON.parse(line)); return this.available; }
  drain(available = true) { this.available = available; this.emit('drain'); }
}

test('normal RPC responses and events preserve their contents and order', () => {
  const sink = new Sink(), output = createOutput(sink);
  output.send({ id: 1, result: { content: 'café\n🌍' } });
  output.sendEvent('syncChanged', { session: 'project', document: 'doc', revision: 1 });
  output.send({ id: 2, error: { code: 'FAILED', message: 'retained' } });
  assert.deepEqual(sink.messages, [
    { id: 1, result: { content: 'café\n🌍' } },
    { event: 'syncChanged', data: { session: 'project', document: 'doc', revision: 1 } },
    { id: 2, error: { code: 'FAILED', message: 'retained' } },
  ]);
});

test('a blocked reader retains one latest synchronization hint per document', () => {
  const sink = new Sink(false), output = createOutput(sink);
  for (let revision = 1; revision <= 10000; revision++) {
    output.sendEvent('syncChanged', { session: 'project', document: 'doc', revision });
  }
  assert.equal(sink.messages.length, 1, 'Repeated hints must not grow the stream write queue');
  sink.drain();
  assert.equal(sink.messages.length, 2);
  assert.deepEqual(sink.messages[1], { event: 'syncChanged', data: { session: 'project', document: 'doc', revision: 10000 } });
});

test('coalescing distinguishes both project and document identity and flushes across repeated pressure', () => {
  const sink = new Sink(false), output = createOutput(sink);
  output.send({ id: 1, result: {} });
  const identities = [['a', 'bc'], ['ab', 'c'], ['a', 'other']];
  for (let revision = 1; revision <= 2; revision++) {
    for (const [session, document] of identities) output.sendEvent('syncChanged', { session, document, revision });
  }
  sink.drain(false);
  assert.equal(sink.messages.length, 2, 'Flushing must stop when the stream blocks again');
  sink.drain();
  assert.deepEqual(sink.messages.slice(1), identities.map(([session, document]) => ({
    event: 'syncChanged', data: { session, document, revision: 2 },
  })));
});

test('backpressure preserves every RPC result and ordered remote event', () => {
  const sink = new Sink(false), output = createOutput(sink);
  output.send({ id: 1, result: { saved: true } });
  output.sendEvent('syncChanged', { session: 'project', document: 'doc', revision: 1 });
  output.sendEvent('otUpdateApplied', { doc: 'doc', v: 1, op: [{ p: 0, i: 'first' }] });
  output.send({ id: 2, result: { saved: true } });
  output.sendEvent('otUpdateApplied', { doc: 'doc', v: 2, op: [{ p: 0, i: 'second' }] });
  output.sendEvent('syncChanged', { session: 'project', document: 'doc', revision: 2 });
  sink.drain();
  assert.deepEqual(sink.messages.map(message => message.id ?? message.event), [1, 'otUpdateApplied', 2, 'otUpdateApplied', 'syncChanged']);
  assert.equal(sink.messages.at(-1).data.revision, 2);
});
