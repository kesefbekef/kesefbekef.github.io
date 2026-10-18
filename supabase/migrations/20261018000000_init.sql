-- כסף בכיף — הקמת מסד הנתונים ב-Supabase
-- מדביקים את כל הקובץ ב: SQL Editor ← New query ← Run

-- משפחות (משק בית) וקוד הצטרפות
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'המשפחה שלי',
  invite_code text unique not null,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz default now()
);

-- מי שייך לאיזו משפחה
create table if not exists members (
  household_id uuid references households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (household_id, user_id)
);

-- תנועות (כל רשומה נשמרת כ-JSON, מחיקה = deleted)
create table if not exists tx (
  household_id uuid references households(id) on delete cascade,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

-- הגדרות משותפות: תקציבים, בני הבית, מילים שנלמדו
create table if not exists kv (
  household_id uuid references households(id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, key)
);

create index if not exists tx_updated on tx (household_id, updated_at);

-- זמן העדכון נקבע תמיד בשרת (כדי ששעונים שונים בטלפונים לא יבלבלו)
create or replace function touch_updated() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tx_touch on tx;
create trigger tx_touch before insert or update on tx for each row execute function touch_updated();
drop trigger if exists kv_touch on kv;
create trigger kv_touch before insert or update on kv for each row execute function touch_updated();

-- ---------- אבטחה: כל אחד רואה רק את המשפחה שלו ----------
alter table households enable row level security;
alter table members enable row level security;
alter table tx enable row level security;
alter table kv enable row level security;

create or replace function is_member(h uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where household_id = h and user_id = auth.uid());
$$;

drop policy if exists "members read household" on households;
create policy "members read household" on households for select using (is_member(id));

drop policy if exists "members read members" on members;
create policy "members read members" on members for select using (is_member(household_id));

drop policy if exists "members use tx" on tx;
create policy "members use tx" on tx for all using (is_member(household_id)) with check (is_member(household_id));

drop policy if exists "members use kv" on kv;
create policy "members use kv" on kv for all using (is_member(household_id)) with check (is_member(household_id));

-- יצירת משפחה חדשה (מחזיר את המזהה ואת קוד ההצטרפות)
create or replace function create_household(hname text)
returns table (id uuid, invite_code text)
language plpgsql security definer set search_path = public as $$
declare h uuid; code text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    code := upper(substr(md5(random()::text), 1, 6));
    exit when not exists (select 1 from households where households.invite_code = code);
  end loop;
  insert into households (name, invite_code, created_by) values (coalesce(nullif(hname, ''), 'המשפחה שלי'), code, auth.uid())
    returning households.id into h;
  insert into members (household_id, user_id) values (h, auth.uid());
  return query select h, code;
end $$;

-- הצטרפות למשפחה עם קוד
create or replace function join_household(code text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select households.id into h from households where households.invite_code = upper(trim(code));
  if h is null then raise exception 'bad code'; end if;
  insert into members (household_id, user_id) values (h, auth.uid()) on conflict do nothing;
  return h;
end $$;

-- המשפחה של המשתמש המחובר
create or replace function my_household()
returns table (id uuid, name text, invite_code text)
language sql security definer stable set search_path = public as $$
  select h.id, h.name, h.invite_code from households h
  join members m on m.household_id = h.id where m.user_id = auth.uid()
  order by m.joined_at limit 1;
$$;

-- עדכונים בזמן אמת בין הטלפונים
do $$ begin
  begin alter publication supabase_realtime add table tx; exception when others then null; end;
  begin alter publication supabase_realtime add table kv; exception when others then null; end;
end $$;
