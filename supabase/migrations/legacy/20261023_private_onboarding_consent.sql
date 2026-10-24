-- Consent is commercial/account metadata only. Conversation content remains
-- in the measured private worker. A verified, active user can accept only for
-- their own account; no direct table privileges are added.
alter table suco_control.accounts
  add column if not exists consent_version text,
  add column if not exists consented_at timestamptz;

create or replace function public.suco_consent_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row suco_control.accounts%rowtype;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  select * into v_row from suco_control.accounts
    where user_id = v_uid and private_state = 'active';
  if not found then
    raise exception 'PRIVATE_ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  if v_row.consent_version is null or v_row.consented_at is null then
    return pg_catalog.jsonb_build_object('consent', null);
  end if;
  return pg_catalog.jsonb_build_object('consent',
    pg_catalog.jsonb_build_object('version', v_row.consent_version,
      'acceptedAt', v_row.consented_at));
end;
$$;

create or replace function public.suco_consent_accept(p_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row suco_control.accounts%rowtype;
begin
  v_uid := public.suco_verified_uid();
  if v_uid is null then
    raise exception 'VERIFIED_EMAIL_REQUIRED' using errcode = '28000';
  end if;
  if p_version is distinct from 'readonly-2026-10-15' then
    raise exception 'CONSENT_VERSION_INVALID' using errcode = '22023';
  end if;
  update suco_control.accounts set
    consent_version = p_version,
    consented_at = case when consent_version = p_version and consented_at is not null
      then consented_at else now() end
  where user_id = v_uid and private_state = 'active'
  returning * into v_row;
  if not found then
    raise exception 'PRIVATE_ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('consent',
    pg_catalog.jsonb_build_object('version', v_row.consent_version,
      'acceptedAt', v_row.consented_at));
end;
$$;

revoke all on function public.suco_consent_status() from public, anon, service_role;
revoke all on function public.suco_consent_accept(text) from public, anon, service_role;
grant execute on function public.suco_consent_status() to authenticated;
grant execute on function public.suco_consent_accept(text) to authenticated;
