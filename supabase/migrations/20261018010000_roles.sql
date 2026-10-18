-- תפקידים במשפחה: הורה רואה הכל, ילד רק מוסיף ורואה את מה שהוא עצמו רשם

alter table households add column if not exists child_code text unique;
update households set child_code = upper(substr(md5(random()::text || id::text), 1, 6)) where child_code is null;

alter table members add column if not exists role text not null default 'parent';
do $$ begin
  alter table members add constraint members_role_check check (role in ('parent', 'child'));
exception when duplicate_object then null; end $$;

alter table tx add column if not exists created_by uuid default auth.uid();

create or replace function is_parent(h uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid() and role = 'parent');
$$;

-- ---------- הרשאות חדשות ----------
-- פרטי המשפחה (כולל הקודים) — רק להורים
drop policy if exists "members read household" on households;
create policy "parents read household" on households for select using (is_parent(id));

-- רשימת החברים — הורה רואה את כולם, ילד רק את עצמו
drop policy if exists "members read members" on members;
create policy "read members" on members for select using (is_parent(household_id) or user_id = auth.uid());

-- תנועות — הורה: הכל. ילד: רק מה שהוא יצר
drop policy if exists "members use tx" on tx;
drop policy if exists "tx select" on tx;
drop policy if exists "tx insert" on tx;
drop policy if exists "tx update" on tx;
drop policy if exists "tx delete" on tx;
create policy "tx select" on tx for select
  using (is_parent(household_id) or (is_member(household_id) and created_by = auth.uid()));
create policy "tx insert" on tx for insert
  with check (is_member(household_id) and (is_parent(household_id) or created_by = auth.uid()));
create policy "tx update" on tx for update
  using (is_parent(household_id) or (is_member(household_id) and created_by = auth.uid()))
  with check (is_parent(household_id) or (is_member(household_id) and created_by = auth.uid()));
create policy "tx delete" on tx for delete
  using (is_parent(household_id) or (is_member(household_id) and created_by = auth.uid()));

-- הגדרות — הורה: הכל. ילד: רק שמות בני הבית ומילים שנלמדו (בלי תקציב)
drop policy if exists "members use kv" on kv;
drop policy if exists "kv select" on kv;
drop policy if exists "kv write" on kv;
drop policy if exists "kv update" on kv;
create policy "kv select" on kv for select
  using (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned')));
create policy "kv write" on kv for insert
  with check (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned')));
create policy "kv update" on kv for update
  using (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned')))
  with check (is_parent(household_id) or (is_member(household_id) and key in ('people', 'learned')));

-- ---------- פונקציות ----------
create or replace function create_household(hname text)
returns table (id uuid, invite_code text)
language plpgsql security definer set search_path = public as $$
declare h uuid; code text; ccode text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    code := upper(substr(md5(random()::text), 1, 6));
    ccode := upper(substr(md5(random()::text), 1, 6));
    exit when code <> ccode and not exists (select 1 from households where households.invite_code in (code, ccode) or households.child_code in (code, ccode));
  end loop;
  insert into households (name, invite_code, child_code, created_by) values (coalesce(nullif(hname, ''), 'המשפחה שלי'), code, ccode, auth.uid())
    returning households.id into h;
  insert into members (household_id, user_id, role) values (h, auth.uid(), 'parent');
  return query select h, code;
end $$;

create or replace function join_household(code text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid; r text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select households.id, 'parent' into h, r from households where households.invite_code = upper(trim(code));
  if h is null then
    select households.id, 'child' into h, r from households where households.child_code = upper(trim(code));
  end if;
  if h is null then raise exception 'bad code'; end if;
  insert into members (household_id, user_id, role) values (h, auth.uid(), r) on conflict do nothing;
  return h;
end $$;

drop function if exists my_household();
create function my_household()
returns table (id uuid, name text, role text, invite_code text, child_code text)
language sql security definer stable set search_path = public as $$
  select h.id, h.name, m.role,
    case when m.role = 'parent' then h.invite_code end,
    case when m.role = 'parent' then h.child_code end
  from households h join members m on m.household_id = h.id
  where m.user_id = auth.uid()
  order by m.joined_at limit 1;
$$;

create or replace function list_members()
returns table (user_id uuid, role text, joined_at timestamptz)
language sql security definer stable set search_path = public as $$
  select m.user_id, m.role, m.joined_at from members m
  where m.household_id = (select household_id from members where user_id = auth.uid() order by joined_at limit 1)
    and is_parent(m.household_id)
  order by m.joined_at;
$$;

create or replace function set_member_role(target uuid, new_role text)
returns void
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  select household_id into h from members where user_id = auth.uid() order by joined_at limit 1;
  if h is null or not is_parent(h) then raise exception 'not allowed'; end if;
  if new_role not in ('parent', 'child') then raise exception 'bad role'; end if;
  if new_role = 'child' and (select count(*) from members where household_id = h and role = 'parent' and user_id <> target) = 0 then
    raise exception 'last parent';
  end if;
  update members set role = new_role where household_id = h and user_id = target;
end $$;

create or replace function remove_member(target uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  select household_id into h from members where user_id = auth.uid() order by joined_at limit 1;
  if h is null or not is_parent(h) then raise exception 'not allowed'; end if;
  if (select count(*) from members where household_id = h and role = 'parent' and user_id <> target) = 0 then
    raise exception 'last parent';
  end if;
  delete from members where household_id = h and user_id = target;
end $$;
