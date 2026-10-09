/**
 * Relatório de encerramento de rota (Fase A, POP 5.1): números e checklists vêm do software;
 * a IA redige apenas a narrativa a partir desses dados.
 */

import { computeRouteStatus, type ChecklistItem, type RouteStatus } from "../domain/route-state.js";
import type { Repository, RouteReportRecord } from "../db/repository.js";
import type { AiPort } from "./ai-port.js";

export async function buildRouteReport(deps: { repo: Repository; ai: AiPort; now?: () => Date }, routeId: string): Promise<RouteReportRecord> {
  const route = await deps.repo.getRoute(routeId);
  if (!route) throw new Error(`rota ${routeId} não encontrada`);
  const driver = await deps.repo.getDriver(route.driverId);
  const settings = await deps.repo.getSettings();
  const now = deps.now?.() ?? new Date();

  const [events, evidences, details] = await Promise.all([deps.repo.listEvents(routeId), deps.repo.listEvidences(routeId), deps.repo.listEvidenceDetails(routeId)]);
  const status = computeRouteStatus(events, evidences, { pendingToNonConformAfterRouteEndMinutes: settings.pendingToNonConformAfterRouteEndMinutes, now, routeDate: route.routeDate });

  const weighingDetails = details
    .filter((d) => d.kind === "FOTO_PESAGEM")
    .map((d) => ({ messageId: d.sourceMessageId, receivedAt: d.receivedAt, result: d.result, labelKg: d.fields?.labelKg ?? null, scaleKg: d.fields?.scaleKg ?? null, reason: d.reason }));

  const narrative = await deps.ai.reportNarrative({ driverName: driver?.fullName ?? "motorista", routeDate: route.routeDate, status, weighingDetails });

  const record: RouteReportRecord = {
    routeId,
    generatedAt: now.toISOString(),
    status,
    narrative: narrative.data,
    markdown: renderMarkdown({ driverName: driver?.fullName ?? "motorista", routeDate: route.routeDate, status, narrative: narrative.data, weighingDetails, generatedAt: now }),
    servedByModel: narrative.servedBy,
  };
  await deps.repo.saveReport(record);
  return record;
}

export function renderMarkdown(input: {
  driverName: string;
  routeDate: string | null;
  status: RouteStatus;
  narrative: { headline: string; summary: string; attention_points: string[]; training_opportunities: string[]; good_practices: string[] };
  weighingDetails: Array<{ messageId: string; receivedAt: string; result: string; labelKg: number | null; scaleKg: number | null; reason: string }>;
  generatedAt: Date;
}): string {
  const { status, narrative } = input;
  const lines: string[] = [];
  lines.push(`# Relatório de encerramento de rota — ${input.driverName}`);
  lines.push(`Data da rota: ${input.routeDate ?? "não informada"} · Gerado em ${input.generatedAt.toISOString()} · Fase A (auditoria silenciosa)`);
  lines.push("");
  lines.push(`**${narrative.headline}**`);
  lines.push("");
  lines.push(narrative.summary);
  lines.push("");
  lines.push("## Resumo documental");
  lines.push("| Resultado | Itens |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(status.counts)) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push("## Saída");
  lines.push(...renderItems(status.departure));
  for (const stop of status.stops) {
    lines.push("");
    lines.push(`## Cliente ${stop.clientCode} (parada ${stop.order})${stop.semBalanca ? " — exceção sem balança" : ""}`);
    lines.push(`Chegada: ${stop.chegadaAt ?? "—"} · Descarga: ${stop.descargaIniciadaAt ?? "—"} → ${stop.descargaFinalizadaAt ?? "—"}`);
    lines.push(`Pesagens: ${stop.weighings.total} recebidas · ${stop.weighings.conformes} conformes · ${stop.weighings.divergentes} divergentes · ${stop.weighings.naoVerificaveis} não verificáveis`);
    lines.push(...renderItems(stop.items));
  }
  lines.push("");
  lines.push("## Retorno ao pátio");
  lines.push(...renderItems(status.returnItems));
  if (input.weighingDetails.length) {
    lines.push("");
    lines.push("## Pesagens (valores originais, kg)");
    lines.push("| Recebida em | Etiqueta | Balança | Resultado | Observação |");
    lines.push("|---|---|---|---|---|");
    for (const w of input.weighingDetails) lines.push(`| ${w.receivedAt} | ${w.labelKg ?? "—"} | ${w.scaleKg ?? "—"} | ${w.result} | ${w.reason} |`);
  }
  if (status.sequenceIssues.length) {
    lines.push("");
    lines.push("## Problemas de sequência");
    for (const s of status.sequenceIssues) lines.push(`- ${s.description}`);
  }
  section(lines, "Pontos para avaliação da supervisão", narrative.attention_points);
  section(lines, "Oportunidades de reciclagem", narrative.training_opportunities);
  section(lines, "Boas práticas observadas", narrative.good_practices);
  lines.push("");
  lines.push("_A IA auxilia a supervisão; não substitui a verificação humana. Nenhuma sanção é emitida automaticamente (POP 6)._");
  return lines.join("\n");
}

function renderItems(items: ChecklistItem[]): string[] {
  return items.map((i) => `- [${i.status}] ${i.label} — ${i.reason}${i.sourceMessageIds.length ? ` (msgs: ${i.sourceMessageIds.join(", ")})` : ""}`);
}

function section(lines: string[], title: string, items: string[]): void {
  if (!items.length) return;
  lines.push("");
  lines.push(`## ${title}`);
  for (const i of items) lines.push(`- ${i}`);
}
