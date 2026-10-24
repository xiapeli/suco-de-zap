import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CIPHERTEXT = 4 * 1024 * 1024;
// The provider request has a 90-second deadline. A VM restart must not leave the
// browser waiting forever for a job whose in-memory task no longer exists.
const JOB_STALE_MS = 3 * 60_000;

export interface PrivateSummary {
  id: string;
  chat_jid: string;
  chat_name: string;
  title: string;
  analysis_type: string;
  period_start: string;
  period_end: string;
  content: string;
  model: string;
  created_at: string;
  auto: boolean;
}

export interface PrivatePersonalType {
  id: string; name: string; category: string; base_type: string; instructions: string;
  created_at: string; updated_at: string; revision: number;
}

type Job = { kind: 'job'; fingerprint: string; created_at: string;
  state: 'pending' | 'failed'; error_code?: string };
type Completed = { kind: 'summary'; fingerprint: string; summary: PrivateSummary };
type Personal = { kind: 'personal'; personal: Omit<PrivatePersonalType, 'revision'>; archived: boolean };
type Stored = Job | Completed | Personal;
type Row = { object_id: string; key_epoch: number; nonce: string; ciphertext: string; revision: number };

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function bytea(hex: string): string { return `\\x${hex}`; }
function decodeBytea(value: unknown, min: number, max: number): Buffer {
  if (typeof value !== 'string' || !/^\\x[0-9a-f]+$/i.test(value) ||
      (value.length - 2) % 2 || (value.length - 2) / 2 < min || (value.length - 2) / 2 > max)
    return fail('PRIVATE_SUMMARY_CORRUPT');
  return Buffer.from(value.slice(2), 'hex');
}

export function createConfidentialSummaryStore(options: {
  url: string; publishableKey: string; ownerId: string; keyEpoch: number; key: Uint8Array;
  userJwt: () => Promise<string>; fetcher?: typeof fetch;
}) {
  if (!/^https:\/\//.test(options.url) || !UUID.test(options.ownerId) ||
      options.publishableKey.startsWith('sb_secret_') ||
      options.key.length !== 32 || !Number.isInteger(options.keyEpoch) || options.keyEpoch < 1)
    fail('PRIVATE_SUMMARY_INPUT');
  const base = options.url.replace(/\/$/, '');
  const fetcher = options.fetcher ?? fetch;
  const salt = Buffer.from(`${options.ownerId}\0${options.ownerId}`, 'utf8');
  const key = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-private-summaries-v1:enc', 32));
  let closed = false;
  const ensureOpen = () => { if (closed) fail('PRIVATE_SUMMARY_CLOSED'); };
  const aad = (id: string, epoch: number) =>
    Buffer.from(`suco-private-summaries-v1\0${options.ownerId}\0${id}\0${epoch}`);

  async function request(path: string, init?: RequestInit): Promise<Response> {
    ensureOpen();
    const jwt = await options.userJwt();
    if (!jwt || jwt.split('.').length !== 3) fail('PRIVATE_SUMMARY_AUTH');
    const response = await fetcher(`${base}/rest/v1/${path}`, {
      ...init, headers: { apikey: options.publishableKey, Authorization: `Bearer ${jwt}`,
        Accept: 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) fail('PRIVATE_SUMMARY_AUTH');
    return response;
  }

  function seal(id: string, value: Stored) {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    if (plaintext.length + 16 > MAX_CIPHERTEXT) fail('PRIVATE_SUMMARY_INPUT');
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(id, options.keyEpoch));
      const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      const result = { nonce: bytea(nonce.toString('hex')), ciphertext: bytea(sealed.toString('hex')) };
      sealed.fill(0);
      return result;
    } finally { plaintext.fill(0); }
  }

  function open(row: Row): Stored {
    try {
      if (!UUID.test(row.object_id) || row.key_epoch !== options.keyEpoch ||
          !Number.isSafeInteger(row.revision) || row.revision < 1) fail('PRIVATE_SUMMARY_CORRUPT');
      const nonce = decodeBytea(row.nonce, 12, 12);
      const sealed = decodeBytea(row.ciphertext, 32, MAX_CIPHERTEXT);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad(row.object_id, row.key_epoch));
        decipher.setAuthTag(sealed.subarray(-16));
        const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
        try {
          const value = JSON.parse(clear.toString('utf8')) as Stored;
          if (!value || !['job', 'summary', 'personal'].includes(value.kind))
            fail('PRIVATE_SUMMARY_CORRUPT');
          if ((value.kind === 'job' || value.kind === 'summary') &&
              (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)))
            fail('PRIVATE_SUMMARY_CORRUPT');
          if (value.kind === 'summary' && (value.summary?.id !== row.object_id ||
              typeof value.summary.content !== 'string' || typeof value.summary.chat_jid !== 'string'))
            fail('PRIVATE_SUMMARY_CORRUPT');
          if (value.kind === 'personal' && (value.personal?.id !== row.object_id ||
              typeof value.personal.name !== 'string' || typeof value.personal.instructions !== 'string' ||
              typeof value.personal.category !== 'string' || typeof value.personal.base_type !== 'string' ||
              typeof value.archived !== 'boolean')) fail('PRIVATE_SUMMARY_CORRUPT');
          return value;
        } finally { clear.fill(0); }
      } finally { nonce.fill(0); sealed.fill(0); }
    } catch { return fail('PRIVATE_SUMMARY_CORRUPT'); }
  }

  async function readRow(id: string): Promise<Row | null> {
    if (!UUID.test(id)) fail('PRIVATE_SUMMARY_INPUT');
    const response = await request(`suco_cipher_objects?select=object_id,key_epoch,nonce,ciphertext,revision&object_id=eq.${id}&limit=1`);
    if (!response.ok) fail('PRIVATE_SUMMARY_STORE');
    const rows = await response.json() as Row[];
    if (!Array.isArray(rows) || rows.length > 1) fail('PRIVATE_SUMMARY_STORE');
    return rows[0] ?? null;
  }

  async function put(id: string, revision: number, value: Stored): Promise<number> {
    if (!UUID.test(id) || !Number.isSafeInteger(revision) || revision < 0) fail('PRIVATE_SUMMARY_INPUT');
    const encrypted = seal(id, value);
    const response = await request('rpc/suco_cipher_put', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_object_id: id, p_expected_revision: revision,
        p_key_epoch: options.keyEpoch, p_nonce: encrypted.nonce,
        p_ciphertext: encrypted.ciphertext }),
    });
    if (response.status === 409 || (response.status === 400 &&
      (await response.clone().json().catch(() => ({})) as { code?: string }).code === '40001'))
      fail('PRIVATE_SUMMARY_CONFLICT');
    if (!response.ok) fail('PRIVATE_SUMMARY_STORE');
    const next = Number(await response.json());
    if (next !== revision + 1) fail('PRIVATE_SUMMARY_STORE');
    return next;
  }

  async function allRows(): Promise<Row[]> {
    const rows: Row[] = [];
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const response = await request(`suco_cipher_objects?select=object_id,key_epoch,nonce,ciphertext,revision&order=created_at.desc,object_id.desc&limit=1000&offset=${offset}`);
      if (!response.ok) fail('PRIVATE_SUMMARY_STORE');
      const page = await response.json() as Row[];
      if (!Array.isArray(page) || page.length > 1000) fail('PRIVATE_SUMMARY_STORE');
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
    // Never report a truncated library as if it were complete.
    return fail('PRIVATE_SUMMARY_STORE');
  }

  return {
    async reserve(id: string, fingerprint: string): Promise<PrivateSummary | null> {
      if (!UUID.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('PRIVATE_SUMMARY_INPUT');
      const existing = await readRow(id);
      if (existing) {
        const value = open(existing);
        if (value.kind === 'personal') fail('PRIVATE_SUMMARY_CONFLICT');
        if (value.fingerprint !== fingerprint) fail('PRIVATE_SUMMARY_CONFLICT');
        if (value.kind === 'summary') return value.summary;
        fail('PRIVATE_SUMMARY_PENDING');
      }
      try { await put(id, 0, { kind: 'job', fingerprint, created_at: new Date().toISOString(), state: 'pending' }); }
      catch (error) { if (error instanceof Error && error.message === 'PRIVATE_SUMMARY_CONFLICT')
        fail('PRIVATE_SUMMARY_PENDING'); throw error; }
      return null;
    },
    async complete(summary: PrivateSummary, fingerprint: string): Promise<void> {
      const existing = await readRow(summary.id);
      if (!existing) fail('PRIVATE_SUMMARY_PENDING');
      const value = open(existing);
      if (value.kind !== 'job' || value.fingerprint !== fingerprint || existing.revision !== 1)
        fail('PRIVATE_SUMMARY_CONFLICT');
      await put(summary.id, 1, { kind: 'summary', fingerprint, summary });
    },
    async fail(id: string, fingerprint: string, errorCode: string): Promise<void> {
      const existing = await readRow(id);
      if (!existing) fail('PRIVATE_SUMMARY_PENDING');
      const value = open(existing);
      if (value.kind !== 'job' || value.fingerprint !== fingerprint || existing.revision !== 1 ||
          !/^[A-Z_]{3,64}$/.test(errorCode)) fail('PRIVATE_SUMMARY_CONFLICT');
      await put(id, 1, { ...value, state: 'failed', error_code: errorCode });
    },
    async status(id: string): Promise<{ state: 'missing' | 'pending' | 'failed' | 'complete'; summary?: PrivateSummary }> {
      const row = await readRow(id);
      if (!row) return { state: 'missing' };
      const value = open(row);
      if (value.kind === 'personal') return { state: 'missing' };
      if (value.kind === 'summary') return { state: 'complete', summary: value.summary };
      if (value.state === 'pending' &&
          (!Number.isFinite(Date.parse(value.created_at)) ||
           Date.now() - Date.parse(value.created_at) > JOB_STALE_MS))
        return { state: 'failed' };
      return { state: value.state };
    },
    async get(id: string): Promise<PrivateSummary | null> {
      const row = await readRow(id);
      if (!row) return null;
      const value = open(row);
      return value.kind === 'summary' ? value.summary : null;
    },
    async deleteSummary(id: string): Promise<void> {
      const row = await readRow(id);
      if (!row) return;
      const value = open(row);
      if (value.kind !== 'summary' || value.summary.analysis_type === 'digest')
        fail('PRIVATE_SUMMARY_NOT_FOUND');
      const response = await request('rpc/suco_cipher_delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_object_id: id, p_expected_revision: row.revision }),
      });
      if (!response.ok) fail('PRIVATE_SUMMARY_STORE');
      if (await response.json() !== true) fail('PRIVATE_SUMMARY_CONFLICT');
    },
    async list(limit = 50, offset = 0): Promise<{ summaries: PrivateSummary[]; total: number }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0)
        fail('PRIVATE_SUMMARY_INPUT');
      const rows = await allRows();
      const summaries = rows.map(row => open(row)).filter((value): value is Completed => value.kind === 'summary')
        .map(value => value.summary).filter(value => value.analysis_type !== 'digest')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { summaries: summaries.slice(offset, offset + limit), total: summaries.length };
    },
    async listDigests(limit = 60, offset = 0): Promise<{ digests: PrivateSummary[]; total: number }> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 120 || !Number.isInteger(offset) || offset < 0)
        fail('PRIVATE_SUMMARY_INPUT');
      const rows = await allRows();
      const digests = rows.map(row => open(row)).filter((value): value is Completed => value.kind === 'summary')
        .map(value => value.summary).filter(value => value.analysis_type === 'digest')
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { digests: digests.slice(offset, offset + limit), total: digests.length };
    },
    async listTypes(): Promise<PrivatePersonalType[]> {
      const rows = await allRows();
      return rows.map(row => ({ row, value: open(row) })).filter(
        (item): item is { row: Row; value: Personal } => item.value.kind === 'personal' && !item.value.archived,
      ).map(({ row, value }) => ({ ...value.personal, revision: row.revision }))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
    async getType(id: string): Promise<PrivatePersonalType | null> {
      const row = await readRow(id);
      if (!row) return null;
      const value = open(row);
      return value.kind === 'personal' && !value.archived ? { ...value.personal, revision: row.revision } : null;
    },
    async saveType(input: { id: string; revision: number; name: string; category: string;
      base_type: string; instructions: string }): Promise<PrivatePersonalType> {
      if (!UUID.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
          !input.name.trim() || input.name.length > 80 || input.category.length > 60 ||
          !input.instructions.trim() || input.instructions.length > 10_000 ||
          !input.base_type || input.base_type.length > 100) fail('PRIVATE_SUMMARY_INPUT');
      const existing = await readRow(input.id);
      if ((existing?.revision ?? 0) !== input.revision) fail('PRIVATE_SUMMARY_CONFLICT');
      const previous = existing && open(existing);
      if (previous && (previous.kind !== 'personal' || previous.archived)) fail('PRIVATE_SUMMARY_CONFLICT');
      const now = new Date().toISOString();
      const personal: Omit<PrivatePersonalType, 'revision'> = {
        id: input.id, name: input.name.trim(), category: input.category.trim(),
        base_type: input.base_type, instructions: input.instructions.trim(),
        created_at: previous?.kind === 'personal' ? previous.personal.created_at : now,
        updated_at: now,
      };
      const revision = await put(input.id, input.revision, { kind: 'personal', personal, archived: false });
      return { ...personal, revision };
    },
    async archiveType(id: string, revision: number): Promise<void> {
      if (!UUID.test(id) || !Number.isSafeInteger(revision) || revision < 1)
        fail('PRIVATE_SUMMARY_INPUT');
      const row = await readRow(id);
      if (!row || row.revision !== revision) fail('PRIVATE_SUMMARY_CONFLICT');
      const value = open(row);
      if (value.kind !== 'personal' || value.archived) fail('PRIVATE_SUMMARY_CONFLICT');
      await put(id, revision, { ...value, archived: true });
    },
    close() { closed = true; key.fill(0); },
  };
}

export type ConfidentialSummaryStore = ReturnType<typeof createConfidentialSummaryStore>;
