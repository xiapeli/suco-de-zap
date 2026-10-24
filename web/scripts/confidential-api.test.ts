import test from 'node:test';
import assert from 'node:assert/strict';
import { confidentialApi, confidentialErrorText } from '../src/lib/confidential-api.ts';
import type { ConfidentialChannel } from '../src/lib/confidential-channel.ts';

test('conversation reads use encrypted RPC paths with encoded JIDs and pagination', async () => {
  const calls: Array<{ method: string; path: string; body?: object }> = [];
  const channel: ConfidentialChannel = {
    async rpc(method, path, body) {
      calls.push({ method, path, body });
      return { status: 200, body: path.includes('/messages') ? { messages: [], total: 0 } :
        path.includes('/stats') ? { count: 0, first: null, last: null, by_sender: [] } :
        { chats: [], total: 0 } };
    }, close() {},
  };
  await confidentialApi.chats(channel, { kind: 'group', q: 'Família & amigos', limit: 100, offset: 200 });
  await confidentialApi.messages(channel, '123@g.us', 100, 310);
  await confidentialApi.stats(channel, '123@g.us');
  assert.deepEqual(calls.map(call => call.path), [
    '/api/chats?kind=group&limit=100&offset=200&q=Fam%C3%ADlia%20%26%20amigos',
    '/api/chats/123%40g.us/messages?limit=100&offset=310',
    '/api/chats/123%40g.us/stats',
  ]);
  assert.equal(calls.every(call => call.method === 'GET'), true);
});

test('new pairing needs an explicit confirmation body and maps identity failures without numbers', async () => {
  const calls: object[] = [];
  const channel: ConfidentialChannel = {
    async rpc(_method, _path, body) {
      if (body) calls.push(body);
      return { status: 409, body: { code: 'PAIRING_IDENTITY_UNAVAILABLE' } };
    }, close() {},
  };
  await assert.rejects(confidentialApi.newPairing(channel), error => {
    assert.equal(confidentialErrorText(error),
      'Não conseguimos confirmar o WhatsApp anterior. A conta e o histórico foram preservados.');
    return true;
  });
  assert.deepEqual(calls, [{ confirm: 'NEW_PAIRING' }]);
});
