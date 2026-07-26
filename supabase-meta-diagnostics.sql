-- Run once in Supabase SQL Editor to enable the dashboard Meta response viewer.
alter table public.events add column if not exists meta_http_status integer;
alter table public.events add column if not exists meta_events_received integer;
alter table public.events add column if not exists meta_trace_id text;
alter table public.events add column if not exists meta_response jsonb;
