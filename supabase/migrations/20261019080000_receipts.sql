-- 🧾 צילומי קבלות: תיקייה פרטית לכל משפחה (receipts/<household_id>/<tx_id>.jpg)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 1048576, array['image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- עוזר: מספר המשפחה מתוך שם הקובץ (בלי לקרוס על שם לא תקין)
create or replace function receipt_hh(name text) returns uuid
language plpgsql immutable as $$
begin return (split_part(name, '/', 1))::uuid; exception when others then return null; end $$;

drop policy if exists "receipts read" on storage.objects;
create policy "receipts read" on storage.objects for select
  using (bucket_id = 'receipts' and (is_parent(receipt_hh(name)) or (is_member(receipt_hh(name)) and owner = auth.uid())));
drop policy if exists "receipts add" on storage.objects;
create policy "receipts add" on storage.objects for insert
  with check (bucket_id = 'receipts' and is_member(receipt_hh(name)));
drop policy if exists "receipts change" on storage.objects;
create policy "receipts change" on storage.objects for update
  using (bucket_id = 'receipts' and (is_parent(receipt_hh(name)) or owner = auth.uid()));
drop policy if exists "receipts remove" on storage.objects;
create policy "receipts remove" on storage.objects for delete
  using (bucket_id = 'receipts' and (is_parent(receipt_hh(name)) or owner = auth.uid()));
