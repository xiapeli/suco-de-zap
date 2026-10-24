import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { transcribeWavChunk, type AsrOptions } from '../cloud-glm/asr.js';
import { RuntimeError } from '../cloud-glm/ledger.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_NOTE_MS = 10 * 60_000;
const MAX_SEGMENTS = 20;
const SEGMENT_MS = 30_000;
const SEGMENT_BYTES_PER_MS = 32; // pcm_s16le 16 kHz mono = 32 bytes per millisecond
const WAV_HEADER_BYTES = 44; // RIFF header ffmpeg writes on every pcm_s16le segment file
const PROMPT_TAIL_CHARS = 2_000;
const RETRY_DELAY_MS = 1_500;

export interface AudioNote {
  /** Raw WhatsApp voice bytes (ogg/opus); wiped after conversion, never persisted. */
  bytes: Uint8Array;
  mime: string;
  durationMs: number;
}

export type AudioTranscriber = (note: AudioNote) => Promise<string | null>;

export interface TranscriberDeps extends AsrOptions {
  ffmpegPath?: string;
  /** Injectable for tests: runs ffmpeg with argv after the binary path. */
  runFfmpeg?: (argv: string[]) => Promise<{ code: number }>;
}

function defaultRunFfmpeg(ffmpegPath: string) {
  return (argv: string[]) => new Promise<{ code: number }>((resolve, reject) => {
    const child = spawn(ffmpegPath, argv, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1 }));
  });
}

async function transcribeWithRetry(chunk: Parameters<typeof transcribeWavChunk>[0], options: AsrOptions): Promise<string> {
  // The client wipes the buffer it is handed, so keep a pristine copy for the retry.
  const pristine = chunk.bytes.slice();
  try {
    return await transcribeWavChunk(chunk, options);
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code === 'ASR_INPUT') throw error;
    // Provider hiccups (busy, timeout, 5xx) get exactly one retry; input and
    // config errors are deterministic and must fail fast.
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return transcribeWavChunk({ ...chunk, bytes: pristine }, options);
  }
}

/**
 * Voice notes become searchable text inside the TEE: ffmpeg decodes the opus
 * note to 16 kHz mono WAV and splits it into GLM-ASR's 30 s window, then each
 * chunk is transcribed with the tail of the previous one as context. Any
 * failure returns null so ingestion keeps the plain "[audio]" placeholder
 * instead of blocking the message.
 */
export function createConfidentialTranscriber(deps: TranscriberDeps): AudioTranscriber {
  const runFfmpeg = deps.runFfmpeg ?? defaultRunFfmpeg(deps.ffmpegPath ?? 'ffmpeg');
  let flight: Promise<null> = Promise.resolve(null); // one note at a time

  async function transcribe(note: AudioNote): Promise<string | null> {
    if (!(note.bytes instanceof Uint8Array) || note.bytes.byteLength === 0 ||
        note.bytes.byteLength > MAX_INPUT_BYTES) return null;
    if (!Number.isFinite(note.durationMs) || note.durationMs < 500 || note.durationMs > MAX_NOTE_MS) return null;
    const requestId = randomUUID();
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), 'suco-asr-'));
      await chmod(directory, 0o700);
      const input = join(directory, 'note.bin');
      await writeFile(input, note.bytes);
      note.bytes.fill(0);
      const pattern = join(directory, 'seg');
      const result = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y',
        '-i', input, '-ac', '1', '-ar', '16000', '-f', 'segment', '-segment_time', '29',
        '-c:a', 'pcm_s16le', `${pattern}%03d.wav`]);
      if (result.code !== 0) return null;
      const names = (await readdir(directory)).filter(n => n.startsWith('seg') && n.endsWith('.wav')).sort();
      if (names.length === 0 || names.length > MAX_SEGMENTS) return null;
      let transcript = '';
      for (let i = 0; i < names.length; i++) {
        const bytes = await readFile(join(directory, names[i]));
        // byteLength counts the 44-byte RIFF header; a segment that is exactly
        // SEGMENT_MS long would otherwise compute SEGMENT_MS + 1 and be
        // rejected by the provider's hard cap. Subtract the header and clamp.
        const durationMs = Math.min(SEGMENT_MS, Math.max(0,
          Math.round((bytes.byteLength - WAV_HEADER_BYTES) / SEGMENT_BYTES_PER_MS)));
        const piece = await transcribeWithRetry(
          { bytes: new Uint8Array(bytes), durationMs, requestId: `${requestId}-${String(i).padStart(3, '0')}`,
            prompt: transcript ? transcript.slice(-PROMPT_TAIL_CHARS) : undefined },
          deps);
        transcript = transcript ? `${transcript} ${piece}` : piece;
      }
      return transcript || null;
    } catch {
      return null;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  return note => {
    // transcribe never rejects; the chain only serializes one note at a time.
    const run = flight.then(() => transcribe(note));
    flight = run.then(() => null, () => null);
    return run;
  };
}
