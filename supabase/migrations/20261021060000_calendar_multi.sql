-- 📥 כמה יומנים למשתמש (למשל "היומן שלי" + "היומן המשפחתי") — עד 5. עדיין: מוצפן ב-Vault, ורק הבעלים רואה.
-- תואם לאחור: set_my_calendar(p_url) מוסיף יומן (או מעדכן אם אותו קישור כבר מחובר), clear_my_calendar() מנתק הכל.
-- (נכון ל-21.10.2026 אין עדיין יומנים מחוברים — לכן אפשר לשנות את המפתחות בבטחה)

delete from external_events;
alter table user_calendars drop constraint if exists user_calendars_pkey;
alter table user_calendars add column if not exists id uuid not null default gen_random_uuid();
alter table user_calendars add column if not exists label text;
alter table user_calendars add primary key (id);
create index if not exists user_calendars_user on user_calendars (user_id);

alter table external_events add column if not exists cal_id uuid references user_calendars(id) on delete cascade;
alter table external_events drop constraint if exists external_events_pkey;
alter table external_events alter column cal_id set not null;
alter table external_events add primary key (cal_id, uid, starts_at);

drop function if exists set_my_calendar(text);
create or replace function set_my_calendar(p_url text, p_label text default null) returns text
language plpgsql security definer set search_path = public, vault as $$
declare u uuid := auth.uid(); url text := trim(coalesce(p_url, '')); h text; cid uuid; sid uuid;
begin
  if u is null then raise exception 'צריך להיות מחוברים'; end if;
  url := regexp_replace(url, '^webcal://', 'https://', 'i');
  if url !~* '^https://[^/\s]+/\S+$' or length(url) > 2000 then raise exception 'זה לא נראה כמו קישור ליומן (צריך להתחיל ב-https:// או webcal://)'; end if;
  h := lower(substring(url from '^https://([^/:]+)'));
  -- אותו קישור כבר מחובר? מעדכנים את השם בלבד
  select uc.id into cid from user_calendars uc join vault.decrypted_secrets ds on ds.id = uc.secret_id where uc.user_id = u and ds.decrypted_secret = url;
  if cid is not null then
    update user_calendars set label = coalesce(nullif(trim(p_label), ''), label), last_sync = null, last_error = null where id = cid;
    return h;
  end if;
  if (select count(*) from user_calendars where user_id = u) >= 5 then raise exception 'אפשר לחבר עד 5 יומנים'; end if;
  sid := vault.create_secret(url, 'cal-' || gen_random_uuid()::text, 'קישור יומן של משתמש — לקריאה בלבד');
  insert into user_calendars (user_id, secret_id, host, label) values (u, sid, h, left(nullif(trim(p_label), ''), 40));
  return h;
end $$;

drop function if exists clear_my_calendar();
create or replace function clear_my_calendar(p_id uuid default null) returns void
language plpgsql security definer set search_path = public, vault as $$
declare u uuid := auth.uid(); r record;
begin
  if u is null then return; end if;
  for r in select id, secret_id from user_calendars where user_id = u and (p_id is null or id = p_id) loop
    delete from external_events where cal_id = r.id;
    delete from user_calendars where id = r.id;
    delete from vault.secrets where id = r.secret_id;
  end loop;
end $$;

revoke all on function set_my_calendar(text, text) from public, anon;
revoke all on function clear_my_calendar(uuid) from public, anon;
grant execute on function set_my_calendar(text, text) to authenticated;
grant execute on function clear_my_calendar(uuid) to authenticated;

-- ---------- רק לפונקציית השרת ----------
drop function if exists calendar_import_list(uuid);
create or replace function calendar_import_list(p_user uuid default null) returns table (cal_id uuid, user_id uuid, url text)
language sql security definer set search_path = public, vault as $$
  select uc.id, uc.user_id, ds.decrypted_secret from user_calendars uc join vault.decrypted_secrets ds on ds.id = uc.secret_id
  where p_user is null or uc.user_id = p_user;
$$;

drop function if exists calendar_import_save(uuid, jsonb, text);
create or replace function calendar_import_save(p_cal uuid, p_events jsonb, p_error text default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; u uuid;
begin
  select user_id into u from user_calendars where id = p_cal; if u is null then return 0; end if;
  if p_error is not null then
    update user_calendars set last_sync = now(), last_error = left(p_error, 200) where id = p_cal;
    return 0;
  end if;
  delete from external_events where cal_id = p_cal;
  insert into external_events (cal_id, user_id, uid, starts_at, ends_at, all_day, title, location)
    select p_cal, u, left(e->>'uid', 300), (e->>'start')::timestamptz, nullif(e->>'end', '')::timestamptz, coalesce((e->>'allDay')::boolean, false), left(e->>'title', 200), left(e->>'location', 200)
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
    where e->>'start' is not null
  on conflict do nothing;
  get diagnostics n = row_count;
  update user_calendars set last_sync = now(), last_error = null, events = n where id = p_cal;
  return n;
end $$;

revoke all on function calendar_import_list(uuid) from public, anon, authenticated;
revoke all on function calendar_import_save(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function calendar_import_list(uuid) to service_role;
grant execute on function calendar_import_save(uuid, jsonb, text) to service_role;
