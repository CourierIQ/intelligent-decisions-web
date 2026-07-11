-- Add the Google account used for Google Play closed-testing eligibility.

alter table public.beta_access_requests
    add column if not exists google_play_email text;

-- Existing applicants default to their contact email. New requests provide this
-- explicitly through the website form.
update public.beta_access_requests
set google_play_email = lower(btrim(email))
where google_play_email is null
   or btrim(google_play_email) = '';

alter table public.beta_access_requests
    alter column google_play_email set not null;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'beta_access_google_play_email_format'
          and conrelid = 'public.beta_access_requests'::regclass
    ) then
        alter table public.beta_access_requests
            add constraint beta_access_google_play_email_format
            check (
                google_play_email ~*
                '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'
            );
    end if;
end
$$;

create index if not exists beta_access_google_play_email_idx
on public.beta_access_requests (lower(google_play_email));
