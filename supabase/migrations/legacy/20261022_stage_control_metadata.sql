-- Internal landing zone for commercial metadata only. Never put content,
-- WhatsApp credentials, calendar OAuth tokens, or user keys in this schema.
create schema if not exists suco_migration authorization postgres;
revoke all on schema suco_migration from public, anon, authenticated;

create table if not exists suco_migration.snapshots (
  sha256 text primary key check (sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  account_count integer not null check (account_count >= 0),
  user_count integer not null check (user_count >= 0),
  binding_count integer not null check (binding_count >= 0),
  job_count integer not null check (job_count >= 0)
);

create table if not exists suco_migration.legacy_users (
  source_id text primary key check (length(source_id) between 8 and 128),
  email text not null check (length(email) between 3 and 254),
  email_verified_at timestamptz,
  snapshot_sha256 text not null references suco_migration.snapshots(sha256)
);

create table if not exists suco_migration.legacy_accounts (
  source_id text primary key check (length(source_id) between 8 and 128),
  identity text not null unique check (length(identity) between 8 and 512),
  created_at timestamptz not null,
  consent_version text,
  consented_at timestamptz,
  timezone text,
  summary_hour smallint check (summary_hour between 0 and 23),
  connection text not null check (connection in (
    'connecting','reconnecting','action_required','qr_required',
    'unprovisioned','disconnected','qr','syncing','connected')),
  connection_at timestamptz,
  first_summary_at timestamptz,
  billing_fence integer not null check (billing_fence >= 0),
  checkout_generation integer not null check (checkout_generation >= 0),
  worker_sequence integer,
  snapshot_sha256 text not null references suco_migration.snapshots(sha256)
);

create table if not exists suco_migration.legacy_worker_bindings (
  source_id text primary key check (length(source_id) between 8 and 128),
  account_source_id text not null references suco_migration.legacy_accounts(source_id),
  tenant_id text not null unique check (length(tenant_id) between 8 and 128),
  api_url text,
  ready_at timestamptz,
  snapshot_sha256 text not null references suco_migration.snapshots(sha256)
);

create table if not exists suco_migration.legacy_provision_jobs (
  source_id text primary key check (length(source_id) between 8 and 128),
  account_source_id text not null references suco_migration.legacy_accounts(source_id),
  tenant_id text not null check (length(tenant_id) between 8 and 128),
  requested_at timestamptz not null,
  status text not null check (status in ('queued','leased','ready','blocked')),
  reserved boolean not null,
  snapshot_sha256 text not null references suco_migration.snapshots(sha256)
);

alter table suco_migration.snapshots enable row level security;
alter table suco_migration.legacy_users enable row level security;
alter table suco_migration.legacy_accounts enable row level security;
alter table suco_migration.legacy_worker_bindings enable row level security;
alter table suco_migration.legacy_provision_jobs enable row level security;
alter table suco_migration.snapshots force row level security;
alter table suco_migration.legacy_users force row level security;
alter table suco_migration.legacy_accounts force row level security;
alter table suco_migration.legacy_worker_bindings force row level security;
alter table suco_migration.legacy_provision_jobs force row level security;
revoke all on all tables in schema suco_migration from public, anon, authenticated;
