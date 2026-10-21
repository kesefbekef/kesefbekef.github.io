-- 📅 מהיומן לאפליקציות: המשתמש מדביק את "הכתובת הסודית בפורמט iCal" של היומן שלו (גוגל / iCloud).
-- הכתובת נשמרת מוצפנת ב-Vault (לא בטבלה, ולא חוזרת לאפליקציה — רק השם של האתר).
-- פונקציית השרת calendar-import קוראת את היומן כל 15 דקות ושומרת את האירועים (מחודש אחורה עד 3 חודשים קדימה).
-- האירועים פרטיים: רק המשתמש עצמו רואה אותם (אישור המשתמש, 21.10.2026). "ניתוק" מוחק את הקישור ואת כל האירועים.

create table if not exists user_calendars (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret_id uuid not null,                 -- ה-Vault שבו שמורה הכתובת
  host text not null,                      -- להצגה בלבד: calendar.google.com
  last_sync timestamptz,
  last_error text,
  events int not null default 0,
  created_at timestamptz not null default now()
);
alter table user_calendars enable row level security;
drop policy if exists "cal own read" on user_calendars;
create policy "cal own read" on user_calendars for select using (user_id = auth.uid());

create table if not exists external_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  uid text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  title text,
  location text,
  updated_at timestamptz not null default now(),
  primary key (user_id, uid, starts_at)
);
create index if not exists external_events_user_time on external_events (user_id, starts_at);
alter table external_events enable row level security;

drop policy if exists "events own" on external_events;
create policy "events own" on external_events for select using (user_id = auth.uid());

-- ---------- מה שהאפליקציה מפעילה (המשתמש המחובר) ----------
create or replace function set_my_calendar(p_url text) returns text
language plpgsql security definer set search_path = public, vault as $$
declare u uuid := auth.uid(); url text := trim(coalesce(p_url, '')); h text; sid uuid;
begin
  if u is null then raise exception 'צריך להיות מחוברים'; end if;
  url := regexp_replace(url, '^webcal://', 'https://', 'i');
  if url !~* '^https://[^/\s]+/\S+$' or length(url) > 2000 then raise exception 'זה לא נראה כמו קישור ליומן (צריך להתחיל ב-https:// או webcal://)'; end if;
  h := lower(substring(url from '^https://([^/:]+)'));
  select secret_id into sid from user_calendars where user_id = u;
  if sid is null then
    sid := vault.create_secret(url, 'cal-' || u::text, 'קישור יומן של משתמש — לקריאה בלבד');
    insert into user_calendars (user_id, secret_id, host) values (u, sid, h);
  else
    perform vault.update_secret(sid, url);
    update user_calendars set host = h, last_sync = null, last_error = null where user_id = u;
  end if;
  return h;
end $$;

create or replace function clear_my_calendar() returns void
language plpgsql security definer set search_path = public, vault as $$
declare u uuid := auth.uid(); sid uuid;
begin
  if u is null then return; end if;
  select secret_id into sid from user_calendars where user_id = u;
  delete from external_events where user_id = u;
  delete from user_calendars where user_id = u;
  if sid is not null then delete from vault.secrets where id = sid; end if;
end $$;

revoke all on function set_my_calendar(text) from public, anon;
revoke all on function clear_my_calendar() from public, anon;
grant execute on function set_my_calendar(text) to authenticated;
grant execute on function clear_my_calendar() to authenticated;

-- ---------- רק לפונקציית השרת (service_role) ----------
create or replace function calendar_import_list(p_user uuid default null) returns table (user_id uuid, url text)
language sql security definer set search_path = public, vault as $$
  select uc.user_id, ds.decrypted_secret from user_calendars uc join vault.decrypted_secrets ds on ds.id = uc.secret_id
  where p_user is null or uc.user_id = p_user;
$$;

-- מחליף את כל האירועים של המשתמש בחלון (מחודש אחורה) במה שנקרא עכשיו
create or replace function calendar_import_save(p_user uuid, p_events jsonb, p_error text default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if p_error is not null then
    update user_calendars set last_sync = now(), last_error = left(p_error, 200) where user_id = p_user;
    return 0;
  end if;
  delete from external_events where user_id = p_user;
  insert into external_events (user_id, uid, starts_at, ends_at, all_day, title, location)
    select p_user, left(e->>'uid', 300), (e->>'start')::timestamptz, nullif(e->>'end', '')::timestamptz, coalesce((e->>'allDay')::boolean, false), left(e->>'title', 200), left(e->>'location', 200)
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
    where e->>'start' is not null
  on conflict do nothing;
  get diagnostics n = row_count;
  update user_calendars set last_sync = now(), last_error = null, events = n where user_id = p_user;
  return n;
end $$;

revoke all on function calendar_import_list(uuid) from public, anon, authenticated;
revoke all on function calendar_import_save(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function calendar_import_list(uuid) to service_role;
grant execute on function calendar_import_save(uuid, jsonb, text) to service_role;
