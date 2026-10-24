import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createConfidentialTranscriber } from '../src/lib/confidential-audio.js';
import { ASR_MODEL } from '../src/cloud-glm/asr.js';

interface Call { requestId: string; durationMs: number; prompt?: string }

function fixture(t: TestContext, segments: number, texts: string[], failOnce = false) {
  const calls: Call[] = [];
  const queue = [...texts];
  const fetchMock = (async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get('file') as Blob;
    const buffer = Buffer.from(await file.arrayBuffer());
    // Our own ffmpeg flags guarantee pcm_s16le 16 kHz mono WAV: 44-byte RIFF
    // header, then 32 bytes per ms (mirrors the provider's length check).
    const durationMs = Math.round((buffer.byteLength - 44) / 32);
    const requestId = form.get('request_id') as string;
    const prompt = form.get('prompt') as string | null;
    const call: Call = { requestId, durationMs, prompt: prompt ?? undefined };
    calls.push(call);
    if (failOnce && calls.length === 1)
      return new Response('{"error":{"code":"500"}}', { status: 500 });
    const text = queue.length ? queue.shift()! : 'fallback';
    return new Response(JSON.stringify({ id: 'x', created: 1, model: ASR_MODEL, text }),
      { status: 200 });
  }) as unknown as typeof fetch;
  const runFfmpeg = async (argv: string[]) => {
    const pattern = argv[argv.length - 1].replace(/%03d$/, '');
    const { writeFile } = await import('node:fs/promises');
    for (let i = 0; i < segments; i++) {
      // 20 s per segment keeps every request inside GLM-ASR's 30 s window.
      await writeFile(`${pattern}${String(i).padStart(3, '0')}.wav`,
        Buffer.concat([Buffer.alloc(44), Buffer.alloc(20_000 * 32)]));
    }
    return { code: 0 };
  };
  const transcriber = createConfidentialTranscriber({
    keyProvider: async () => 'synthetic-key', fetch: fetchMock, runFfmpeg,
  });
  t.after(() => {});
  return { transcriber, calls };
}

const note = { bytes: new Uint8Array(2048).fill(3), mime: 'audio/ogg; codecs=opus', durationMs: 45_000 };

test('multi-segment note transcribes in order with context carry', async (t) => {
  const { transcriber, calls } = fixture(t, 2, ["primeiro pedaço", "segundo pedaço"]);
  const result = await transcriber(note);
  assert.equal(result, 'primeiro pedaço segundo pedaço');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].durationMs, 20_000);
  assert.equal(calls[0].prompt, undefined);
  assert.equal(calls[1].prompt, 'primeiro pedaço');
  assert.match(calls[0].requestId, /^[0-9a-f-]{36}-000$/);
});

test('a transient provider failure retries once and still succeeds', async (t) => {
  const { transcriber, calls } = fixture(t, 1, ["depois do retry"], true);
  const result = await transcriber(note);
  assert.equal(result, 'depois do retry');
  assert.equal(calls.length, 2);
});

test('oversized or missing ffmpeg output yields null without provider calls', async (t) => {
  const broken = fixture(t, 0, ["nunca usado"]);
  assert.equal(await broken.transcriber(note), null);
  assert.equal(broken.calls.length, 0);
  const tooLong = { ...note, durationMs: 11 * 60_000 };
  const short = fixture(t, 1, ["nunca"]);
  assert.equal(await short.transcriber(tooLong), null);
  assert.equal(short.calls.length, 0);
});

test('notes are serialized and failures degrade to null', async (t) => {
  const { transcriber, calls } = fixture(t, 1, ["ok", "ok"]);
  const failing = createConfidentialTranscriber({
    keyProvider: async () => { throw Error('secret'); },
    runFfmpeg: async () => ({ code: 0 }),
  });
  // keyProvider failure happens per call inside the chain, still returning null.
  assert.equal(await failing(note), null);
  const [a, b] = await Promise.all([transcriber(note), transcriber(note)]);
  assert.equal(a, 'ok');
  assert.equal(b, 'ok');
  assert.equal(calls.length, 2);
});

test('a full-length segment (header included) stays inside the 30 s window', async (t) => {
  // Regression: a segment holding exactly 30 s of PCM plus the 44-byte RIFF
  // header used to compute 30_001 ms and fail ASR_INPUT before any request
  // was sent, silently dropping every long voice note.
  const durations: number[] = [];
  const fetchMock = (async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get('file') as Blob;
    const buffer = Buffer.from(await file.arrayBuffer());
    durations.push(Math.round((buffer.byteLength - 44) / 32));
    return new Response(JSON.stringify({ id: 'x', created: 1, model: ASR_MODEL, text: 'ok' }),
      { status: 200 });
  }) as unknown as typeof fetch;
  const runFfmpeg = async (argv: string[]) => {
    const pattern = argv[argv.length - 1].replace(/%03d$/, '');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${pattern}000.wav`,
      Buffer.concat([Buffer.alloc(44), Buffer.alloc(30_000 * 32)]));
    return { code: 0 };
  };
  const transcriber = createConfidentialTranscriber({
    keyProvider: async () => 'synthetic-key', fetch: fetchMock, runFfmpeg,
  });
  t.after(() => {});
  const result = await transcriber({ ...note, durationMs: 31_000 });
  assert.equal(result, 'ok');
  assert.equal(durations.length, 1);
  assert.ok(durations[0] <= 30_000, `segment exceeded the provider cap: ${durations[0]}`);
});
