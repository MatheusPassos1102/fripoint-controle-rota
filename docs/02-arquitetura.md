# 02 — Arquitetura proposta: Fripoint Route Intelligence

Objetivo: auditoria em tempo real das rotas dos oito motoristas (análise de fotos, conferência de pesagens,
identificação de não conformidades, relatório de encerramento) e, após autorização, orientação educativa
ao motorista — com Claude API, n8n e Supabase, conforme o POP-LOG-001 v1.1.

## 1. Visão geral

```
 8 grupos WhatsApp                 n8n (integração e agenda)                 Serviço Route Intelligence (Node/TS)
 "Gestão de Rota — <Motorista>"                                             ┌──────────────────────────────────────┐
 ┌──────────────┐  webhook   ┌──────────────────────────┐  POST /ingest     │ parser Anexo A (determinístico)       │
 │ texto/foto/  │──────────▶ │ WF-01 Ingestão           │─────────────────▶ │ ↓ ambíguo? → Claude: classificação    │
 │ localização  │            │ (normaliza o provedor)   │                   │ foto → Storage → Claude: análise      │
 └──────────────┘            └──────────────────────────┘                   │ ↓ regras de pesagem (software)        │
        ▲                    ┌──────────────────────────┐  GET /alerts      │ motor de estado da rota (software)    │
        │ Fase B somente     │ WF-02 Alertas (cron 5')  │◀────────────────▶ │ alertas / itens de revisão            │
        │ (desativado)       └──────────────────────────┘                   │ Claude: narrativa do relatório        │
        │                    ┌──────────────────────────┐  POST /report     │ Claude: orientação Fase B (sugestão)  │
        │                    │ WF-03 Relatório          │◀────────────────▶ └───────────────┬──────────────────────┘
        │                    └──────────────────────────┘                                   │ supabase-js (service_role)
        │                    ┌──────────────────────────┐  webhook                          ▼
        └────────────────────│ WF-04 Instrutor Fase B   │◀─────────────────  Supabase: Postgres (RLS) + Storage privado
                             └──────────────────────────┘
                                        │ e-mail / WhatsApp
                                        ▼
                                   Supervisão (humana)
```

Divisão de responsabilidades:

| Camada | Responsabilidade | Nunca faz |
|---|---|---|
| **n8n** | Receber webhooks do provedor WhatsApp, normalizar payload, agendar varreduras, notificar supervisão, enviar relatórios, (Fase B) enviar orientação ao grupo | Regras de negócio, chamadas à Claude |
| **Serviço (TypeScript)** | Parser, motor de estado, regras de pesagem, chamadas à Claude, persistência, alertas, relatório | Falar com o motorista diretamente |
| **Claude API** | Ler fotos (visão), classificar mensagens fora do padrão, redigir orientação e narrativa | Calcular diferença de peso, decidir conformidade da rota, aplicar sanção, vincular cliente por palpite |
| **Supabase** | Banco (Postgres + RLS por papel), Storage privado de evidências, parâmetros gerenciais, trilha de auditoria | — |

## 2. Fluxo de uma mensagem (tempo real)

1. **n8n WF-01** recebe o webhook do provedor, normaliza para o contrato `InboundMessage` e chama `POST /v1/messages/ingest`.
2. O serviço identifica o motorista pelo grupo, garante idempotência (`providerMessageId`) e localiza a rota aberta
   (ou abre uma no INICIO DE ROTA; ou anexa à rota recém-encerrada dentro da janela de tolerância).
3. **Texto:** parser do Anexo A. Casou → evento. Ambíguo/livre → Claude classifica; só vira evento com confiança
   ≥ 0,85 **e** código escrito na mensagem, sempre marcado `needs_review`; senão, item de revisão humana.
4. **Foto:** bytes → SHA-256 (detecção de imagem idêntica) → Storage privado → Claude (visão, saída estruturada)
   → tipo de evidência + campos lidos. Pesagem: `assessWeighing` calcula a diferença em software.
5. **Localização nativa:** CONFORME; se o cliente tiver referência confiável cadastrada, confere o raio.
6. **Motor de estado** recalcula o checklist (saída, clientes, retorno), os problemas de sequência e a próxima etapa.
7. **Alertas** novos (divergência, ilegível, ambígua, problema, sem balança, reuso de imagem, sequência, dúvida)
   são persistidos e, se configurado, enviados ao n8n (WF-02 também varre pendentes a cada 5 min).
8. **FIM DE ROTA** encerra a rota e aciona WF-03, que aguarda as fotos do retorno e pede o relatório.
9. **Fase B** (se `OPERATION_PHASE=B`): o serviço gera a sugestão do instrutor, registra com `sent=false` e envia ao
   webhook do WF-04, que só repassa ao grupo se `FRIPOINT_PHASE_B_AUTHORIZED=true`.

Código: `src/pipeline/ingest.ts` (fluxo), `src/domain/*` (regras), `src/claude/*` (IA), `src/db/*` (persistência),
`src/service/server.ts` (HTTP). `npm run simulate` executa tudo offline com repositório em memória e IA simulada.

## 3. Uso da Claude API

| Operação | Entrada | Saída estruturada (Zod) | Esforço | Quando |
|---|---|---|---|---|
| Análise de evidência (visão) | imagem base64 + contexto da rota + legenda | tipo, legibilidade, campos (pesos em kg, placa, KM, nota...), problemas, indícios de reuso, confiança | `high` | cada foto |
| Classificação de mensagem | texto + etapa atual | evento ou null, código **escrito**, dúvida/problema, confiança | `medium` | só quando o parser falha |
| Instrutor (Fase B) | próxima etapa, itens faltantes, orientações recentes, boas práticas | `should_send`, mensagem, o que/como/por quê | `low` | após ativação autorizada |
| Narrativa do relatório | JSON do estado calculado pelo software | manchete, resumo, pontos de atenção, reciclagem, boas práticas | `medium` | encerramento da rota |

Decisões técnicas:

- **Modelo:** `claude-opus-5-5` para todas as operações (configurável por `CLAUDE_MODEL`). Thinking adaptativo é o
  padrão do modelo; a profundidade é controlada por `output_config.effort` por operação.
- **Saída estruturada** (`output_config.format` com esquema Zod) + validação no cliente: a IA não devolve texto livre
  para o software interpretar.
- **Prompt caching:** prompts de sistema estáveis, marcados com `cache_control`; dados variáveis só na mensagem do usuário.
- **Fallback server-side** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): se o classificador de
  segurança recusar uma requisição (falso positivo em foto de documento, por exemplo), a API reexecuta em outro modelo
  na mesma chamada. Está **ligado por padrão** (`CLAUDE_SERVER_FALLBACK=true`) e o modelo que respondeu fica gravado
  em `evidences.served_by_model` para trilha. Pode ser desligado se a Fripoint preferir que recusas virem "PENDENTE".
- **Recusa residual** (`stop_reason: refusal`): a foto fica guardada como PENDENTE com `needs_review`; nada é perdido.
- **Sem prefill, sem `tool_choice` forçado** (não suportados na família 5.x); o esquema de saída cumpre o papel.

Estimativa de custo (ordem de grandeza, a medir no piloto): ~2,5 mil tokens de sistema em cache + ~1,5 mil tokens por
foto + ~400 de saída ≈ US$ 0,02 por foto. Com 8 motoristas × ~10 clientes × ~8 fotos/dia ≈ 640 fotos/dia ≈ US$ 13/dia
na análise de fotos; classificação e relatório são marginais. A Fase B adiciona uma chamada curta por etapa.

## 4. Modelo de dados (Supabase)

Migração: `supabase/migrations/0001_initial_schema.sql`. Tabelas principais:

| Tabela | Conteúdo |
|---|---|
| `drivers`, `clients` | 8 motoristas (grupo ↔ motorista), clientes com código, endereço de referência e raio |
| `system_settings` | parâmetros gerenciais (tolerância, marcos, confiança mínima, fase, retenção) — todos os sensíveis nascem **nulos** |
| `routes` | uma por INICIO DE ROTA; `ABERTA`/`ENCERRADA` |
| `messages` | toda mensagem recebida, com `provider_message_id` único (idempotência) e `parse_status` |
| `route_events` | eventos do Anexo A com origem (`PARSER` ou `IA_CLASSIFICACAO`) e `needs_review` |
| `evidences` | fotos/localizações classificadas: tipo, resultado, campos lidos (valores originais em kg), `storage_path`, `sha256`, análise completa, modelo que respondeu |
| `route_status_snapshots` | estado calculado após cada mensagem (histórico) |
| `alerts`, `review_items` | fila da supervisão (reconhecimento e decisão humana registrados) |
| `instructor_messages` | log da Fase B (`sent=false` até ativação) |
| `route_reports` | relatório (JSON + Markdown) |
| `audit_log` | trilha de acesso/alteração (POP 7) |

Segurança: RLS ligado em todas as tabelas; papéis `supervisao` (leitura + reconhecer/decidir) e `gestao` (+ parâmetros)
via claim `app_role` no JWT; bucket `evidencias` privado; o serviço usa `service_role` apenas no backend.
**A migração não deve ser aplicada antes da política de armazenamento (A2).**

## 5. Fases de implantação

| Fase | Escopo | Pré-requisitos |
|---|---|---|
| 0. Preparação (esta entrega) | Análise, arquitetura, código do núcleo com testes, esquema, workflows, pontos de aprovação | — |
| 1. Piloto Fase A silencioso (1–2 motoristas) | Ingestão real, alertas e relatório para a supervisão; sem contato com motoristas | A1, A2, A3, A9, A10 |
| 2. Fase A completa (8 motoristas) | Parametrização de tolerância/marcos com base no piloto; cadastro de referências de clientes | A4, A6, A7, A11 |
| 3. Fase B (instrutor) | Orientação no grupo, revisada pela supervisão nas primeiras semanas | A5 + treinamento (POP 8) |
| 4. Evolução | Leitura de nota fiscal para cobertura de caixas, painel da supervisão, retenção automática | A8, A12 |

## 6. Hospedagem e operação (proposta)

- **Serviço:** container Node 20+ (Docker) em VPS/Cloud Run/Railway; variáveis em `.env.example`; token Bearer para o n8n.
- **n8n:** self-hosted (recomendado por LGPD — dados não passam por terceiros) ou n8n Cloud.
- **Supabase:** projeto dedicado, região mais próxima do Brasil disponível; backups diários.
- **Observabilidade:** `evidences.served_by_model`, `usage` da API logado por chamada; alertas de erro do serviço via n8n.

## 7. O que esta entrega não faz (de propósito)

- Não conecta a nenhum provedor de WhatsApp, não aplica a migração no Supabase, não chama a Claude API.
- Não define tolerâncias, prazos ou sanções.
- Não envia nada a motoristas (Fase B desativada em duas camadas).
