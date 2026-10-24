import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { juiceTemplates, JUICE_CATALOG_VERSION, juiceCatalogMetadata, resolveJuicePrompt, composeJuiceModelPrompt } from '../src/juice-catalog.js';

const hashes = JSON.parse(readFileSync(new URL('./fixtures/juice-prompt-hashes.json', import.meta.url), 'utf8'));
test('all seventeen original template IDs and prompt bytes remain in the engine', () => {
  assert.equal(juiceTemplates.length, 17); assert.equal(new Set(juiceTemplates.map(type => type.id)).size, 17);
  assert.deepEqual(juiceTemplates.map(type => type.id).sort(), Object.keys(hashes).sort());
  for (const type of juiceTemplates) assert.equal(createHash('sha256').update(type.prompt).digest('hex'), hashes[type.id]);
  assert.equal(juiceTemplates.filter(type => type.category === 'hr').length, 4);
  assert.equal(juiceTemplates.filter(type => type.category === 'relationship').length, 1);
});
test('all seventeen template prompts and optional focus reach the final model input with actual source context', () => {
  for (const type of juiceTemplates) {
    const focus = type.id === 'relationship' ? 'o que combinamos sobre a viagem?' : 'somente o projeto Aurora';
    const instructions = resolveJuicePrompt({ analysisType: type.id, templateVersion: JUICE_CATALOG_VERSION, focus, basePrompt: 'browser must not replace this template' });
    const prompt = composeJuiceModelPrompt('CONVERSA SINTÉTICA; 08/10 a 15/10; somente 2 mensagens', instructions, '[14/10 09:00] Ana: A viagem fica para sexta.\n[14/10 09:01] Beto: Fechado.');
    assert(prompt.includes(type.prompt)); assert(prompt.includes(focus));
    assert(!prompt.includes('browser must not replace'));
    assert(prompt.includes('Se o dado ou o assunto não aparecer'));
    assert(prompt.includes('Beto: Fechado.')); assert(prompt.startsWith('CONVERSA SINTÉTICA'));
    assert(resolveJuicePrompt({ analysisType: type.id, templateVersion: JUICE_CATALOG_VERSION }).includes(type.prompt));
  }
});
test('legacy onboarding/cron/retries keep exact prompts, while versioned custom requests stay available', () => {
  for (const analysisType of ['general','meeting','project','daily_auto','custom']) assert.equal(resolveJuicePrompt({ analysisType, basePrompt: 'exact legacy prompt\nline2' }), 'exact legacy prompt\nline2');
  const result = resolveJuicePrompt({ analysisType:'custom', templateVersion:JUICE_CATALOG_VERSION, basePrompt:'Organize a viagem e o que falta decidir.' });
  assert(result.startsWith('Organize a viagem e o que falta decidir.'));
  assert(!resolveJuicePrompt({ analysisType:'relationship', templateVersion:JUICE_CATALOG_VERSION, focus:'   ' }).includes('FOCO ESCOLHIDO'));
});
test('unknown model/version, oversized focus and empty custom input fail closed', () => {
  const valid = { analysisType:'hr_climate', templateVersion:JUICE_CATALOG_VERSION };
  for (const request of [{...valid, analysisType:'invented'}, {...valid, templateVersion:'old'}, {...valid, focus:'x'.repeat(2001)}, {...valid, focus:'secret\0'}, {...valid, focus:42}, {...valid, analysisType:'custom', basePrompt:''}, {...valid, analysisType:'custom', basePrompt:'x'.repeat(10001)}, {analysisType:'general', focus:'hello'}]) assert.throws(() => resolveJuicePrompt(request as any));
});
test('focus participates in the effective request identity; metadata never carries model instructions', () => {
  const base = { analysisType:'hr_performance', templateVersion:JUICE_CATALOG_VERSION };
  assert.notEqual(resolveJuicePrompt({...base,focus:'Aurora'}), resolveJuicePrompt({...base,focus:'Outro projeto'}));
  assert.equal(resolveJuicePrompt({...base,focus:'Aurora'}), resolveJuicePrompt({...base,focus:'Aurora'}));
  const publicMetadata = juiceCatalogMetadata(); assert.equal(publicMetadata.types.length,17);
  assert(!JSON.stringify(publicMetadata).includes('prompt'));
  const source = readFileSync(new URL('../src/summarizer.ts', import.meta.url),'utf8');
  assert(source.indexOf('resolveJuicePrompt(args)') < source.indexOf("pool.query('SELECT * FROM wa_chats"));
  assert(source.includes('composeJuiceModelPrompt(')); assert(source.includes('templateVersion:args.templateVersion'));
});
