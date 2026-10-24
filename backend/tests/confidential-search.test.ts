import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfidentialSearch } from '../src/lib/confidential-search.js';
import type { ConfidentialMessageStore } from '../src/lib/confidential-message-store.js';
import type { ConfidentialMetadataStore } from '../src/lib/confidential-metadata-store.js';

test('private search filters saved messages by term, kind and chat without querying plaintext SQL', async () => {
  const messages = [
    { id: 'a', chat_jid: 'group@g.us', sender_name: 'Ana', sender_jid: null,
      from_me: false, body: 'Chave Pix do projeto: ana@example.com', msg_type: 'text', ts: new Date('2026-10-23T01:00:00Z') },
    { id: 'b', chat_jid: 'other@g.us', sender_name: 'Bia', sender_jid: null,
      from_me: false, body: 'A reunião será na Rua Central 12', msg_type: 'text', ts: new Date('2026-10-22T01:00:00Z') },
  ];
  let snapshots = 0;
  const store = { snapshot: async () => { snapshots++; return messages; } } as unknown as ConfidentialMessageStore;
  const metadata = { chatList: async () => [{ jid: 'group@g.us', name: 'Projeto', is_group: true },
    { jid: 'other@g.us', name: 'Equipe', is_group: true }] } as unknown as ConfidentialMetadataStore;
  const search = createConfidentialSearch(store, metadata);
  const result = await search({ query: 'Chave Pix', kind: 'pix' });
  assert.equal(result.total, 1);
  assert.equal(result.messages[0].chat_name, 'Projeto');
  assert.equal(result.coverage.totalMessages, 2);
  assert.equal(result.coverage.historyComplete, false);
  assert.equal(snapshots, 1);
  assert.equal((await search({ query: 'rua', kind: 'address', chat_jid: 'group@g.us' })).total, 0);
  await assert.rejects(search({ query: '', kind: 'all' }), /PRIVATE_SEARCH_INPUT/);
});
