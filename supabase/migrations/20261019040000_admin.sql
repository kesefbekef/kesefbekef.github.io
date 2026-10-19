-- לוח בקרה למנהל (שתי האפליקציות): מי נרשם, מי התקין, מתי השתמש, כמה רשומות, ותקלות.
-- בלי תוכן: לא סכומים, לא תיאורים, לא משימות — רק מספרים.

-- ---------- מי המנהל ----------
create table if not exists app_admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table app_admins enable row level security; -- אין גישה מהאפליקציה
insert into app_admins (user_id) select id from auth.users where email = 'mvindish@gmail.com' on conflict do nothing;

create or replace function is_app_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;

-- ---------- נוכחות: מכשיר אחד = שורה אחת ----------
create table if not exists app_presence (
  device_id text not null,
  app text not null check (app in ('kesef', 'zman')),
  user_id uuid references auth.users(id) on delete cascade,
  standalone boolean not null default false,   -- נפתח מאייקון (מותקן) או מהדפדפן
  device text,                                  -- "iPhone · Safari" וכו'
  version text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  opens int not null default 1,
  primary key (device_id, app)
);
alter table app_presence enable row level security;

-- ---------- תקלות שנתפסו אצל משתמשים ----------
create table if not exists app_errors (
  id bigserial primary key,
  app text not null,
  device_id text,
  user_id uuid,
  message text,
  source text,
  device text,
  version text,
  at timestamptz not null default now()
);
create index if not exists app_errors_at on app_errors (at desc);
alter table app_errors enable row level security;

-- האפליקציה מדווחת "נפתחתי" (פעם בפתיחה)
create or replace function track_ping(p_app text, p_device_id text, p_standalone boolean, p_device text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_app not in ('kesef', 'zman') or length(coalesce(p_device_id, '')) not between 8 and 64 then return; end if;
  insert into app_presence (device_id, app, user_id, standalone, device, version)
    values (p_device_id, p_app, auth.uid(), coalesce(p_standalone, false), left(p_device, 80), left(p_version, 40))
  on conflict (device_id, app) do update set
    user_id = coalesce(auth.uid(), app_presence.user_id),
    standalone = app_presence.standalone or excluded.standalone,
    device = excluded.device, version = excluded.version,
    opens = app_presence.opens + case when app_presence.last_seen < now() - interval '10 minutes' then 1 else 0 end,
    last_seen = now();
end $$;

-- האפליקציה מדווחת על תקלה (מוגבל: 30 ביום למכשיר, טקסט קצר)
create or replace function track_error(p_app text, p_device_id text, p_message text, p_source text, p_device text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_app not in ('kesef', 'zman') then return; end if;
  if (select count(*) from app_errors where device_id = p_device_id and at > now() - interval '1 day') >= 30 then return; end if;
  if (select count(*) from app_errors where at > now() - interval '1 hour') >= 500 then return; end if;
  insert into app_errors (app, device_id, user_id, message, source, device, version)
    values (p_app, left(p_device_id, 64), auth.uid(), left(p_message, 300), left(p_source, 200), left(p_device, 80), left(p_version, 40));
  delete from app_errors where at < now() - interval '60 days';
end $$;

grant execute on function track_ping(text, text, boolean, text, text) to anon, authenticated;
grant execute on function track_error(text, text, text, text, text, text) to anon, authenticated;

-- ---------- מה המנהל רואה ----------
create or replace function admin_overview() returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare res jsonb;
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  with
  kesef_names as (   -- השם של כל משתמש כפי שמופיע ברשימת בני הבית
    select (p->>'uid')::uuid as uid, p->>'name' as name, p->>'e' as emoji
    from kv, jsonb_array_elements(case when jsonb_typeof(kv.value) = 'array' then kv.value else '[]'::jsonb end) p
    where kv.key = 'people' and p->>'uid' ~ '^[0-9a-f-]{36}$'
  ),
  users as (
    select u.id, u.email, u.created_at, u.last_sign_in_at,
      coalesce((select name from kesef_names k where k.uid = u.id limit 1), (select full_name from zman_profiles z where z.user_id = u.id)) as name,
      coalesce((select emoji from kesef_names k where k.uid = u.id limit 1), (select emoji from zman_profiles z where z.user_id = u.id)) as emoji,
      (select count(*) from tx where tx.created_by = u.id and not tx.deleted and tx.updated_at > now() - interval '7 days') as kesef_week,
      (select count(*) from zman_tasks t where t.created_by = u.id and not t.deleted and t.updated_at > now() - interval '7 days') as zman_week,
      (select count(*) from tx where tx.created_by = u.id and not tx.deleted) as kesef_total,
      (select count(*) from zman_tasks t where t.created_by = u.id and not t.deleted) as zman_total,
      (select jsonb_agg(jsonb_build_object('app', p.app, 'standalone', p.standalone, 'device', p.device, 'last_seen', p.last_seen, 'opens', p.opens, 'version', p.version) order by p.last_seen desc)
         from app_presence p where p.user_id = u.id) as devices
    from auth.users u
  )
  select jsonb_build_object(
    'now', now(),
    'users', coalesce((select jsonb_agg(to_jsonb(users) order by greatest(users.last_sign_in_at, users.created_at) desc nulls last) from users), '[]'),
    'households', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'created_at', h.created_at,
        'members', (select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role)) from members m where m.household_id = h.id)) order by h.created_at desc) from households h), '[]'),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'created_at', g.created_at,
        'members', (select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'nickname', m.nickname, 'role', m.role)) from zman_members m where m.group_id = g.id)) order by g.created_at desc) from zman_groups g where g.kind <> 'pair'), '[]'),
    'anon_devices', coalesce((select jsonb_agg(jsonb_build_object('app', p.app, 'standalone', p.standalone, 'device', p.device, 'last_seen', p.last_seen, 'opens', p.opens)) from app_presence p where p.user_id is null), '[]'),
    'errors', coalesce((select jsonb_agg(e order by e.at desc) from (
        select e.app, e.message, e.source, e.device, e.version, e.at, u.email from app_errors e left join auth.users u on u.id = e.user_id order by e.at desc limit 200) e), '[]')
  ) into res;
  return res;
end $$;

revoke all on function admin_overview() from public, anon;
grant execute on function admin_overview() to authenticated;
