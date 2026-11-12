-- 003_cloud_management.sql
-- Server-only management boundary for the Netlify attendance API.
-- Apply after 001_initial_schema.sql and 002_server_only_writes.sql.

begin;

create extension if not exists pgcrypto;

-- Keep the original text column for backward compatibility, but use the stable
-- profile FK for all new department manager assignments.
alter table public.departments
  add column if not exists manager_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'departments_manager_id_fkey'
      and conrelid = 'public.departments'::regclass
  ) then
    alter table public.departments
      add constraint departments_manager_id_fkey
      foreign key (manager_id) references public.profiles(id) on delete set null;
  end if;
end $$;

create index if not exists departments_manager_id_idx on public.departments (manager_id);

-- Best-effort migration of an old manager_name to the stable FK. Ambiguous names
-- are intentionally left unset rather than assigning the wrong employee.
update public.departments d
set manager_id = p.id
from public.profiles p
where d.manager_id is null
  and nullif(trim(d.manager_name), '') is not null
  and p.full_name = d.manager_name
  and not exists (
    select 1 from public.profiles p2
    where p2.full_name = d.manager_name and p2.id <> p.id
  );

create table if not exists public.system_settings (
  id integer primary key check (id = 1),
  network_mode text not null default 'test' check (network_mode in ('test', 'strict')),
  updated_at timestamptz not null default now()
);

insert into public.system_settings (id, network_mode)
values (1, 'test')
on conflict (id) do nothing;

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  before_data jsonb,
  after_data jsonb
);

create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);
create index if not exists audit_log_actor_id_idx on public.audit_log (actor_id, created_at desc);

-- allowed_networks is append-only configuration history. Existing attendance
-- rows retain a valid matched_network_id forever; new configuration only marks
-- old rows inactive and appends the new current set.
create or replace function public.prevent_allowed_network_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using message = 'allowed_networks 歷史資料不可刪除';
end;
$$;

drop trigger if exists allowed_networks_no_delete on public.allowed_networks;
create trigger allowed_networks_no_delete
before delete on public.allowed_networks
for each row execute function public.prevent_allowed_network_delete();

-- Only active identities are eligible for RLS reads. The management API uses a
-- service-role client and performs the same scope checks explicitly.
create or replace function public.current_profile()
returns public.profiles
language sql stable security definer set search_path = public, pg_temp
as $$
  select p.* from public.profiles p
  where p.id = auth.uid() and p.is_active = true
  limit 1
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql stable security definer set search_path = public, pg_temp
as $$
  select p.role from public.profiles p
  where p.id = auth.uid() and p.is_active = true
$$;

create or replace function public.current_department_id()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select p.department_id from public.profiles p
  where p.id = auth.uid() and p.is_active = true
$$;

-- No browser writes. RLS is retained as a second boundary for reads.
revoke all on public.departments, public.profiles, public.allowed_networks,
  public.attendance_records, public.system_settings, public.audit_log
  from public, anon, authenticated;
grant select on public.departments, public.profiles, public.attendance_records to authenticated;
grant all on public.departments, public.profiles, public.allowed_networks,
  public.attendance_records, public.system_settings, public.audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.allowed_networks enable row level security;
alter table public.attendance_records enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "Authenticated users can view departments" on public.departments;
drop policy if exists "Users can view permitted departments" on public.departments;
create policy "Users can view permitted departments" on public.departments
for select to authenticated using (
  public.current_user_role() is not null
  and is_active = true
  and (
    public.current_user_role() in ('admin', 'hr')
    or id = public.current_department_id()
  )
);

drop policy if exists "Admin can manage departments" on public.departments;
drop policy if exists "HR and IT can manage departments" on public.departments;

drop policy if exists "Users can view permitted profiles" on public.profiles;
create policy "Users can view permitted profiles" on public.profiles
for select to authenticated using (
  public.current_user_role() is not null
  and (
    id = auth.uid()
    or public.current_user_role() in ('admin', 'hr')
    or (
      public.current_user_role() = 'manager'
      and department_id = public.current_department_id()
    )
  )
);

drop policy if exists "Admin can manage profiles" on public.profiles;
drop policy if exists "HR and IT can manage profiles" on public.profiles;

drop policy if exists "Users can view allowed networks" on public.allowed_networks;
drop policy if exists "Admin can manage allowed networks" on public.allowed_networks;

-- Network configuration is never exposed through browser table reads.

 drop policy if exists "Users can view permitted attendance" on public.attendance_records;
create policy "Users can view permitted attendance" on public.attendance_records
for select to authenticated using (
  public.current_user_role() is not null
  and (
    employee_id = auth.uid()
    or public.current_user_role() in ('admin', 'hr', 'it')
    or (
      public.current_user_role() = 'manager'
      and exists (
        select 1 from public.profiles p
        where p.id = attendance_records.employee_id
          and p.is_active = true
          and p.department_id = public.current_department_id()
      )
    )
  )
);

drop policy if exists "Users can create their own attendance" on public.attendance_records;
drop policy if exists "Admin can create attendance" on public.attendance_records;
drop policy if exists "Admin can update attendance" on public.attendance_records;

-- These helpers remain read-only helpers for RLS and are not management RPCs.
revoke all on function public.current_profile() from public, anon;
revoke all on function public.current_user_role() from public, anon;
revoke all on function public.current_department_id() from public, anon;
grant execute on function public.current_profile() to authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_department_id() to authenticated;

create or replace function public.find_network_for_ip(input_ip inet)
returns public.allowed_networks
language sql stable security definer set search_path = public, pg_temp
as $$
  select n.* from public.allowed_networks n
  where n.is_active = true and input_ip <<= n.network
  order by masklen(n.network) desc, n.id desc
  limit 1
$$;
revoke all on function public.find_network_for_ip(inet) from public, anon, authenticated;
grant execute on function public.find_network_for_ip(inet) to service_role;

-- Common active-actor check used by every server-only transaction function.
create or replace function public.management_actor(
  p_actor_uuid uuid,
  p_allowed_roles public.user_role[]
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
begin
  select p.* into actor
  from public.profiles p
  where p.id = p_actor_uuid
    and p.is_active = true
    and p.role = any(p_allowed_roles)
  for update;
  if not found then
    raise exception using message = '操作權限不足或帳號已停用';
  end if;
  return actor;
end;
$$;

create or replace function public.management_audit(
  p_actor_uuid uuid,
  p_action text,
  p_target_uuid uuid default null,
  p_before jsonb default null,
  p_after jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.management_actor(
    p_actor_uuid,
    array['employee', 'manager', 'hr', 'it', 'admin']::public.user_role[]
  );
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (p_actor_uuid, left(trim(p_action), 120), p_target_uuid, p_before, p_after);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.management_create_profile(
  p_actor_uuid uuid,
  p_profile_uuid uuid,
  p_employee_no text,
  p_full_name text,
  p_department_code text,
  p_job_title text,
  p_role text,
  p_batch boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  department public.departments;
  normalized_no text := upper(trim(coalesce(p_employee_no, '')));
  normalized_name text := trim(coalesce(p_full_name, ''));
  normalized_title text := trim(coalesce(p_job_title, ''));
  new_role public.user_role;
  created public.profiles;
begin
  actor := public.management_actor(
    p_actor_uuid,
    array['admin', 'hr', 'it']::public.user_role[]
  );
  if not p_batch and actor.role not in ('admin', 'hr') then
    raise exception using message = '此角色不可新增員工';
  end if;
  if actor.role = 'it' and lower(trim(coalesce(p_role, 'employee'))) <> 'employee' then
    raise exception using message = 'IT 匯入只能建立一般員工帳號';
  end if;
  if actor.role in ('hr', 'it') and lower(trim(coalesce(p_role, ''))) = 'admin' then
    raise exception using message = '人資與 IT 不可建立 Admin 帳號';
  end if;
  begin
    new_role := lower(trim(coalesce(p_role, 'employee')))::public.user_role;
  exception when invalid_text_representation then
    raise exception using message = '系統權限不正確';
  end;
  if normalized_no = '' or length(normalized_no) > 64 or normalized_no !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception using message = '員工編號格式不正確';
  end if;
  if normalized_name = '' or length(normalized_name) > 120 then
    raise exception using message = '員工姓名格式不正確';
  end if;
  select d.* into department
  from public.departments d
  where upper(d.code) = upper(trim(coalesce(p_department_code, '')))
    and d.is_active = true;
  if not found then
    raise exception using message = '部門不存在或已停用';
  end if;
  insert into public.profiles (
    id, employee_no, full_name, department_id, job_title, role, is_active
  ) values (
    p_profile_uuid, normalized_no, normalized_name, department.id,
    normalized_title, new_role, true
  ) returning * into created;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'employee.create', created.id, null,
    jsonb_build_object(
      'employeeNo', created.employee_no, 'name', created.full_name,
      'departmentId', created.department_id, 'title', created.job_title,
      'accessRole', created.role, 'active', created.is_active
    )
  );
  return jsonb_build_object('ok', true, 'id', created.id);
end;
$$;

create or replace function public.management_update_profile(
  p_actor_uuid uuid,
  p_profile_uuid uuid,
  p_employee_no text,
  p_full_name text,
  p_department_code text,
  p_job_title text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  target public.profiles;
  department public.departments;
  before_data jsonb;
  normalized_no text := upper(trim(coalesce(p_employee_no, '')));
  normalized_name text := trim(coalesce(p_full_name, ''));
  normalized_title text := trim(coalesce(p_job_title, ''));
  new_role public.user_role;
  locked_admin public.profiles;
  admin_count integer := 0;
begin
  actor := public.management_actor(
    p_actor_uuid,
    array['admin', 'hr']::public.user_role[]
  );
  select p.* into target from public.profiles p where p.id = p_profile_uuid for update;
  if not found then raise exception using message = '找不到指定員工'; end if;
  if actor.role = 'hr' and (target.role = 'admin' or lower(trim(coalesce(p_role, ''))) = 'admin') then
    raise exception using message = '人資不可操作或建立 Admin 帳號';
  end if;
  begin
    new_role := lower(trim(coalesce(p_role, 'employee')))::public.user_role;
  exception when invalid_text_representation then
    raise exception using message = '系統權限不正確';
  end;
  if normalized_no = '' or length(normalized_no) > 64 or normalized_no !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception using message = '員工編號格式不正確';
  end if;
  if normalized_name = '' or length(normalized_name) > 120 then
    raise exception using message = '員工姓名格式不正確';
  end if;
  select d.* into department
  from public.departments d
  where upper(d.code) = upper(trim(coalesce(p_department_code, '')))
    and d.is_active = true;
  if not found then raise exception using message = '部門不存在或已停用'; end if;

  if target.is_active and target.role = 'admin' and new_role <> 'admin' then
    for locked_admin in
      select p2.* from public.profiles p2
      where p2.role = 'admin' and p2.is_active
      for update
    loop
      admin_count := admin_count + 1;
    end loop;
    if admin_count <= 1 then
      raise exception using message = '不可停用或降級最後一位啟用中的 Admin';
    end if;
  end if;

  before_data := jsonb_build_object(
    'employeeNo', target.employee_no, 'name', target.full_name,
    'departmentId', target.department_id, 'title', target.job_title,
    'accessRole', target.role, 'active', target.is_active
  );
  update public.profiles
  set employee_no = normalized_no,
      full_name = normalized_name,
      department_id = department.id,
      job_title = normalized_title,
      role = new_role,
      updated_at = now()
  where id = target.id;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'employee.update', target.id, before_data,
    jsonb_build_object(
      'employeeNo', normalized_no, 'name', normalized_name,
      'departmentId', department.id, 'title', normalized_title,
      'accessRole', new_role, 'active', target.is_active
    )
  );
  return jsonb_build_object('ok', true, 'id', target.id);
end;
$$;

create or replace function public.management_set_profile_active(
  p_actor_uuid uuid,
  p_profile_uuid uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  target public.profiles;
  before_data jsonb;
  locked_admin public.profiles;
  admin_count integer := 0;
begin
  actor := public.management_actor(
    p_actor_uuid,
    array['admin', 'hr', 'it']::public.user_role[]
  );
  select p.* into target from public.profiles p where p.id = p_profile_uuid for update;
  if not found then raise exception using message = '找不到指定員工'; end if;
  if target.role = 'admin' and actor.role <> 'admin' then
    raise exception using message = '人資與 IT 不可操作 Admin 帳號';
  end if;
  if not p_active and target.id = actor.id then
    raise exception using message = '不可停用目前登入中的帳號';
  end if;
  if not p_active and target.role = 'admin' and target.is_active then
    for locked_admin in
      select p2.* from public.profiles p2
      where p2.role = 'admin' and p2.is_active
      for update
    loop
      admin_count := admin_count + 1;
    end loop;
    if admin_count <= 1 then
      raise exception using message = '不可停用最後一位啟用中的 Admin';
    end if;
  end if;
  if target.is_active = p_active then
    return jsonb_build_object('ok', true, 'id', target.id, 'active', target.is_active);
  end if;
  before_data := jsonb_build_object('active', target.is_active);
  update public.profiles set is_active = p_active, updated_at = now() where id = target.id;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'employee.active', target.id, before_data,
    jsonb_build_object('active', p_active)
  );
  return jsonb_build_object('ok', true, 'id', target.id, 'active', p_active);
end;
$$;

create or replace function public.management_create_department(
  p_actor_uuid uuid,
  p_code text,
  p_name text,
  p_manager_uuid uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  manager public.profiles;
  created public.departments;
  normalized_code text := upper(trim(coalesce(p_code, '')));
  normalized_name text := trim(coalesce(p_name, ''));
begin
  actor := public.management_actor(p_actor_uuid, array['admin', 'hr']::public.user_role[]);
  if normalized_code = '' or length(normalized_code) > 32 or normalized_code !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception using message = '部門代號格式不正確';
  end if;
  if normalized_name = '' or length(normalized_name) > 120 then
    raise exception using message = '部門名稱格式不正確';
  end if;
  if p_manager_uuid is not null then
    select p.* into manager from public.profiles p where p.id = p_manager_uuid and p.is_active;
    if not found then raise exception using message = '部門主管不存在或已停用'; end if;
  end if;
  insert into public.departments (code, name, manager_name, manager_id, is_active)
  values (normalized_code, normalized_name, coalesce(manager.full_name, ''), p_manager_uuid, true)
  returning * into created;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'department.create', null, null,
    jsonb_build_object('id', created.id, 'code', created.code, 'name', created.name,
      'managerId', created.manager_id, 'manager', created.manager_name)
  );
  return jsonb_build_object('ok', true, 'id', created.id);
end;
$$;

create or replace function public.management_update_department(
  p_actor_uuid uuid,
  p_department_uuid uuid,
  p_code text,
  p_name text,
  p_manager_uuid uuid default null,
  p_manager_supplied boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  manager public.profiles;
  target public.departments;
  before_data jsonb;
  normalized_code text := upper(trim(coalesce(p_code, '')));
  normalized_name text := trim(coalesce(p_name, ''));
  next_manager_id uuid;
  next_manager_name text;
begin
  actor := public.management_actor(p_actor_uuid, array['admin', 'hr']::public.user_role[]);
  select d.* into target from public.departments d where d.id = p_department_uuid for update;
  if not found then raise exception using message = '找不到指定部門'; end if;
  if normalized_code = '' or length(normalized_code) > 32 or normalized_code !~ '^[A-Z0-9][A-Z0-9._-]*$' then
    raise exception using message = '部門代號格式不正確';
  end if;
  if normalized_name = '' or length(normalized_name) > 120 then
    raise exception using message = '部門名稱格式不正確';
  end if;
  next_manager_id := target.manager_id;
  next_manager_name := target.manager_name;
  if p_manager_supplied and p_manager_uuid is not null then
    select p.* into manager from public.profiles p where p.id = p_manager_uuid and p.is_active;
    if not found then raise exception using message = '部門主管不存在或已停用'; end if;
    next_manager_id := manager.id;
    next_manager_name := manager.full_name;
  elsif p_manager_supplied then
    next_manager_id := null;
    next_manager_name := '';
  end if;
  before_data := jsonb_build_object('code', target.code, 'name', target.name,
    'managerId', target.manager_id, 'manager', target.manager_name);
  -- One UPDATE preserves the department FK used by all profiles; no employee
  -- rows are rewritten and no partial code/name save is possible.
  update public.departments
  set code = normalized_code,
      name = normalized_name,
      manager_id = next_manager_id,
      manager_name = next_manager_name,
      updated_at = now()
  where id = target.id;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'department.update', null, before_data,
    jsonb_build_object('id', target.id, 'code', normalized_code, 'name', normalized_name,
      'managerId', next_manager_id, 'manager', next_manager_name)
  );
  return jsonb_build_object('ok', true, 'id', target.id);
end;
$$;

create or replace function public.management_create_attendance(
  p_actor_uuid uuid,
  p_employee_uuid uuid,
  p_attendance_type text,
  p_punched_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  target public.profiles;
  new_record public.attendance_records;
  normalized_type public.attendance_type;
begin
  actor := public.management_actor(p_actor_uuid, array['admin']::public.user_role[]);
  begin
    normalized_type := p_attendance_type::public.attendance_type;
  exception when invalid_text_representation then
    raise exception using message = '刷卡類型不正確';
  end;
  select p.* into target from public.profiles p where p.id = p_employee_uuid;
  if not found then raise exception using message = '找不到刷卡員工'; end if;
  insert into public.attendance_records (
    employee_id, attendance_type, punched_at, client_ip, matched_network_id,
    user_agent, status, note
  ) values (
    target.id, normalized_type, p_punched_at, null, null,
    '管理者補登', 'accepted', null
  ) returning * into new_record;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'attendance.create', target.id, null,
    jsonb_build_object('id', new_record.id, 'type', new_record.attendance_type,
      'punchedAt', new_record.punched_at)
  );
  return jsonb_build_object('ok', true, 'id', new_record.id);
end;
$$;

create or replace function public.management_update_attendance(
  p_actor_uuid uuid,
  p_record_uuid uuid,
  p_attendance_type text,
  p_punched_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  target public.attendance_records;
  before_data jsonb;
  normalized_type public.attendance_type;
begin
  actor := public.management_actor(p_actor_uuid, array['admin']::public.user_role[]);
  begin
    normalized_type := p_attendance_type::public.attendance_type;
  exception when invalid_text_representation then
    raise exception using message = '刷卡類型不正確';
  end;
  select r.* into target from public.attendance_records r where r.id = p_record_uuid for update;
  if not found then raise exception using message = '找不到指定刷卡紀錄'; end if;
  before_data := jsonb_build_object('type', target.attendance_type, 'punchedAt', target.punched_at);
  update public.attendance_records
  set attendance_type = normalized_type, punched_at = p_punched_at
  where id = target.id;
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'attendance.update', target.employee_id, before_data,
    jsonb_build_object('id', target.id, 'type', normalized_type, 'punchedAt', p_punched_at)
  );
  return jsonb_build_object('ok', true, 'id', target.id);
end;
$$;

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
  actor public.profiles;
  settings public.system_settings;
  matched public.allowed_networks;
  new_record public.attendance_records;
  normalized_type public.attendance_type;
begin
  actor := public.management_actor(
    p_actor_uuid,
    array['employee', 'manager', 'hr', 'it', 'admin']::public.user_role[]
  );
  begin
    normalized_type := p_attendance_type::public.attendance_type;
  exception when invalid_text_representation then
    raise exception using message = '刷卡類型不正確';
  end;
  select s.* into settings from public.system_settings s where s.id = 1 for update;
  if not found then raise exception using message = '公司網路設定尚未完成'; end if;
  if p_client_ip is not null then
    select n.* into matched
    from public.allowed_networks n
    where n.is_active and p_client_ip <<= n.network
    order by masklen(n.network) desc, n.id desc
    limit 1;
  end if;
  if settings.network_mode = 'strict' and matched.id is null then
    raise exception using message = '目前不在允許的公司網路';
  end if;
  insert into public.attendance_records (
    employee_id, attendance_type, punched_at, client_ip, matched_network_id,
    user_agent, status
  ) values (
    actor.id, normalized_type, p_punched_at, p_client_ip, matched.id,
    left(coalesce(p_user_agent, ''), 512), 'accepted'
  ) returning * into new_record;
  return jsonb_build_object('ok', true, 'id', new_record.id);
end;
$$;

create or replace function public.management_save_network(
  p_actor_uuid uuid,
  p_mode text,
  p_allowed_ips text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  settings public.system_settings;
  item text;
  normalized_cidr cidr;
  values_json jsonb;
begin
  actor := public.management_actor(p_actor_uuid, array['admin']::public.user_role[]);
  if p_mode not in ('test', 'strict') then
    raise exception using message = '網路模式不正確';
  end if;
  if coalesce(array_length(p_allowed_ips, 1), 0) > 100 then
    raise exception using message = '允許網路數量過多';
  end if;
  if p_mode = 'strict' and coalesce(array_length(p_allowed_ips, 1), 0) < 1 then
    raise exception using message = '正式模式至少需要一組有效 CIDR';
  end if;
  -- Lock the singleton for the entire transaction. The old current rows are
  -- only deactivated after every incoming value has been parsed successfully.
  select s.* into settings from public.system_settings s where s.id = 1 for update;
  if not found then
    insert into public.system_settings (id, network_mode) values (1, 'test');
    select s.* into settings from public.system_settings s where s.id = 1 for update;
  end if;
  if p_allowed_ips is not null then
    foreach item in array p_allowed_ips loop
      if nullif(trim(item), '') is null then
        raise exception using message = '允許網路不可為空白';
      end if;
      begin
        normalized_cidr := network(trim(item)::inet);
      exception when others then
        raise exception using message = '允許網路包含無效 CIDR';
      end;
    end loop;
  end if;
  update public.allowed_networks
  set is_active = false, updated_at = now()
  where is_active = true;
  if p_allowed_ips is not null then
    foreach item in array p_allowed_ips loop
      insert into public.allowed_networks (name, network, is_active)
      values ('公司允許網路', network(trim(item)::inet), true);
    end loop;
  end if;
  update public.system_settings
  set network_mode = p_mode, updated_at = now()
  where id = 1;
  values_json := coalesce(
    (select jsonb_agg(n.network::text order by n.id)
     from public.allowed_networks n where n.is_active),
    '[]'::jsonb
  );
  insert into public.audit_log (actor_id, action, target_id, before_data, after_data)
  values (
    p_actor_uuid, 'network.save', null,
    jsonb_build_object('mode', settings.network_mode),
    jsonb_build_object('mode', p_mode, 'allowedIps', values_json)
  );
  return jsonb_build_object('ok', true, 'mode', p_mode, 'allowedIps', values_json);
end;
$$;

-- Management functions are deliberately invisible to browser roles.
revoke all on function public.management_actor(uuid, public.user_role[]) from public, anon, authenticated;
revoke all on function public.management_audit(uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.management_create_profile(uuid, uuid, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.management_update_profile(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.management_set_profile_active(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.management_create_department(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.management_update_department(uuid, uuid, text, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.management_create_attendance(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.management_update_attendance(uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.management_punch(uuid, text, timestamptz, inet, text) from public, anon, authenticated;
revoke all on function public.management_save_network(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.management_actor(uuid, public.user_role[]) to service_role;
grant execute on function public.management_audit(uuid, text, uuid, jsonb, jsonb) to service_role;
grant execute on function public.management_create_profile(uuid, uuid, text, text, text, text, text, boolean) to service_role;
grant execute on function public.management_update_profile(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.management_set_profile_active(uuid, uuid, boolean) to service_role;
grant execute on function public.management_create_department(uuid, text, text, uuid) to service_role;
grant execute on function public.management_update_department(uuid, uuid, text, text, uuid, boolean) to service_role;
grant execute on function public.management_create_attendance(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.management_update_attendance(uuid, uuid, text, timestamptz) to service_role;
grant execute on function public.management_punch(uuid, text, timestamptz, inet, text) to service_role;
grant execute on function public.management_save_network(uuid, text, text[]) to service_role;

revoke all on function public.prevent_allowed_network_delete() from public, anon, authenticated, service_role;

commit;
