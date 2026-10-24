-- Global release gate and per-account activation are both required for every
-- ciphertext mutation. Applying this migration does not activate any account
-- and does not turn on the global write switch.
alter table suco_control.accounts
  drop constraint if exists accounts_private_state_check;
alter table suco_control.accounts
  add constraint accounts_private_state_check
  check (private_state in ('private_setup_pending', 'active', 'suspended'));

create or replace function suco_control.require_private_write(p_verified_uid uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_state text;
begin
  if p_verified_uid is null or p_verified_uid is distinct from public.suco_verified_uid() then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  -- Row locks serialize the decision with a concurrent gate/state change.
  select g.writes_enabled into v_enabled
    from suco_control.private_storage_gate as g
   where g.singleton = true for share;
  if v_enabled is distinct from true then
    raise exception 'PRIVATE_STORAGE_DISABLED' using errcode = '55000';
  end if;
  select a.private_state into v_state
    from suco_control.accounts as a
   where a.user_id = p_verified_uid for share;
  if v_state is distinct from 'active' then
    raise exception 'PRIVATE_ACCOUNT_INACTIVE' using errcode = '55000';
  end if;
end;
$$;
revoke all on function suco_control.require_private_write(uuid)
  from public, anon, authenticated, service_role;

-- Recreate the existing security-definer RPCs from their catalog definitions,
-- replacing only their old global-gate stanza. This preserves validated input,
-- idempotency, ownership, privileges and output contracts. Fail closed if any
-- expected function or stanza differs from the reviewed source.
do $$
declare
  v_signature text;
  v_oid oid;
  v_definition text;
  v_replaced text;
  v_old_gate constant text :=
    'select[[:space:]]+writes_enabled[[:space:]]+into[[:space:]]+strict[[:space:]]+v_enabled[[:space:]]+from[[:space:]]+suco_control[.]private_storage_gate[[:space:]]+where[[:space:]]+singleton[[:space:]]*=[[:space:]]*true;[[:space:]]+if[[:space:]]+not[[:space:]]+v_enabled[[:space:]]+then[[:space:]]+raise[[:space:]]+exception[[:space:]]+''PRIVATE_STORAGE_DISABLED''[[:space:]]+using[[:space:]]+errcode[[:space:]]*=[[:space:]]*''55000'';[[:space:]]+end[[:space:]]+if;';
begin
  foreach v_signature in array array[
    'public.suco_auth_cas(bigint,text)',
    'public.suco_auth_archive(bigint,text)',
    'public.suco_ingestion_stage(uuid,integer,text,text)',
    'public.suco_ingestion_ack(uuid,bigint)',
    'public.suco_message_commit(uuid,integer,text,text)',
    'public.suco_meta_put(uuid,bigint,integer,text,text)',
    'public.suco_cipher_put(uuid,bigint,integer,bytea,bytea)'
  ] loop
    v_oid := pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then
      raise exception 'PRIVATE_WRITE_RPC_MISSING';
    end if;
    v_definition := pg_catalog.pg_get_functiondef(v_oid);
    if pg_catalog.strpos(v_definition, 'perform suco_control.require_private_write(v_uid);') > 0 then
      continue;
    end if;
    v_replaced := pg_catalog.regexp_replace(v_definition, v_old_gate,
      'perform suco_control.require_private_write(v_uid);', 'i');
    if v_replaced = v_definition or
       pg_catalog.strpos(v_replaced, 'select writes_enabled into strict v_enabled') > 0 then
      raise exception 'PRIVATE_WRITE_RPC_UNEXPECTED';
    end if;
    execute v_replaced;
  end loop;
end;
$$;
