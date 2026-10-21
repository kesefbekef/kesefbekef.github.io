-- 🎮 לומדים בכיף בלוח הבקרה: מכשירים ("נפתחתי") ותקלות. עד עכשיו השרת קיבל רק kesef ו-zman, והתעלם בשקט מהשאר.

alter table app_presence drop constraint if exists app_presence_app_check;
alter table app_presence add constraint app_presence_app_check check (app in ('kesef', 'zman', 'lomdim'));

create or replace function track_ping(p_app text, p_device_id text, p_standalone boolean, p_device text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_app not in ('kesef', 'zman', 'lomdim') or length(coalesce(p_device_id, '')) not between 8 and 64 then return; end if;
  insert into app_presence (device_id, app, user_id, standalone, device, version)
    values (p_device_id, p_app, auth.uid(), coalesce(p_standalone, false), left(p_device, 80), left(p_version, 40))
  on conflict (device_id, app) do update set
    user_id = coalesce(auth.uid(), app_presence.user_id),
    standalone = app_presence.standalone or excluded.standalone,
    device = excluded.device, version = excluded.version,
    opens = app_presence.opens + case when app_presence.last_seen < now() - interval '10 minutes' then 1 else 0 end,
    last_seen = now();
end $$;

create or replace function track_error(p_app text, p_device_id text, p_message text, p_source text, p_device text, p_version text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_app not in ('kesef', 'zman', 'lomdim') then return; end if;
  if (select count(*) from app_errors where device_id = p_device_id and at > now() - interval '1 day') >= 30 then return; end if;
  if (select count(*) from app_errors where at > now() - interval '1 hour') >= 500 then return; end if;
  insert into app_errors (app, device_id, user_id, message, source, device, version)
    values (p_app, left(p_device_id, 64), auth.uid(), left(p_message, 300), left(p_source, 200), left(p_device, 80), left(p_version, 40));
  delete from app_errors where at < now() - interval '60 days';
end $$;

grant execute on function track_ping(text, text, boolean, text, text) to anon, authenticated;
grant execute on function track_error(text, text, text, text, text, text) to anon, authenticated;
