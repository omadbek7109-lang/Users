-- Supabase grants every new sequence/function in `public` to anon/authenticated by default.
-- The bot only talks to the database with service_role, so remove those grants too.
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
