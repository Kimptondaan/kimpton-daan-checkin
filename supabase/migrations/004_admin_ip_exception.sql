-- 004_admin_ip_exception.sql
-- Bind the IP exception to the one active ADMIN employee account, never to
-- every profile whose role happens to be admin. This migration is additive and
-- does not delete tables or attendance/configuration history.

begin;

-- Track whether the boolean column is genuinely new in this migration. That
-- lets the initial seed happen once without re-enabling a manually disabled
-- exception when this migration is run again.
do $$
declare
  added_admin_ip_exempt boolean := false;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'system_settings'
      and column_name = 'admin_ip_exempt'
  ) then
    alter table public.system_settings
      add column admin_ip_exempt boolean not null default false;
    added_admin_ip_exempt := true;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'system_settings'
      and column_name = 'admin_exempt_profile_id'
  ) then
    alter table public.system_settings
      add column admin_exempt_profile_id uuid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'system_settings_admin_exempt_profile_id_fkey'
      and conrelid = 'public.system_settings'::regclass
  ) then
    alter table public.system_settings
      add constraint system_settings_admin_exempt_profile_id_fkey
      foreign key (admin_exempt_profile_id)
      references public.profiles(id)
      on delete set null;
  end if;

  -- Only a newly-added boolean column is eligible for the one-time automatic
  -- seed. If no matching ADMIN exists, the default false is retained.
  if added_admin_ip_exempt then
    update public.system_settings s
    set admin_exempt_profile_id = candidate.id,
        admin_ip_exempt = true,
        updated_at = now()
    from (
      select p.id
      from public.profiles p
      where upper(trim(p.employee_no)) = 'ADMIN'
        and p.role = 'admin'
        and p.is_active = true
      order by p.created_at, p.id
      limit 1
    ) candidate
    where s.id = 1
      and s.admin_exempt_profile_id is null;
  end if;
end
$$;

-- Shared, service-only decision used by both diagnostics and punching. The
-- internal actor/profile and matched-network fields are stripped by the public
-- status RPC but remain available to management_punch.
create or replace function public.management_network_decision(
  p_actor_uuid uuid,
  p_client_ip inet
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  settings public.system_settings;
  matched_network_id bigint;
  admin_exempt boolean;
begin
  actor := public.management_actor(
    p_actor_uuid,
    array['employee', 'manager', 'hr', 'it', 'admin']::public.user_role[]
  );

  -- Both locks are held until the surrounding RPC transaction completes.
  select s.* into settings
  from public.system_settings s
  where s.id = 1
  for update;
  if not found then
    raise exception using message = '公司網路設定尚未完成';
  end if;

  if p_client_ip is not null then
    select n.id into matched_network_id
    from public.allowed_networks n
    where n.is_active = true
      and p_client_ip <<= n.network
    order by masklen(n.network) desc, n.id desc
    limit 1;
  end if;

  admin_exempt := coalesce(settings.admin_ip_exempt, false)
    and actor.role = 'admin'
    and actor.is_active = true
    and settings.admin_exempt_profile_id is not null
    and actor.id = settings.admin_exempt_profile_id;

  return jsonb_build_object(
    'ok', true,
    'canPunch', settings.network_mode <> 'strict'
      or matched_network_id is not null
      or admin_exempt,
    'adminExempt', admin_exempt,
    'mode', settings.network_mode,
    'observedIp', p_client_ip,
    'actorId', actor.id,
    'matchedNetworkId', matched_network_id
  );
end;
$$;

create or replace function public.management_network_status(
  p_actor_uuid uuid,
  p_client_ip inet
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  decision jsonb;
begin
  decision := public.management_network_decision(p_actor_uuid, p_client_ip);
  return jsonb_build_object(
    'ok', true,
    'canPunch', decision -> 'canPunch',
    'adminExempt', decision -> 'adminExempt',
    'mode', decision -> 'mode',
    'observedIp', decision -> 'observedIp'
  );
end;
$$;

-- Keep the existing management_punch signature. Its server-side timestamp,
-- type validation, actor lock and singleton settings lock remain authoritative;
-- the shared decision supplies the exact same network/exception result as the
-- diagnostic RPC.
create or replace function public.management_punch(
  p_actor_uuid uuid,
  p_attendance_type text,
  p_punched_at timestamptz,
  p_client_ip inet default null,
  p_user_agent text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  decision jsonb;
  actor_id uuid;
  matched_network_id bigint;
  admin_exempt boolean;
  can_punch boolean;
  normalized_type public.attendance_type;
  new_record public.attendance_records;
begin
  begin
    normalized_type := p_attendance_type::public.attendance_type;
  exception when invalid_text_representation then
    raise exception using message = '刷卡類型不正確';
  end;
  if p_punched_at is null then
    raise exception using message = '刷卡時間不正確';
  end if;

  decision := public.management_network_decision(p_actor_uuid, p_client_ip);
  actor_id := (decision ->> 'actorId')::uuid;
  matched_network_id := (decision ->> 'matchedNetworkId')::bigint;
  admin_exempt := coalesce((decision ->> 'adminExempt')::boolean, false);
  can_punch := coalesce((decision ->> 'canPunch')::boolean, false);

  if not can_punch then
    raise exception using message = '目前不在允許的公司網路';
  end if;

  insert into public.attendance_records (
    employee_id, attendance_type, punched_at, client_ip, matched_network_id,
    user_agent, status, note
  ) values (
    actor_id, normalized_type, p_punched_at, p_client_ip, matched_network_id,
    left(coalesce(p_user_agent, ''), 512), 'accepted',
    case when admin_exempt and matched_network_id is null then 'ADMIN_IP_EXEMPT' else null end
  ) returning * into new_record;
  return jsonb_build_object('ok', true, 'id', new_record.id);
end;
$$;

-- The old management_save_network remains available and unchanged. This
-- wrapper invokes it in the same transaction, then updates only the new
-- exception setting. A null flag preserves the existing value.
create or replace function public.management_save_network_v2(
  p_actor_uuid uuid,
  p_mode text,
  p_allowed_ips text[] default '{}',
  p_admin_ip_exempt boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  network_result jsonb;
  actor public.profiles;
  settings public.system_settings;
  bound_admin public.profiles;
  before_data jsonb;
  after_data jsonb;
  next_admin_ip_exempt boolean;
begin
  -- The legacy function validates and locks an enabled admin actor, parses all
  -- CIDRs, updates append-only network history, and writes its network audit.
  network_result := public.management_save_network(
    p_actor_uuid,
    p_mode,
    p_allowed_ips
  );

  -- Re-check the actor as admin for this wrapper and lock the singleton before
  -- changing the exception binding. The old call and this update are one SQL
  -- transaction, so a failed binding rolls back the network change too.
  actor := public.management_actor(
    p_actor_uuid,
    array['admin']::public.user_role[]
  );
  select s.* into settings
  from public.system_settings s
  where s.id = 1
  for update;
  if not found then
    raise exception using message = '公司網路設定尚未完成';
  end if;

  before_data := jsonb_build_object(
    'adminIpExempt', coalesce(settings.admin_ip_exempt, false),
    'adminExemptProfileId', settings.admin_exempt_profile_id
  );
  next_admin_ip_exempt := case
    when p_admin_ip_exempt is null then coalesce(settings.admin_ip_exempt, false)
    else p_admin_ip_exempt
  end;

  if p_admin_ip_exempt is true then
    -- Keep an existing UUID binding even if the original account is renumbered.
    -- Do not lock a second profile after the settings row: its punch may already
    -- hold that profile and be waiting for settings. Punching rechecks role/active.
    if settings.admin_exempt_profile_id is not null then
      select p.* into bound_admin
      from public.profiles p
      where p.id = settings.admin_exempt_profile_id;
      if not found
        or bound_admin.role <> 'admin'
        or not bound_admin.is_active then
        raise exception using message = '指定的 ADMIN 帳號已停用或不具 admin 權限，無法啟用 IP 例外';
      end if;
    else
      select p.* into bound_admin
      from public.profiles p
      where upper(trim(p.employee_no)) = 'ADMIN'
        and p.role = 'admin'
        and p.is_active = true
      order by p.created_at, p.id
      limit 1;
    end if;

    if bound_admin.id is null then
      raise exception using message = '找不到啟用中的 ADMIN 帳號，無法啟用 IP 例外';
    end if;
  end if;

  update public.system_settings
  set admin_ip_exempt = next_admin_ip_exempt,
      admin_exempt_profile_id = case
        when p_admin_ip_exempt is true then bound_admin.id
        else settings.admin_exempt_profile_id
      end,
      updated_at = now()
  where id = 1;

  after_data := jsonb_build_object(
    'adminIpExempt', next_admin_ip_exempt,
    'adminExemptProfileId', case
      when p_admin_ip_exempt is true then bound_admin.id
      else settings.admin_exempt_profile_id
    end
  );
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    actor.id,
    'network.admin_ip_exempt',
    null,
    before_data,
    after_data
  );

  return jsonb_build_object(
    'ok', true,
    'mode', network_result -> 'mode',
    'allowedIps', network_result -> 'allowedIps',
    'adminIpExempt', next_admin_ip_exempt
  );
end;
$$;

-- Management functions are not callable by browser roles. The internal
-- decision helper is not callable by service_role directly either; it is used
-- only by the two SECURITY DEFINER RPCs above.
revoke all on function public.management_network_decision(uuid, inet)
  from public, anon, authenticated, service_role;
revoke all on function public.management_network_status(uuid, inet)
  from public, anon, authenticated;
revoke all on function public.management_save_network_v2(uuid, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.management_network_status(uuid, inet) to service_role;
grant execute on function public.management_save_network_v2(uuid, text, text[], boolean) to service_role;

commit;
