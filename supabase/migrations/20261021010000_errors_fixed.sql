-- 🐞 תקלות בלוח הבקרה: "🔴 פתוחה" / "✅ תוקנה" — מתי, באיזו גרסה ומה תוקן (משפט בעברית פשוטה).
-- תקלה = אותה אפליקציה + אותה הודעה + אותו מקום בקוד. סימון "תוקנה" מסמן את כל המופעים שלה.
-- אם אותה תקלה קורית שוב אחרי התיקון — נרשמת שורה חדשה, פתוחה (ורואים שהיא חזרה).

alter table app_errors add column if not exists fixed_at timestamptz;
alter table app_errors add column if not exists fixed_version text;
alter table app_errors add column if not exists fixed_note text;
alter table app_errors add column if not exists fixed_by uuid;
create index if not exists app_errors_open on app_errors (app, message, source) where fixed_at is null;

-- מסמן תקלה כמתוקנת (רק מנהל). p_id = אחת השורות של התקלה. מחזיר כמה מופעים סומנו
create or replace function admin_fix_error(p_id bigint, p_version text, p_note text)
returns int language plpgsql security definer set search_path = public as $$
declare e app_errors; n int;
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  if length(coalesce(trim(p_note), '')) < 3 then raise exception 'צריך משפט קצר שמסביר מה תוקן'; end if;
  select * into e from app_errors where id = p_id;
  if not found then raise exception 'not found'; end if;
  update app_errors set fixed_at = now(), fixed_version = left(trim(coalesce(p_version, '')), 40), fixed_note = left(trim(p_note), 300), fixed_by = auth.uid()
    where app = e.app and message is not distinct from e.message and source is not distinct from e.source
      and fixed_at is null and at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- פתיחה מחדש (אם התברר שלא באמת תוקן)
create or replace function admin_reopen_error(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare e app_errors; n int;
begin
  if not is_app_admin() then raise exception 'not allowed'; end if;
  select * into e from app_errors where id = p_id;
  if not found then raise exception 'not found'; end if;
  update app_errors set fixed_at = null, fixed_version = null, fixed_note = null, fixed_by = null
    where app = e.app and message is not distinct from e.message and source is not distinct from e.source and fixed_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function admin_fix_error(bigint, text, text) from public, anon;
revoke all on function admin_reopen_error(bigint) from public, anon;
grant execute on function admin_fix_error(bigint, text, text) to authenticated;
grant execute on function admin_reopen_error(bigint) to authenticated;

-- לוח הבקרה: אותו דבר כמו קודם, ובתקלות גם id ופרטי התיקון (עד 500 אחרונות)
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
        select e.id, e.app, e.message, e.source, e.device, e.version, e.at, e.fixed_at, e.fixed_version, e.fixed_note, u.email
        from app_errors e left join auth.users u on u.id = e.user_id order by e.at desc limit 500) e), '[]')
  ) into res;
  return res;
end $$;

revoke all on function admin_overview() from public, anon;
grant execute on function admin_overview() to authenticated;
