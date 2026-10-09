/**
 * Simulação offline de uma rota completa (sem Supabase, sem Claude API, sem WhatsApp).
 * Uso: npm run simulate
 *
 * Mostra o pipeline ponta a ponta: mensagens → eventos → evidências → estado → alertas → relatório.
 * As fotos são bytes fictícios; o stub de IA interpreta a legenda para decidir o tipo de evidência.
 */

import { InMemoryRepository } from "../src/db/in-memory-repository.js";
import type { InboundMessage } from "../src/domain/types.js";
import { createStubAiPort } from "../src/pipeline/ai-port.js";
import { ingestMessage } from "../src/pipeline/ingest.js";
import { buildRouteReport } from "../src/pipeline/report.js";

const repo = new InMemoryRepository();
repo.drivers.push({ id: "drv-1", fullName: "Motorista Exemplo", firstName: "Exemplo", whatsappGroupId: "grupo-exemplo", active: true });
repo.clients.push({ code: "1001", name: "Cliente 1001", latitude: null, longitude: null, arrivalRadiusMeters: null });

const deps = { repo, ai: createStubAiPort(), phase: "A" as const };
let n = 0;
const at = (hhmm: string) => `2026-07-27T${hhmm}:00-03:00`;
const txt = (time: string, text: string): InboundMessage => ({ providerMessageId: `msg-${++n}`, groupId: "grupo-exemplo", senderId: "5511999990000", receivedAt: at(time), text });
const img = (time: string, caption: string): InboundMessage => ({
  providerMessageId: `msg-${++n}`, groupId: "grupo-exemplo", senderId: "5511999990000", receivedAt: at(time), text: caption,
  media: { mimeType: "image/jpeg", base64: Buffer.from(`foto-${n}`).toString("base64") },
});
const loc = (time: string): InboundMessage => ({ providerMessageId: `msg-${++n}`, groupId: "grupo-exemplo", senderId: "5511999990000", receivedAt: at(time), location: { latitude: -23.55, longitude: -46.63, isLive: true } });

const script: InboundMessage[] = [
  txt("06:00", "INICIO DE ROTA DIA 27/07/2026"),
  img("06:01", "placa"),
  img("06:02", "km"),
  img("06:03", "combustivel"),
  txt("06:05", "DESLOCAMENTO PRIMEIRO CLIENTE COD. 1001"),
  img("06:06", "nota"),
  img("06:07", "gps"),
  txt("07:00", "CHEGADA NO CLIENTE COD. 1001"),
  loc("07:00"),
  txt("07:05", "DESCARGA INICIADA"),
  img("07:10", "pesagem 12.5/12.5"),
  img("07:12", "pesagem 10.0/9.8"), // divergência → alerta urgente
  img("07:14", "pesagem"), // ilegível
  txt("07:30", "DESCARGA FINALIZADA — COD. 1001"),
  img("07:31", "nota assinada"),
  txt("07:35", "bom dia, o cliente perguntou se pode pagar na próxima?"), // texto livre → revisão
  txt("08:30", "FIM DE ROTA DIA 27/07/2026"),
  img("08:31", "km"),
  img("08:32", "combustivel"),
];

let routeId: string | null = null;
for (const m of script) {
  const r = await ingestMessage(deps, m);
  routeId = r.routeId;
  const what = r.eventType ?? (r.evidence ? `${r.evidence.kind}=${r.evidence.result}` : r.reason);
  console.log(`${m.receivedAt.slice(11, 16)}  ${what}${r.alertsCreated ? `  [+${r.alertsCreated} alerta(s)]` : ""}`);
}

console.log("\n=== Alertas para a supervisão ===");
for (const a of await repo.listPendingAlerts()) console.log(`- [${a.severity}] ${a.kind}: ${a.title}`);

console.log("\n=== Itens para revisão humana ===");
for (const r of repo.reviewItems) console.log(`- ${r.kind}: ${JSON.stringify(r.payload).slice(0, 120)}`);

const report = await buildRouteReport(deps, routeId!);
console.log("\n=== Relatório de encerramento ===\n");
console.log(report.markdown);
