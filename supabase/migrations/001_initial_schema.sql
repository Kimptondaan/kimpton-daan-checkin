create extension if not exists pgcrypto;

-- Roles and attendance types are created only when absent so this migration can be rerun safely.
do $$ begin
  create type public.user_role as enum ('employee', 'admin', 'hr', 'manager');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.attendance_type as enum ('check_in', 'check_out');
exception when duplicate_object then null; end $$;

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  manager_name text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_no text unique not null,
  full_name text not null,
  department_id uuid references public.departments(id) on delete set null,
  job_title text not null default '',
  role public.user_role not null default 'employee',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.allowed_networks (
  id bigint generated always as identity primary key,
  name text not null,
  network cidr not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id),
  attendance_type public.attendance_type not null,
  punched_at timestamptz not null default now(),
  client_ip inet,
  matched_network_id bigint references public.allowed_networks(id),
  user_agent text,
  status text not null default 'accepted' check (status in ('accepted', 'rejected', 'manual')),
  note text,
  created_at timestamptz not null default now()
);

-- Intentionally no one-punch-per-day unique index: repeated punches are allowed.
create index if not exists attendance_records_punched_at_idx on public.attendance_records (punched_at desc);
create index if not exists attendance_records_employee_id_idx on public.attendance_records (employee_id, punched_at desc);
create index if not exists profiles_department_id_idx on public.profiles (department_id);

create or replace function public.current_profile()
returns public.profiles
language sql stable security definer set search_path = public
as $$ select p.* from public.profiles p where p.id = auth.uid() limit 1 $$;

create or replace function public.current_user_role()
returns public.user_role
language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function public.current_department_id()
returns uuid
language sql stable security definer set search_path = public
as $$ select department_id from public.profiles where id = auth.uid() $$;

alter table public.departments enable row level security;
alter table public.profiles enable row level security;
alter table public.allowed_networks enable row level security;
alter table public.attendance_records enable row level security;

revoke all on public.departments, public.profiles, public.allowed_networks, public.attendance_records from anon;
grant select on public.departments, public.profiles, public.attendance_records to authenticated;
grant insert on public.attendance_records to authenticated;

drop policy if exists "Authenticated users can view departments" on public.departments;
create policy "Authenticated users can view departments" on public.departments
for select to authenticated using (true);

drop policy if exists "Users can view allowed networks" on public.allowed_networks;
create policy "Users can view allowed networks" on public.allowed_networks
for select to authenticated using (public.current_user_role() in ('admin', 'hr', 'manager'));

drop policy if exists "Users can view permitted profiles" on public.profiles;
create policy "Users can view permitted profiles" on public.profiles
for select to authenticated using (
  id = auth.uid()
  or public.current_user_role() in ('admin', 'hr')
  or (public.current_user_role() = 'manager' and department_id = public.current_department_id())
);

drop policy if exists "Users can view permitted attendance" on public.attendance_records;
create policy "Users can view permitted attendance" on public.attendance_records
for select to authenticated using (
  employee_id = auth.uid()
  or public.current_user_role() in ('admin', 'hr')
  or (public.current_user_role() = 'manager' and exists (
    select 1 from public.profiles p
    where p.id = attendance_records.employee_id
      and p.department_id = public.current_department_id()
  ))
);

drop policy if exists "Users can create their own attendance" on public.attendance_records;
create policy "Users can create their own attendance" on public.attendance_records
for insert to authenticated with check (employee_id = auth.uid());

revoke all on function public.current_profile() from public, anon;
revoke all on function public.current_user_role() from public, anon;
revoke all on function public.current_department_id() from public, anon;
grant execute on function public.current_profile() to authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_department_id() to authenticated;

create or replace function public.find_network_for_ip(input_ip inet)
returns public.allowed_networks
language sql stable security definer set search_path = public
as $$
  select n.* from public.allowed_networks n
  where n.is_active = true and input_ip <<= n.network
  order by masklen(n.network) desc limit 1;
$$;
revoke all on function public.find_network_for_ip(inet) from public, anon, authenticated;
