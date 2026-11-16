-- Jane's pots: database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once. Works on a brand-new project or on the claimed Bolt database.

-- 1. Tables ---------------------------------------------------------------
create table if not exists public.pieces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  title text not null,
  description text,
  stage text not null default 'new',
  is_graveyard boolean not null default false,
  is_commission boolean not null default false,
  priority int,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  display_order bigint default 0
);

-- New fields used by the rebuilt app
alter table public.pieces add column if not exists glaze text;
alter table public.pieces add column if not exists clay text;
alter table public.pieces add column if not exists due_date date;
alter table public.pieces add column if not exists stage_dates jsonb not null default '{}'::jsonb;

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid references public.pieces(id) on delete cascade,
  url text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2. Only signed-in users can read or change anything ---------------------
alter table public.pieces enable row level security;
alter table public.photos enable row level security;

do $$
declare r record;
begin
  -- remove any older open policies (e.g. from Bolt)
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('pieces','photos') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

create policy "signed in: all" on public.pieces for all to authenticated using (true) with check (true);
create policy "signed in: all" on public.photos for all to authenticated using (true) with check (true);

-- 3. Photo storage ---------------------------------------------------------
-- Photos are viewable by link (file names are random); only you can upload or delete.
insert into storage.buckets (id, name, public)
values ('piece-photos', 'piece-photos', true)
on conflict (id) do update set public = true;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname like 'pots:%' loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

create policy "pots: upload" on storage.objects for insert to authenticated with check (bucket_id = 'piece-photos');
create policy "pots: update" on storage.objects for update to authenticated using (bucket_id = 'piece-photos');
create policy "pots: delete" on storage.objects for delete to authenticated using (bucket_id = 'piece-photos');
