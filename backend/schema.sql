CREATE TABLE IF NOT EXISTS wa_chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group BOOLEAN NOT NULL DEFAULT FALSE,
  tracked BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,          -- nome salvo na agenda (contactAction / history sync)
  notify TEXT,        -- pushName (nome que a pessoa definiu no próprio WhatsApp)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migração para bancos criados antes da coluna notify
ALTER TABLE wa_contacts ADD COLUMN IF NOT EXISTS notify TEXT;

-- mapeamento LID (identificador oculto @lid) -> número real (@s.whatsapp.net)
CREATE TABLE IF NOT EXISTS wa_lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_messages (
  chat_jid TEXT NOT NULL REFERENCES wa_chats(jid) ON DELETE CASCADE,
  id TEXT NOT NULL,
  sender_jid TEXT,
  sender_name TEXT,
  from_me BOOLEAN NOT NULL DEFAULT FALSE,
  body TEXT,
  msg_type TEXT NOT NULL DEFAULT 'text',
  ts TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chat_jid, id)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_ts ON wa_messages (chat_jid, ts);

-- A list timestamp advances only when its message was actually committed.
-- The chat row is created by the ingestion path before the FK insert.
CREATE OR REPLACE FUNCTION wa_message_inserted_update_chat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wa_chats
     SET last_message_at = GREATEST(last_message_at, NEW.ts),
         updated_at = now()
   WHERE jid = NEW.chat_jid;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_wa_message_inserted_update_chat ON wa_messages;
CREATE TRIGGER trg_wa_message_inserted_update_chat
AFTER INSERT ON wa_messages
FOR EACH ROW EXECUTE FUNCTION wa_message_inserted_update_chat();

-- lista de espera capturada pela landing page (Fase 0 do GTM)
CREATE TABLE IF NOT EXISTS waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  profession TEXT,
  whatsapp TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_jid TEXT,
  chat_name TEXT,
  title TEXT,
  analysis_type TEXT NOT NULL DEFAULT 'general',
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  content TEXT NOT NULL,
  model TEXT,
  auto BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_summaries_chat ON summaries (chat_jid, created_at DESC);

-- ===== v2: Digest diário + Índice inteligente (Cofre) — ver API-CONTRACT-V2.md =====

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- categorias e permissões de extração (semeadas abaixo; DO NOTHING preserva escolhas do usuário)
CREATE TABLE IF NOT EXISTS extraction_settings (
  kind TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pointer_only BOOLEAN NOT NULL DEFAULT FALSE,
  label TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO extraction_settings (kind, enabled, pointer_only, label) VALUES
  ('email',      TRUE,  FALSE, 'E-mails'),
  ('phone',      TRUE,  FALSE, 'Telefones'),
  ('url',        TRUE,  FALSE, 'Links'),
  ('address',    TRUE,  FALSE, 'Endereços'),
  ('document',   TRUE,  FALSE, 'Documentos (CPF/CNPJ)'),
  ('pix',        TRUE,  FALSE, 'Chaves Pix'),
  ('order',      TRUE,  FALSE, 'Pedidos e compras'),
  ('event',      TRUE,  FALSE, 'Datas e compromissos'),
  ('credential', TRUE,  TRUE,  'Credenciais e senhas'),
  ('payment',    TRUE,  TRUE,  'Cartões e pagamento'),
  ('other',      FALSE, FALSE, 'Outros')
ON CONFLICT (kind) DO NOTHING;

-- índice inteligente; value é NULL para categorias pointer_only (regra de código, não flag)
CREATE TABLE IF NOT EXISTS facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_jid TEXT NOT NULL,
  chat_name TEXT,
  message_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL REFERENCES extraction_settings(kind),
  label TEXT NOT NULL,
  value TEXT,
  context TEXT,
  sender_name TEXT,
  sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  confidence REAL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  ts TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migração para bancos criados antes das tags automáticas (subcategorias
-- geradas pelo LLM, ex.: url → "invite"/"site"/"video")
ALTER TABLE facts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE UNIQUE INDEX IF NOT EXISTS uq_facts_dedup
  ON facts (chat_jid, message_id, kind, COALESCE(value, ''), label);
CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts (kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_facts_label_trgm ON facts USING gin (label gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_facts_value_trgm ON facts USING gin (value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts USING gin (tags);

-- ponteiro de extração incremental por chat
CREATE TABLE IF NOT EXISTS extraction_cursor (
  chat_jid TEXT PRIMARY KEY,
  last_ts TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- digest diário consolidado (um por dia)
CREATE TABLE IF NOT EXISTS digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL UNIQUE,
  content TEXT NOT NULL,
  stats JSONB,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- busca inteligente: full-text português + trigram nas mensagens
CREATE INDEX IF NOT EXISTS idx_wa_messages_fts
  ON wa_messages USING gin (to_tsvector('portuguese', COALESCE(body, '')));
CREATE INDEX IF NOT EXISTS idx_wa_messages_body_trgm
  ON wa_messages USING gin (body gin_trgm_ops);

-- cursor de extração por ordem de INSERÇÃO: ts do WhatsApp tem resolução de segundo
-- (rajadas empatam) e o history sync entrega mensagens antigas fora de ordem — cursor
-- por ts pula mensagens nos dois casos.
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat_seq ON wa_messages (chat_jid, seq);
CREATE INDEX IF NOT EXISTS idx_wa_messages_seq_desc ON wa_messages (seq DESC);
-- Only newly ingested rows receive this timestamp. Historic rows remain NULL,
-- so reconnecting cannot make old WhatsApp timestamps look like live delivery.
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;
ALTER TABLE wa_messages ALTER COLUMN ingested_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_wa_messages_ingested_at
  ON wa_messages (ingested_at DESC) WHERE ingested_at IS NOT NULL;
ALTER TABLE extraction_cursor ADD COLUMN IF NOT EXISTS last_seq BIGINT NOT NULL DEFAULT 0;
-- migra cursores antigos baseados em ts (aproximação; o dedup de facts segura repetições)
UPDATE extraction_cursor ec
  SET last_seq = COALESCE((SELECT MAX(m.seq) FROM wa_messages m
                           WHERE m.chat_jid = ec.chat_jid AND m.ts <= ec.last_ts), 0)
  WHERE ec.last_seq = 0 AND ec.last_ts > '1970-01-02';
