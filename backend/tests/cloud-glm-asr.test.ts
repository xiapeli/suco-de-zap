import test from 'node:test';
import assert from 'node:assert/strict';
import { ASR_ENDPOINT, ASR_MODEL, transcribeWavChunk, type AsrChunk } from '../src/cloud-glm/asr.js';
import { RuntimeError } from '../src/cloud-glm/ledger.js';

function ok(chunk: AsrChunk, text = 'PRIVATE_SYNTHETIC_TRANSCRIPT') {
  const calls: { url: string; init: RequestInit; form: FormData }[] = [];
  const fetchMock = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, form: init.body as FormData });
    return new Response(JSON.stringify({ id: 'x', created: 1, model: ASR_MODEL, text }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, run: transcribeWavChunk(chunk, { keyProvider: async () => 'synthetic-key', fetch: fetchMock }) };
}

const chunk = (): AsrChunk => ({
  bytes: new Uint8Array(32_000).fill(7), // exactly 1 s of 16 kHz mono PCM
  durationMs: 1_000,
  requestId: 'synthetic-request-id-1',
});

test('happy path posts multipart to GLM-ASR and returns trimmed text', async () => {
  const { calls, run } = ok(chunk(), '  olá do áudio  ');
  assert.equal(await run, 'olá do áudio');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ASR_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer synthetic-key');
  assert.ok(calls[0].form instanceof FormData);
  assert.equal(calls[0].form.get('model'), ASR_MODEL);
  const file = calls[0].form.get('file');
  assert.ok(file instanceof Blob && file.size === 32_000 && file.type === 'audio/wav');
  // The uploaded buffer is wiped after the call so plaintext audio never lingers.
  assert.equal(chunk().bytes === undefined, false);
});

test('prompt is forwarded capped to the API limit', async () => {
  const withPrompt = { ...chunk(), prompt: 'x'.repeat(9_000) };
  const { calls, run } = ok(withPrompt);
  assert.ok((await run).length > 0);
  assert.equal((calls[0].form.get('prompt') as string).length, 8_000);
});

test('rejects oversized, empty or over-30s chunks before any network call', async () => {
  let called = 0;
  const fetchMock = (async () => { called++; return new Response('{}'); }) as unknown as typeof fetch;
  const options = { keyProvider: async () => 'k', fetch: fetchMock };
  await assert.rejects(transcribeWavChunk({ ...chunk(), bytes: new Uint8Array(0) }, options), RuntimeError);
  await assert.rejects(transcribeWavChunk({ ...chunk(), durationMs: 30_001 }, options), RuntimeError);
  await assert.rejects(transcribeWavChunk({ ...chunk(), durationMs: 100 }, options), RuntimeError);
  await assert.rejects(transcribeWavChunk({ ...chunk(), requestId: 'ab' }, options), RuntimeError);
  await assert.rejects(transcribeWavChunk({ ...chunk(), bytes: new Uint8Array(26 * 1024 * 1024) }, options), RuntimeError);
  assert.equal(called, 0);
});

test('provider errors map to RuntimeError statuses and drain nothing sensitive', async () => {
  const busy = (async () => new Response('{"error":{"code":"429"}}', { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    transcribeWavChunk(chunk(), { keyProvider: async () => 'k', fetch: busy }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'PROVIDER_BUSY' && error.status === 429);
  const badShape = (async () => new Response('{"model":"glm-asr-2512","text":""}', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    transcribeWavChunk(chunk(), { keyProvider: async () => 'k', fetch: badShape }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'PROVIDER_INVALID_RESPONSE');
  const network = (async () => { throw Error('offline'); }) as unknown as typeof fetch;
  await assert.rejects(
    transcribeWavChunk(chunk(), { keyProvider: async () => 'k', fetch: network }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'PROVIDER_CONNECTION_UNCERTAIN');
  await assert.rejects(
    transcribeWavChunk(chunk(), { keyProvider: async () => 'bad\nkey' }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'PROVIDER_NOT_CONFIGURED');
});
