-- הערות מדפי דוח/תוכנית/סימולטור (הכלי ב"הערות-בדף") נכנסות בלי התחברות.
-- מותר רק להוסיף, רק עם kind='הערה מדוח', בלי משתמש ובלי משק בית. אין הרשאת קריאה בלי התחברות.
-- אישר מוישי 5.11.2026.
drop policy if exists "report notes anon" on feedback;
create policy "report notes anon" on feedback for insert to anon
  with check (kind = 'הערה מדוח' and user_id is null and household_id is null and length(message) < 5000);
