-- TEMPLATE: e-mails, UUIDs e hashes abaixo são placeholders. Troque pelas identidades reais do seu deployment antes de aplicar.
-- Reserve the two real partner identities. Entitlement is commercial only;
-- private processing still requires a verified user and a private runtime.
do $$
begin
  if (select count(*) from auth.users where
      (id = '00000000-0000-4000-8000-000000000001'::uuid
       and lower(email) = 'partner@example.com') or
      (id = '00000000-0000-4000-8000-000000000002'::uuid
       and lower(email) = 'owner@example.com')) <> 2 then
    raise exception 'PARTNER_IDENTITIES_MISMATCH';
  end if;
  if (select count(*) from suco_migration.legacy_users as u
      join suco_migration.legacy_accounts as a
        on pg_catalog.regexp_replace(a.identity, '^.*\|', '') = u.source_id
      where u.email = 'owner@example.com'
        and u.email_verified_at is not null) <> 1 then
    raise exception 'OWNER_LEGACY_LINK_AMBIGUOUS';
  end if;
end;
$$;

alter table suco_control.email_grants
  drop constraint if exists email_grants_enabled_check;
alter table suco_control.email_grants
  add constraint email_grants_enabled_check
  check (enabled = false or
    (email = 'partner@example.com' and tier = 'partner_full') or
    (email = 'owner@example.com' and tier = 'owner'));

update suco_control.email_grants set enabled = true
where (email = 'partner@example.com' and tier = 'partner_full')
   or (email = 'owner@example.com' and tier = 'owner');

insert into suco_control.accounts(user_id, legacy_account_source_id)
select u.id, null from auth.users as u
where u.id = '00000000-0000-4000-8000-000000000001'::uuid
  and lower(u.email) = 'partner@example.com'
on conflict (user_id) do nothing;

insert into suco_control.accounts(user_id, legacy_account_source_id)
select u.id, a.source_id
from auth.users as u
join suco_migration.legacy_users as lu
  on lu.email = lower(u.email) and lu.email_verified_at is not null
join suco_migration.legacy_accounts as a
  on pg_catalog.regexp_replace(a.identity, '^.*\|', '') = lu.source_id
where u.id = '00000000-0000-4000-8000-000000000002'::uuid
  and lower(u.email) = 'owner@example.com'
on conflict (user_id) do nothing;

do $$
begin
  if (select count(*) from suco_control.accounts where user_id in
      ('00000000-0000-4000-8000-000000000001'::uuid,
       '00000000-0000-4000-8000-000000000002'::uuid)) <> 2
    or (select count(*) from suco_control.accounts
        where user_id = '00000000-0000-4000-8000-000000000002'::uuid
          and legacy_account_source_id is not null) <> 1
    or (select count(*) from suco_control.email_grants where enabled) <> 2 then
    raise exception 'PARTNER_BOOTSTRAP_INCOMPLETE';
  end if;
end;
$$;
