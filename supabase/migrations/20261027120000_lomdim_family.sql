-- 👨‍👩‍👧 לומדים בכיף: משפחה משותפת בין כמה טלפונים (בקשת המשתמש, 27.10, אפשרות א' עם הצפנה)
-- כל מה שנשמר כאן מוצפן בטלפון (AES-GCM) לפני שהוא נשלח. לשרת אין את המפתח: הוא רואה רק טקסט מוצפן.
-- המפתח עובר מטלפון לטלפון רק בקישור / QR (בחלק שאחרי #, שלא נשלח לשום שרת).

create table if not exists lomdim_families (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  join_hash text not null,                     -- sha256 של סוד ההצטרפות (הסוד עצמו לא נשמר)
  created_at timestamptz not null default now()
);
create table if not exists lomdim_members (
  family_id uuid not null references lomdim_families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create table if not exists lomdim_blobs (
  family_id uuid not null references lomdim_families(id) on delete cascade,
  k text not null check (length(k) between 1 and 80),          -- למשל: family, kid:<id>, photos:<id>
  iv text not null check (length(iv) < 64),
  data text not null check (length(data) < 4000000),           -- טקסט מוצפן (base64)
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (family_id, k)
);

create or replace function lomdim_is_member(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from lomdim_members where family_id = f and user_id = auth.uid());
$$;

alter table lomdim_families enable row level security;
alter table lomdim_members enable row level security;
alter table lomdim_blobs enable row level security;
drop policy if exists "lomdim fam read" on lomdim_families;
create policy "lomdim fam read" on lomdim_families for select to authenticated using (lomdim_is_member(id));
drop policy if exists "lomdim members read" on lomdim_members;
create policy "lomdim members read" on lomdim_members for select to authenticated using (lomdim_is_member(family_id));
drop policy if exists "lomdim blobs all" on lomdim_blobs;
create policy "lomdim blobs all" on lomdim_blobs for all to authenticated
  using (lomdim_is_member(family_id)) with check (lomdim_is_member(family_id));

-- יצירת משפחה: מי שיוצר נהיה חבר. אם הוא כבר במשפחה, מחזירים אותה
create or replace function lomdim_create_family(p_join_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f uuid;
begin
  if auth.uid() is null or length(coalesce(p_join_hash, '')) <> 64 then raise exception 'bad'; end if;
  select family_id into f from lomdim_members where user_id = auth.uid() limit 1;
  if f is not null then return f; end if;
  insert into lomdim_families (join_hash) values (p_join_hash) returning id into f;
  insert into lomdim_members (family_id, user_id) values (f, auth.uid());
  return f;
end $$;

-- הצטרפות עם הסוד שבקישור. עד 6 חברים במשפחה, ועד 10 ניסיונות לא נכונים ביום
create table if not exists lomdim_join_fails (user_id uuid, at timestamptz default now());
alter table lomdim_join_fails enable row level security;
create or replace function lomdim_join(p_family uuid, p_secret text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if (select count(*) from lomdim_join_fails where user_id = auth.uid() and at > now() - interval '1 day') >= 10 then return false; end if;
  if not exists (select 1 from lomdim_families where id = p_family and join_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')) then
    insert into lomdim_join_fails (user_id) values (auth.uid()); return false;
  end if;
  if (select count(*) from lomdim_members where family_id = p_family) >= 6 then return false; end if;
  delete from lomdim_members where user_id = auth.uid() and family_id <> p_family;   -- טלפון אחד = משפחה אחת
  insert into lomdim_members (family_id, user_id) values (p_family, auth.uid()) on conflict do nothing;
  return true;
end $$;

create or replace function lomdim_my_family() returns uuid
language sql stable security definer set search_path = public as $$
  select family_id from lomdim_members where user_id = auth.uid() order by joined_at limit 1;
$$;

create or replace function lomdim_leave() returns void
language plpgsql security definer set search_path = public as $$
begin delete from lomdim_members where user_id = auth.uid(); end $$;

grant execute on function lomdim_create_family(text), lomdim_join(uuid, text), lomdim_my_family(), lomdim_leave(), lomdim_is_member(uuid) to authenticated;
