-- =====================================================================
-- Fripoint Route Intelligence — esquema inicial (Supabase / Postgres)
-- Referência: POP-LOG-001 v1.1 (minuta). Aplicar via `supabase db push` ou SQL editor.
-- NÃO executar antes da aprovação da política de armazenamento (docs/03-pontos-de-aprovacao.md).
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------- Enumerações alinhadas ao POP ----------
create type event_type as enum (
  'INICIO_ROTA', 'DESLOCAMENTO_PRIMEIRO_CLIENTE', 'CHEGADA_CLIENTE', 'DESCARGA_INICIADA', 'PESAGEM',
  'CLIENTE_SEM_BALANCA', 'PROBLEMA_ENTREGA', 'DESCARGA_FINALIZADA', 'DESLOCAMENTO_CLIENTE', 'FIM_ROTA'
);

create type assessment_result as enum (
  'CONFORME', 'PENDENTE', 'ILEGIVEL_NAO_VERIFICAVEL', 'DIVERGENTE', 'NAO_CONFORME', 'EXCECAO_SEM_BALANCA'
);

create type evidence_kind as enum (
  'FOTO_PLACA', 'FOTO_KM_INICIAL', 'FOTO_COMBUSTIVEL_INICIAL', 'FOTO_NOTA_FISCAL', 'PRINT_GPS', 'LOCALIZACAO_WHATSAPP',
  'FOTO_PESAGEM', 'FOTO_CAIXAS_CONTAVEIS', 'FOTO_NOTA_ASSINADA', 'FOTO_BAU', 'FOTO_KM_FINAL', 'FOTO_COMBUSTIVEL_FINAL', 'OUTRA'
);

create type route_status as enum ('ABERTA', 'ENCERRADA');
create type parse_status as enum ('MATCHED', 'AMBIGUOUS', 'NO_MATCH', 'MEDIA', 'LOCATION');
create type event_origin as enum ('PARSER', 'IA_CLASSIFICACAO');
create type alert_kind as enum (
  'DIVERGENCIA_PESO', 'EVIDENCIA_ILEGIVEL', 'MENSAGEM_AMBIGUA', 'PROBLEMA_RELATADO', 'SEQUENCIA_IRREGULAR',
  'CLIENTE_SEM_BALANCA', 'SUSPEITA_REUSO_IMAGEM', 'DUVIDA_MOTORISTA', 'PENDENCIA_ATRASADA'
);
create type alert_severity as enum ('INFO', 'ATENCAO', 'URGENTE');
create type review_kind as enum ('MENSAGEM_AMBIGUA', 'EVIDENCIA_BAIXA_CONFIANCA', 'EVENTO_CLASSIFICADO_POR_IA');

-- ---------- Cadastros ----------
create table drivers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  first_name text not null,
  whatsapp_group_id text not null unique,          -- grupo "Gestão de Rota — Nome do Motorista"
  phone text,
  active boolean not null default true,
  consent_acknowledged_at timestamptz,             -- ciência/treinamento (POP 8)
  created_at timestamptz not null default now()
);

create table clients (
  code text primary key,                           -- "COD. XXXX"
  name text not null,
  address text,
  latitude double precision,
  longitude double precision,
  arrival_radius_meters integer,                   -- null = referência não confiável: não conferir localização
  has_scale boolean,                               -- null = desconhecido
  created_at timestamptz not null default now()
);

-- ---------- Parâmetros gerenciais (ver docs/03-pontos-de-aprovacao.md) ----------
create table system_settings (
  key text primary key,
  value jsonb,                                     -- null = não parametrizado
  description text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into system_settings (key, value, description) values
  ('operation_phase', '"A"', 'Fase do POP 5.1: A = auditoria silenciosa; B = instrutor interativo (somente após autorização formal)'),
  ('weighing_tolerance_kg', 'null', 'Tolerância de pesagem em kg. null = o POP não define tolerância; toda diferença é sinalizada'),
  ('pending_to_nonconform_after_route_end_minutes', 'null', 'Marco para PENDENTE → NÃO CONFORME após FIM DE ROTA. null = nunca automaticamente'),
  ('min_classification_confidence', '0.85', 'Confiança mínima da IA para registrar evento a partir de mensagem fora do padrão (sempre com needs_review)'),
  ('min_evidence_confidence', '0.6', 'Confiança mínima da análise de foto; abaixo disso a evidência entra em revisão humana'),
  ('instructor_repeat_window_minutes', '60', 'Janela anti-repetição das orientações da Fase B'),
  ('post_route_grace_minutes', '240', 'Minutos após FIM DE ROTA em que mensagens ainda pertencem à rota encerrada'),
  ('alert_pending_after_minutes', 'null', 'Prazo para alertar pendência sem regularização (parametrização gerencial pendente)'),
  ('retention_days_media', 'null', 'Retenção de imagens em dias (definir na política LGPD)'),
  ('retention_days_messages', 'null', 'Retenção de mensagens em dias (definir na política LGPD)');

-- ---------- Rotas e mensagens ----------
create table routes (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references drivers(id),
  route_date date,                                 -- data declarada no INICIO DE ROTA
  status route_status not null default 'ABERTA',
  opened_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index routes_driver_status_idx on routes (driver_id, status, opened_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id),
  provider_message_id text not null unique,        -- idempotência
  group_id text not null,
  sender_id text not null,
  received_at timestamptz not null,                -- data do recebimento (distinta da captura)
  text text,
  has_media boolean not null default false,
  media_mime_type text,
  location jsonb,
  parse_status parse_status not null,
  parse_reason text,
  created_at timestamptz not null default now()
);
create index messages_route_idx on messages (route_id, received_at);

create table route_events (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  source_message_id uuid not null references messages(id),   -- referência obrigatória (POP 5.2)
  event_type event_type not null,
  client_code text,
  occurred_at timestamptz not null,
  origin event_origin not null default 'PARSER',
  needs_review boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index route_events_route_idx on route_events (route_id, occurred_at);

create table evidences (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  source_message_id uuid not null references messages(id),
  kind evidence_kind not null,
  result assessment_result not null,
  received_at timestamptz not null,
  captured_at timestamptz,                         -- EXIF quando disponível
  client_code text,                                -- vinculação explícita; null = por contexto cronológico
  storage_path text,                               -- bucket/caminho no Supabase Storage
  sha256 text,                                     -- detecção de imagem idêntica (averiguação humana)
  fields jsonb,                                    -- campos extraídos (pesos originais em kg, placa, KM...)
  analysis jsonb,                                  -- saída estruturada completa da IA
  reason text,
  needs_review boolean not null default false,
  served_by_model text,                            -- trilha: modelo que analisou (inclui fallback)
  created_at timestamptz not null default now()
);
create index evidences_route_idx on evidences (route_id, received_at);
create index evidences_sha_idx on evidences (sha256);

create table route_status_snapshots (
  id bigserial primary key,
  route_id uuid not null references routes(id),
  status jsonb not null,                           -- RouteStatus calculado pelo software
  created_at timestamptz not null default now()
);
create index route_status_snapshots_route_idx on route_status_snapshots (route_id, created_at desc);

-- ---------- Supervisão ----------
create table alerts (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  kind alert_kind not null,
  severity alert_severity not null,
  title text not null,
  details jsonb not null default '{}',
  source_message_id uuid references messages(id),
  notified_at timestamptz,                         -- preenchido pelo n8n ao notificar a supervisão
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz not null default now()
);
create index alerts_pending_idx on alerts (created_at) where acknowledged_at is null;

create table review_items (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  source_message_id uuid not null references messages(id),
  kind review_kind not null,
  payload jsonb not null default '{}',
  decision text,                                   -- decisão humana registrada
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table instructor_messages (                 -- Fase B (log; sent=false até ativação autorizada)
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  trigger text not null,
  item_keys text[] not null default '{}',
  message text not null,
  sent boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index instructor_messages_route_idx on instructor_messages (route_id, created_at desc);

create table route_reports (
  route_id uuid primary key references routes(id),
  generated_at timestamptz not null,
  status jsonb not null,
  narrative jsonb not null,
  markdown text not null,
  served_by_model text,
  delivered_at timestamptz,                        -- preenchido pelo n8n ao enviar à supervisão
  created_at timestamptz not null default now()
);

create table audit_log (                           -- trilha de acesso/alteração (POP 7)
  id bigserial primary key,
  actor text not null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Segurança (POP 7: acesso restrito por função, trilha de auditoria) ----------
-- O serviço backend usa service_role (bypassa RLS). Usuários humanos (dashboard) usam roles abaixo.
alter table drivers enable row level security;
alter table clients enable row level security;
alter table system_settings enable row level security;
alter table routes enable row level security;
alter table messages enable row level security;
alter table route_events enable row level security;
alter table evidences enable row level security;
alter table route_status_snapshots enable row level security;
alter table alerts enable row level security;
alter table review_items enable row level security;
alter table instructor_messages enable row level security;
alter table route_reports enable row level security;
alter table audit_log enable row level security;

-- Papel "supervisao": leitura de tudo; escrita em alertas (ack), revisões e configurações.
-- O claim `app_role` deve ser inserido no JWT (Supabase Auth hook) — a definir pela TI.
create or replace function app_role() returns text language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'app_role', '')
$$;

do $$
declare t text;
begin
  foreach t in array array['drivers','clients','system_settings','routes','messages','route_events','evidences',
                           'route_status_snapshots','alerts','review_items','instructor_messages','route_reports','audit_log']
  loop
    execute format('create policy %I_supervisao_read on %I for select using (app_role() in (''supervisao'',''gestao''))', t, t);
  end loop;
end $$;

create policy alerts_supervisao_ack on alerts for update using (app_role() in ('supervisao','gestao'));
create policy review_items_supervisao_decide on review_items for update using (app_role() in ('supervisao','gestao'));
create policy system_settings_gestao_write on system_settings for update using (app_role() = 'gestao');

-- ---------- Storage: bucket privado para evidências ----------
insert into storage.buckets (id, name, public) values ('evidencias', 'evidencias', false)
  on conflict (id) do nothing;

create policy evidencias_supervisao_read on storage.objects
  for select using (bucket_id = 'evidencias' and app_role() in ('supervisao','gestao'));

-- ---------- Retenção (POP 7) — ativar somente após a política LGPD definir prazos ----------
-- Exemplo (desativado): select cron.schedule('purge-media', '0 3 * * *', $$ ... $$);
