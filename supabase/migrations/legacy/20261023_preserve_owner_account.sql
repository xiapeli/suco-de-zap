-- TEMPLATE: e-mails, UUIDs e hashes abaixo são placeholders. Troque pelas identidades reais do seu deployment antes de aplicar.
-- The owner clarified that the existing account and history must be retained.
-- Cancel the fresh-start request without deleting its audit record or backup.
alter table suco_control.reset_intents
  drop constraint if exists reset_intents_state_check;
alter table suco_control.reset_intents
  add constraint reset_intents_state_check
  check (state in ('pending_private_runtime', 'cancelled_preserve_identity'));
alter table suco_control.reset_intents
  add column if not exists cancelled_at timestamptz;

update suco_control.reset_intents
set state = 'cancelled_preserve_identity', cancelled_at = coalesce(cancelled_at, now())
where email = 'owner@example.com' and state = 'pending_private_runtime';

do $$
begin
  if (select count(*) from suco_control.reset_intents
      where email = 'owner@example.com'
        and state = 'cancelled_preserve_identity'
        and cancelled_at is not null) <> 1 then
    raise exception 'OWNER_PRESERVATION_INTENT_MISSING';
  end if;
end;
$$;

create or replace function public.suco_account_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_email text;
  v_legacy_source text;
  v_legacy_matches integer;
  v_reset boolean;
  v_account suco_control.accounts%rowtype;
  v_mode text;
  v_capacity integer;
  v_tier text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  select lower(u.email) into v_email
  from auth.users as u
  where u.id = v_user_id
    and u.email is not null
    and u.email_confirmed_at is not null
    and u.is_anonymous = false;
  if v_email is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;

  select exists(select 1 from suco_control.reset_intents
    where email = v_email and state = 'pending_private_runtime') into v_reset;
  select count(*)::integer, min(a.source_id)
    into v_legacy_matches, v_legacy_source
  from suco_migration.legacy_users as u
  join suco_migration.legacy_accounts as a
    on pg_catalog.regexp_replace(a.identity, '^.*\|', '') = u.source_id
  where u.email = v_email and u.email_verified_at is not null
    and not v_reset;
  if v_legacy_matches > 1 then
    raise exception 'LEGACY_LINK_AMBIGUOUS' using errcode = '23505';
  end if;

  insert into suco_control.accounts(user_id, legacy_account_source_id)
  values (v_user_id, v_legacy_source)
  on conflict (user_id) do nothing;
  select * into strict v_account from suco_control.accounts where user_id = v_user_id;
  select mode, tenant_capacity into strict v_mode, v_capacity
    from suco_control.admission where singleton = true;
  select tier into v_tier from suco_control.email_grants
    where email = v_email and enabled = true;

  return pg_catalog.jsonb_build_object(
    'accountId', v_account.user_id,
    'email', v_email,
    'entitlement', coalesce(v_tier, 'free'),
    'legacyLinked', v_account.legacy_account_source_id is not null,
    'resetPending', v_reset,
    'privateState', v_account.private_state,
    'admissionMode', v_mode,
    'tenantCapacity', v_capacity
  );
end;
$$;
revoke all on function public.suco_account_status() from public, anon, service_role;
grant execute on function public.suco_account_status() to authenticated;
