import { RuntimeError } from './ledger.js';

export const ASR_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
export const ASR_MODEL = 'glm-asr-2512';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_MS = 30_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_TEXT_CHARS = 20_000;

export interface AsrOptions {
  keyProvider: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AsrChunk {
  /** WAV bytes recorded as PCM 16 kHz mono; never persisted by this client. */
  bytes: Uint8Array;
  durationMs: number;
  requestId: string;
  /** Tail of the previous chunk transcript; keeps context across a split note. */
  prompt?: string;
}

/**
 * One GLM-ASR-2512 transcription call for a single ≤30 s WAV chunk. The audio
 * buffer is wiped on return; the caller owns error policy (skip or abort).
 */
export async function transcribeWavChunk(chunk: AsrChunk, options: AsrOptions): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 60_000;
  if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0 ||
      chunk.bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new RuntimeError('ASR_INPUT', 400);
  if (!Number.isFinite(chunk.durationMs) || chunk.durationMs < 200 || chunk.durationMs > MAX_CHUNK_MS)
    throw new RuntimeError('ASR_INPUT', 400);
  if (typeof chunk.requestId !== 'string' || !/^[A-Za-z0-9-]{6,64}$/.test(chunk.requestId))
    throw new RuntimeError('ASR_INPUT', 400);
  const prompt = chunk.prompt ? chunk.prompt.slice(-MAX_PROMPT_CHARS) : undefined;
  const key = (await options.keyProvider()).trim();
  if (!key || /[\r\n]/.test(key)) throw new RuntimeError('PROVIDER_NOT_CONFIGURED');

  const form = new FormData();
  form.append('model', ASR_MODEL);
  form.append('request_id', chunk.requestId);
  if (prompt) form.append('prompt', prompt);
  form.append('file', new Blob([chunk.bytes.slice().buffer], { type: 'audio/wav' }), 'chunk.wav');
  chunk.bytes.fill(0);

  let response: Response;
  try {
    response = await fetcher(ASR_ENDPOINT, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}` }, body: form,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new RuntimeError('PROVIDER_CONNECTION_UNCERTAIN');
  }
  if (!response.ok) {
    // Drain a bounded error body for diagnostics shape only; never surface it.
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new RuntimeError(response.status === 429 ? 'PROVIDER_BUSY' : 'PROVIDER_UNAVAILABLE',
      response.status === 429 ? 429 : 503);
  }
  let data: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    let size = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw Error(); }
      parts.push(next.value);
    }
    data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch { throw new RuntimeError('PROVIDER_INVALID_RESPONSE'); }
  const body = data as { model?: unknown; text?: unknown };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (typeof body.model !== 'string' || !/^glm-asr/.test(body.model) || !text || text.length > MAX_TEXT_CHARS)
    throw new RuntimeError('PROVIDER_INVALID_RESPONSE');
  return text;
}
