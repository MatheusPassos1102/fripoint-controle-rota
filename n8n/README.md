# Workflows n8n

Quatro workflows exportáveis (importar em **Workflows → Import from file**). Todos chamam o serviço
`fripoint-route-intelligence` via HTTP e usam duas credenciais a criar no n8n:

| Credencial (Header Auth) | Header | Valor |
|---|---|---|
| `Fripoint Service Token` | `Authorization` | `Bearer <SERVICE_API_TOKEN>` |
| `WhatsApp Provider` | conforme o provedor escolhido | a definir (ver ponto de aprovação A1) |

Variáveis de ambiente do n8n: `FRIPOINT_SERVICE_URL` (ex.: `https://route-intelligence.interno`),
`SUPERVISAO_EMAIL`, `SUPERVISAO_WHATSAPP` (opcional).

| Arquivo | Gatilho | O que faz | Estado |
|---|---|---|---|
| `01-ingestao-whatsapp.json` | Webhook do provedor de WhatsApp | Normaliza o payload do provedor para `InboundMessage` e chama `POST /v1/messages/ingest` | Ativo na Fase A |
| `02-alertas-supervisao.json` | Cron a cada 5 min | Busca `GET /v1/alerts/pending`, notifica a supervisão (e-mail), confirma com `POST /v1/alerts/:id/ack` | Ativo na Fase A |
| `03-relatorio-fim-de-rota.json` | Webhook `route-closed` (acionado pelo serviço) | Gera `POST /v1/routes/:id/report` e envia o Markdown por e-mail | Ativo na Fase A |
| `04-instrutor-fase-b.json` | Webhook `instructor-suggestion` | Envia a orientação ao grupo do motorista via provedor | **Desativado** até autorização formal da Fase B |

## Normalização do payload do provedor (workflow 01)

O nó *Code* `Normalizar mensagem` converte o formato do provedor para o contrato canônico:

```json
{
  "providerMessageId": "wamid...",
  "groupId": "1203630...@g.us",
  "senderId": "5511999990000",
  "receivedAt": "2026-07-27T06:00:00-03:00",
  "text": "INICIO DE ROTA DIA 27/07/2026",
  "media": { "mimeType": "image/jpeg", "url": "https://...", "capturedAt": null },
  "location": { "latitude": -23.55, "longitude": -46.63, "isLive": true }
}
```

O mapeamento concreto depende do provedor (WhatsApp Business Platform, Evolution API, Z-API etc.).
O código entregue cobre um formato genérico e marca com `TODO(provedor)` os pontos a ajustar.
**Nenhum provedor está conectado**: a decisão de canal é o ponto de aprovação A1.

## Idempotência e reprocessamento

O serviço ignora mensagens já processadas pelo `providerMessageId`. Reenviar o webhook (retry do n8n) é seguro.

## Fase B

O workflow 04 fica desativado. Mesmo ativo, só recebe sugestões quando o serviço roda com
`OPERATION_PHASE=B`, e o serviço só gera sugestões quando esta variável está definida. Dupla trava proposital.
