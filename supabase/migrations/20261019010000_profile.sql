-- אזור אישי: שינוי שם משפחה, ויציאה ממשפחה (כדי לעבור למשפחה אחרת)

create or replace function rename_household(new_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  select household_id into h from members where user_id = auth.uid() order by joined_at limit 1;
  if h is null or not is_parent(h) then raise exception 'not allowed'; end if;
  if coalesce(trim(new_name), '') = '' then raise exception 'empty'; end if;
  update households set name = left(trim(new_name), 60) where id = h;
end $$;

-- יוצאים מהמשפחה. אם לא נשאר אף אחד — המשפחה ונתוניה נמחקים.
-- הורה אחרון לא יכול לצאת כשיש עוד בני משפחה (קודם להפוך מישהו אחר להורה).
create or replace function leave_household()
returns void
language plpgsql security definer set search_path = public as $$
declare h uuid; others int; other_parents int;
begin
  select household_id into h from members where user_id = auth.uid() order by joined_at limit 1;
  if h is null then return; end if;
  select count(*) into others from members where household_id = h and user_id <> auth.uid();
  select count(*) into other_parents from members where household_id = h and user_id <> auth.uid() and role = 'parent';
  if others > 0 and other_parents = 0 and is_parent(h) then raise exception 'last parent'; end if;
  delete from members where household_id = h and user_id = auth.uid();
  if others = 0 then delete from households where id = h; end if;
end $$;
