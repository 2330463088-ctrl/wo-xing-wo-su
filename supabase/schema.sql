create table if not exists public.woxingwosu_case_drafts (
  id uuid primary key default gen_random_uuid(),
  user_email text not null unique,
  display_name text,
  draft jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists woxingwosu_case_drafts_updated_at_idx
  on public.woxingwosu_case_drafts (updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_woxingwosu_case_drafts_updated_at
  on public.woxingwosu_case_drafts;

create trigger set_woxingwosu_case_drafts_updated_at
before update on public.woxingwosu_case_drafts
for each row
execute function public.set_updated_at();
