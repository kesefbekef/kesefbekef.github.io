-- 🔐 אבטחה (20.10): החלפת קודי הצטרפות, והסרת בן משפחה מוחקת גם את השם שלו מרשימת המשפחה

-- (א) הורה מחליף את שני הקודים. הקודים, הקישורים וה-QR הישנים מפסיקים לעבוד מיד
create or replace function regenerate_codes()
returns table (invite_code text, child_code text)
language plpgsql security definer set search_path = public, extensions as $$
declare h uuid; code text; ccode text;
begin
  select m.household_id into h from members m where m.user_id = auth.uid() order by m.joined_at limit 1;
  if h is null or not is_parent(h) then raise exception 'not allowed'; end if;
  loop
    code := new_invite_code(8);
    ccode := new_invite_code(8);
    exit when code <> ccode and not exists (select 1 from households x where x.invite_code in (code, ccode) or x.child_code in (code, ccode));
  end loop;
  update households set invite_code = code, child_code = ccode where id = h;
  return query select code, ccode;
end $$;
revoke all on function regenerate_codes() from public, anon;
grant execute on function regenerate_codes() to authenticated;

-- מוחק מרשימת המשפחה (kv 'people') אנשים שהחשבון שלהם כבר לא חבר במשפחה
create or replace function prune_people(h uuid) returns void
language sql security definer set search_path = public as $$
  update kv set value = coalesce((
      select jsonb_agg(p) from jsonb_array_elements(kv.value) p
      where p->>'uid' is null or p->>'uid' = '' or exists (select 1 from members m where m.household_id = h and m.user_id::text = p->>'uid')
    ), '[]'::jsonb)
  where household_id = h and key = 'people' and jsonb_typeof(value) = 'array';
$$;
revoke all on function prune_people(uuid) from public, anon, authenticated;

-- (ב) הסרת בן משפחה: גם השם שלו יורד מהרשימה (בלי "רק שם" שנשאר מאחור)
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
  perform prune_people(h);
end $$;

-- ניקוי חד-פעמי: שמות של חשבונות שכבר הוסרו (למשל "אילה")
do $$ declare r record; begin
  for r in select distinct household_id from kv where key = 'people' loop perform prune_people(r.household_id); end loop;
end $$;
