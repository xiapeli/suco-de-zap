import { PERSONAL_JUICE_SCHEMA } from './personal-juices.js';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { SUMMARY_REQUEST_SCHEMA } from './summary-workflow.js';
import { CONSENT_SCHEMA } from './onboarding.js';
import { VAULT_SCHEMA_SQL } from './vault-security.js';
import { SCHEMA as LLM_SCHEMA } from './cloud-glm/ledger.js';
import { retryIngestionWrite } from './lib/ingestion-write.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl || 'postgres://127.0.0.1:1/disabled', max: config.confidentialRuntime ? 1 : 10 });
if (config.confidentialRuntime) {
  // Legacy modules may be imported by API code, but no SQL may leave the TEE.
  // The confidential entrypoint never calls initDb; accidental use fails here.
  const deny = async () => { throw new Error('CONFIDENTIAL_SQL_DISABLED'); };
  pool.query = deny as typeof pool.query;
  pool.connect = deny as typeof pool.connect;
}

let lastWriteSuccessAt: Date | null = null;
let lastWriteFailureAt: Date | null = null;
let consecutiveWriteFailures = 0;

async function ingestionWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    const result = await retryIngestionWrite(write);
    lastWriteSuccessAt = new Date();
    consecutiveWriteFailures = 0;
    return result;
  } catch (error) {
    lastWriteFailureAt = new Date();
    consecutiveWriteFailures++;
    throw error;
  }
}

/** Process-local error evidence; no message, JID or database error is exposed. */
export function getIngestionWriteHealth() {
  return { lastWriteSuccessAt, lastWriteFailureAt, consecutiveWriteFailures };
}

/** Committed row high-water mark, not a lossless consumer cursor (identity values can have gaps). */
export async function getIngestionCursor(): Promise<{ maxSavedSeq: string | null; lastIngestedAt: Date | null }> {
  const result = await pool.query<{ max_saved_seq: string | null; last_ingested_at: Date | null }>(
    `SELECT
       (SELECT seq::text FROM wa_messages ORDER BY seq DESC LIMIT 1) AS max_saved_seq,
       (SELECT ingested_at FROM wa_messages WHERE ingested_at IS NOT NULL
        ORDER BY ingested_at DESC LIMIT 1) AS last_ingested_at`
  );
  return {
    maxSavedSeq: result.rows[0]?.max_saved_seq ?? null,
    lastIngestedAt: result.rows[0]?.last_ingested_at ?? null,
  };
}

export async function initDb() {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/db.js e src/db.ts ficam um nível abaixo da raiz do server, onde está o schema.sql
  const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf-8');
  await pool.query(schema);
  await pool.query(CONSENT_SCHEMA);
  await pool.query(SUMMARY_REQUEST_SCHEMA);
  await pool.query(VAULT_SCHEMA_SQL);
  await pool.query(PERSONAL_JUICE_SCHEMA);
  if (process.env.SUCO_GLM_REGULAR_KEY_FILE) await pool.query(LLM_SCHEMA);
}

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: boolean;
  tracked: boolean;
  archived: boolean;
  last_message_at: Date | null;
}

export interface MessageRow {
  /** BIGINT de inserção (gerado pelo Postgres); vem como string no driver. */
  seq?: string;
  chat_jid: string;
  id: string;
  sender_jid: string | null;
  sender_name: string | null;
  from_me: boolean;
  body: string | null;
  msg_type: string;
  ts: Date;
}

export async function upsertChat(jid: string, name: string | null, isGroup: boolean) {
  await ingestionWrite(() => pool.query(
    `INSERT INTO wa_chats (jid, name, is_group)
     VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, wa_chats.name),
       updated_at = now()`,
    [jid, name, isGroup]
  ));
}

/**
 * Grava contato preservando a hierarquia: `name` = nome da agenda, `notify` = pushName.
 * COALESCE garante que um pushName nunca apaga um nome de agenda já conhecido.
 */
export async function upsertContact(jid: string, opts: { name?: string | null; notify?: string | null }) {
  const name = opts.name || null;
  const notify = opts.notify || null;
  if (!name && !notify) return;
  await ingestionWrite(() => pool.query(
    `INSERT INTO wa_contacts (jid, name, notify) VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, wa_contacts.name),
       notify = COALESCE(EXCLUDED.notify, wa_contacts.notify),
       updated_at = now()`,
    [jid, name, notify]
  ));
}

/** Grava o mapeamento LID (@lid) -> número real (@s.whatsapp.net). */
export async function upsertLidMap(lid: string, pn: string) {
  if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
  await ingestionWrite(() => pool.query(
    `INSERT INTO wa_lid_map (lid, pn) VALUES ($1, $2)
     ON CONFLICT (lid) DO UPDATE SET pn = EXCLUDED.pn, updated_at = now()`,
    [lid, pn]
  ));
}

export async function insertMessage(m: MessageRow) {
  await ingestionWrite(() => pool.query(
    `INSERT INTO wa_messages (chat_jid, id, sender_jid, sender_name, from_me, body, msg_type, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (chat_jid, id) DO NOTHING`,
    [m.chat_jid, m.id, m.sender_jid, m.sender_name, m.from_me, m.body, m.msg_type, m.ts]
  ));
}
