/**
 * Serviço HTTP chamado pelo n8n. Sem framework (node:http) para manter a superfície mínima.
 *
 * Endpoints (todos exigem Authorization: Bearer SERVICE_API_TOKEN, exceto /healthz):
 *   POST /v1/messages/ingest          mensagem canônica do WhatsApp (ver InboundMessage)
 *   GET  /v1/routes?status=ABERTA     rotas
 *   GET  /v1/routes/:id/status        estado documental atual
 *   POST /v1/routes/:id/report        gera (ou regenera) o relatório de encerramento
 *   GET  /v1/routes/:id/report        último relatório
 *   GET  /v1/alerts/pending           alertas não reconhecidos (para o n8n notificar a supervisão)
 *   POST /v1/alerts/:id/ack           { by: "nome" }
 *   GET  /healthz
 *
 * O serviço só se conecta a Supabase/Claude quando as variáveis estão configuradas; sem elas,
 * sobe em modo simulação (repositório em memória + IA stub) para desenvolvimento local.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { InMemoryRepository } from "../db/in-memory-repository.js";
import type { Repository } from "../db/repository.js";
import { SupabaseRepository, supabaseConfigFromEnv } from "../db/supabase-repository.js";
import { createClaudeAiPort, createStubAiPort, type AiPort } from "../pipeline/ai-port.js";
import { ingestMessage, type OutboundNotification } from "../pipeline/ingest.js";
import { buildRouteReport } from "../pipeline/report.js";
import { parseInboundMessage } from "./inbound-schema.js";

export interface ServiceContext {
  repo: Repository;
  ai: AiPort;
  phase: "A" | "B";
  token: string | null;
  notify?: (event: OutboundNotification) => Promise<void>;
  fetchMedia?: (url: string) => Promise<Uint8Array>;
  simulation: boolean;
}

export async function buildContextFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ServiceContext> {
  const supa = supabaseConfigFromEnv(env);
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY);
  const simulation = !supa || !hasClaude;
  const repo: Repository = supa ? new SupabaseRepository(supa) : new InMemoryRepository();
  const ai: AiPort = hasClaude ? await createClaudeAiPort() : createStubAiPort();
  const phase = env.OPERATION_PHASE === "B" ? "B" : "A";

  const webhooks = {
    ALERT: env.N8N_WEBHOOK_ALERT || null,
    ROUTE_CLOSED: env.N8N_WEBHOOK_ROUTE_CLOSED || null,
    INSTRUCTOR_SUGGESTION: env.N8N_WEBHOOK_INSTRUCTOR || null,
  };
  const notify = async (event: OutboundNotification) => {
    const url = webhooks[event.type];
    if (!url) return;
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  };
  const fetchMedia = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

  return { repo, ai, phase, token: env.SERVICE_API_TOKEN || null, notify, fetchMedia, simulation };
}

export function createApp(ctx: ServiceContext) {
  return createServer(async (req, res) => {
    try {
      await route(ctx, req, res);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function route(ctx: ServiceContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/healthz") {
    return json(res, 200, { ok: true, phase: ctx.phase, simulation: ctx.simulation });
  }
  if (!authorized(ctx, req)) return json(res, 401, { error: "não autorizado" });

  if (method === "POST" && path === "/v1/messages/ingest") {
    const body = await readJson(req);
    const parsed = parseInboundMessage(body);
    if (!parsed.ok) return json(res, 400, { error: "payload inválido", issues: parsed.issues });
    const result = await ingestMessage({ repo: ctx.repo, ai: ctx.ai, phase: ctx.phase, notify: ctx.notify, fetchMedia: ctx.fetchMedia }, parsed.data);
    return json(res, result.accepted ? 200 : 202, result);
  }

  if (method === "GET" && path === "/v1/routes") {
    const status = url.searchParams.get("status");
    const routes = await ctx.repo.listRoutes({ status: status === "ABERTA" || status === "ENCERRADA" ? status : undefined });
    return json(res, 200, { routes });
  }

  let m = path.match(/^\/v1\/routes\/([^/]+)\/status$/);
  if (method === "GET" && m) {
    const status = await ctx.repo.getLatestRouteStatus(m[1]!);
    return status ? json(res, 200, status) : json(res, 404, { error: "rota sem estado calculado" });
  }

  m = path.match(/^\/v1\/routes\/([^/]+)\/report$/);
  if (m && method === "POST") {
    const report = await buildRouteReport({ repo: ctx.repo, ai: ctx.ai }, m[1]!);
    return json(res, 200, report);
  }
  if (m && method === "GET") {
    const report = await ctx.repo.getReport(m[1]!);
    return report ? json(res, 200, report) : json(res, 404, { error: "relatório não gerado" });
  }

  if (method === "GET" && path === "/v1/alerts/pending") {
    return json(res, 200, { alerts: await ctx.repo.listPendingAlerts() });
  }
  m = path.match(/^\/v1\/alerts\/([^/]+)\/ack$/);
  if (method === "POST" && m) {
    const body = (await readJson(req)) as { by?: string };
    await ctx.repo.acknowledgeAlert(m[1]!, body?.by ?? "n8n");
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "rota não encontrada" });
}

function authorized(ctx: ServiceContext, req: IncomingMessage): boolean {
  if (!ctx.token) return ctx.simulation; // sem token só em simulação local
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${ctx.token}`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Entrada: `npm run dev` / `npm start`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const ctx = await buildContextFromEnv();
  const port = Number(process.env.PORT || 8080);
  createApp(ctx).listen(port, () => {
    console.log(`Fripoint Route Intelligence ouvindo em :${port} — fase ${ctx.phase}${ctx.simulation ? " (modo simulação: sem Supabase/Claude)" : ""}`);
  });
}
