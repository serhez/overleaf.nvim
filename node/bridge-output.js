'use strict';

/** Synchronization events are hints to reread durable state. Retain only their
 * latest value per document while the editor cannot consume more output. RPC
 * replies and ordered socket events remain complete and ordered. */
function createOutput(stream) {
  let blocked = false;
  const pending = new Map();
  const send = message => {
    if (!stream.write(JSON.stringify(message) + '\n')) blocked = true;
  };
  const sendEvent = (event, data) => {
    const message = { event, data };
    if (blocked && event === 'syncChanged') {
      pending.set(JSON.stringify([data.session, data.document]), message);
    } else send(message);
  };
  stream.on('drain', () => {
    blocked = false;
    while (!blocked && pending.size) {
      const [key, message] = pending.entries().next().value;
      pending.delete(key);
      send(message);
    }
  });
  return { send, sendEvent };
}

module.exports = { createOutput };
