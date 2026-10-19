-- אבטחת קודי הזמנה: קודים ארוכים יותר למשפחות חדשות + הגבלת ניסיונות שגויים
-- (קודים קיימים ממשיכים לעבוד — ההגבלה מגינה עליהם מניחוש)

create table if not exists join_attempts (
  id bigserial primary key,
  user_id uuid,
  at timestamptz not null default now()
);
create index if not exists join_attempts_at on join_attempts (at);
create index if not exists join_attempts_user on join_attempts (user_id, at);
alter table join_attempts enable row level security; -- אין גישה מהאפליקציה, רק מהפונקציה

-- קוד אקראי בלי אותיות מבלבלות (בלי 0/O, 1/I/L)
create or replace function new_invite_code(len int default 8) returns text
language plpgsql volatile set search_path = public, extensions as $$
declare abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; res text := ''; b bytea := gen_random_bytes(len);
begin
  for i in 0..len - 1 loop
    res := res || substr(abc, 1 + (get_byte(b, i) % length(abc)), 1);
  end loop;
  return res;
end $$;

create or replace function create_household(hname text)
returns table (id uuid, invite_code text)
language plpgsql security definer set search_path = public, extensions as $$
declare h uuid; code text; ccode text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  loop
    code := new_invite_code(8);
    ccode := new_invite_code(8);
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
  -- יותר מדי ניסיונות שגויים: 10 לשעה למשתמש, 300 לשעה בסך הכל
  if (select count(*) from join_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 10
     or (select count(*) from join_attempts where at > now() - interval '1 hour') >= 300 then
    raise exception 'too many tries';
  end if;
  select households.id, 'parent' into h, r from households where households.invite_code = upper(trim(code));
  if h is null then
    select households.id, 'child' into h, r from households where households.child_code = upper(trim(code));
  end if;
  if h is null then
    insert into join_attempts (user_id) values (auth.uid());
    delete from join_attempts where at < now() - interval '1 day';
    return null; -- (לא זורקים שגיאה — אחרת הרישום של הניסיון היה מתבטל)
  end if;
  insert into members (household_id, user_id, role) values (h, auth.uid(), r) on conflict do nothing;
  return h;
end $$;

revoke all on function new_invite_code(int) from public, anon, authenticated;
