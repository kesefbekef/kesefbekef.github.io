-- הערות ומשובים מלומדים בכיף, שאין בו התחברות.
-- אפשר רק להוסיף הערה, ורק עם app='lomdim'. אי אפשר לקרוא מהטבלה.
-- מוגבל: הודעה עד 5000 תווים, ועד 60 הערות בשעה מכל המכשירים יחד.
create or replace function feedback_anon(p_app text, p_kind text, p_message text, p_device text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_app is distinct from 'lomdim' then return false; end if;
  if length(coalesce(trim(p_message), '')) not between 1 and 5000 then return false; end if;
  if (select count(*) from feedback where app = 'lomdim' and created_at > now() - interval '1 hour') >= 60 then return false; end if;
  insert into feedback (user_id, app, kind, message, device)
    values (null, 'lomdim', left(p_kind, 40), trim(p_message), left(p_device, 80));
  return true;
end $$;

revoke all on function feedback_anon(text, text, text, text) from public;
grant execute on function feedback_anon(text, text, text, text) to anon, authenticated;
