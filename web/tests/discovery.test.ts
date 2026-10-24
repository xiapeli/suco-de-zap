import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHandoff, vaultDestination, plainExcerpt } from '../src/lib/discovery.ts';

test('sensitive intents lead to protected vault categories without querying or generating', () => {
  assert.equal(vaultDestination('Cadê o Pix da Ana?')?.kind, 'pix');
  assert.equal(vaultDestination('e-mail da loja')?.kind, 'email');
  assert.equal(vaultDestination('endereço do cliente')?.kind, 'address');
  assert.equal(vaultDestination('telefone de contato')?.kind, 'phone');
  assert.equal(vaultDestination('O que ficou combinado no lançamento?'), null);
});
test('handoff accepts only a bounded text request and does not accept generated operations', () => {
  assert.equal(searchHandoff({ sucoRequest: ' Prazos da Aurora ' }), 'Prazos da Aurora');
  for (const value of [null, [], 'prompt', { sucoRequest: {} }, { sucoRequest: 'x'.repeat(501) }, { sucoRequest: 'a\nsecret' }, { request_id: 'automatic-generation' }]) assert.equal(searchHandoff(value), '');
});
test('saved excerpts are plain text, including malicious markup and markdown links', () => {
  assert.equal(plainExcerpt('## **Ana** definiu [entrega](https://example.test) para sexta.'), 'Ana definiu entrega para sexta.');
  assert.equal(plainExcerpt('<b>prazo</b> <img src=x onerror=alert(1)> sexta'), 'prazo sexta');
});
