# Fripoint Route Intelligence

Auditoria assistida por IA das rotas de entrega da Fripoint Alimentos, conforme o **POP-LOG-001 v1.1** (minuta):
conferência em tempo real das mensagens, fotos e pesagens dos oito motoristas, identificação de não conformidades,
relatório de encerramento para a supervisão e, após autorização formal, orientação educativa ao motorista (Fase B).

Stack: **Claude API** (visão e texto, saída estruturada), **n8n** (integração WhatsApp, agenda, notificações) e
**Supabase** (Postgres com RLS + Storage privado). Núcleo em TypeScript.

> **Estado desta entrega:** análise, arquitetura, núcleo de regras com testes, esquema de banco, workflows n8n e lista
> de pontos de aprovação. **Nenhuma integração externa foi executada**: não há conexão com WhatsApp, Supabase ou
> Claude API. Tudo roda offline em modo simulação.

## Documentos

| Documento | Conteúdo |
|---|---|
| [docs/01-analise-pop-log-001.md](docs/01-analise-pop-log-001.md) | O que o POP exige, como cada regra virou software, lacunas encontradas e decisões adotadas |
| [docs/02-arquitetura.md](docs/02-arquitetura.md) | Componentes, fluxo da mensagem, uso da Claude API, modelo de dados, fases de implantação |
| [docs/03-pontos-de-aprovacao.md](docs/03-pontos-de-aprovacao.md) | 14 decisões que a Fripoint precisa tomar antes de cada fase |
| [n8n/README.md](n8n/README.md) | Como importar e configurar os quatro workflows |

## Estrutura

```
src/domain/        regras determinísticas: parser do Anexo A, motor de estado da rota, pesagens
src/claude/        cliente Claude, prompts (cacheáveis), esquemas de saída, operações de IA
src/pipeline/      ingestão de mensagens, relatório de encerramento, porta de IA (real × simulada)
src/db/            porta de persistência; implementações em memória e Supabase
src/service/       servidor HTTP chamado pelo n8n
supabase/          migração SQL (tabelas, enums do POP, RLS, bucket, parâmetros gerenciais)
n8n/workflows/     01 ingestão · 02 alertas · 03 relatório · 04 instrutor Fase B (desativado)
scripts/           simulação offline de uma rota completa
tests/             48 testes (parser, pesagens, motor de estado, pipeline)
```

## Rodar localmente (sem integrações)

```bash
npm install
npm test            # testes unitários e do pipeline
npm run simulate    # rota completa simulada: mensagens → alertas → relatório
npm run dev         # serviço HTTP em modo simulação (repositório em memória, IA simulada)
```

Com `.env` preenchido (ver `.env.example`), o mesmo serviço passa a usar Supabase e Claude API.
A Fase B exige `OPERATION_PHASE=B` no serviço **e** `FRIPOINT_PHASE_B_AUTHORIZED=true` no n8n.

## Princípios implementados

- A conclusão sobre a rota é **calculada por software** (checklist do Quadro 4); a IA só lê evidências individuais.
- **Nenhuma tolerância de pesagem inventada**: toda diferença é sinalizada até a gestão parametrizar.
- Registro faltante é **PENDENTE**; só vira NÃO CONFORME após marco definido pela gestão (desligado por padrão).
- Mensagem ambígua **nunca** é associada automaticamente a um cliente; vai para revisão humana.
- Suspeita de imagem reaproveitada é "para averiguação humana"; o sistema **não declara fraude**.
- **Nenhuma sanção automática**; Fase A não escreve no grupo do motorista.
