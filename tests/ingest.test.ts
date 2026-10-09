import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../src/db/in-memory-repository.js";
import type { InboundMessage } from "../src/domain/types.js";
import { createStubAiPort } from "../src/pipeline/ai-port.js";
import { ingestMessage, type OutboundNotification } from "../src/pipeline/ingest.js";
import { buildRouteReport } from "../src/pipeline/report.js";

function setup(phase: "A" | "B" = "A") {
  const repo = new InMemoryRepository();
  repo.drivers.push({ id: "drv-1", fullName: "Motorista Teste", firstName: "Teste", whatsappGroupId: "g1", active: true });
  repo.clients.push({ code: "1001", name: "Cliente", latitude: -23.55, longitude: -46.63, arrivalRadiusMeters: 300 });
  const notifications: OutboundNotification[] = [];
  const deps = { repo, ai: createStubAiPort(), phase, notify: async (e: OutboundNotification) => void notifications.push(e) };
  let n = 0;
  const at = (hhmm: string) => `2026-07-27T${hhmm}:00-03:00`;
  const txt = (time: string, text: string): InboundMessage => ({ providerMessageId: `m${++n}`, groupId: "g1", senderId: "s", receivedAt: at(time), text });
  const img = (time: string, caption: string): InboundMessage => ({
    providerMessageId: `m${++n}`, groupId: "g1", senderId: "s", receivedAt: at(time), text: caption,
    media: { mimeType: "image/jpeg", base64: Buffer.from(`foto-${n}`).toString("base64") },
  });
  return { repo, deps, notifications, txt, img, at };
}

describe("ingestMessage", () => {
  it("ignora grupos não cadastrados sem criar rota", async () => {
    const { deps, repo } = setup();
    const r = await ingestMessage(deps, { providerMessageId: "x", groupId: "desconhecido", senderId: "s", receivedAt: new Date().toISOString(), text: "INICIO DE ROTA DIA 27/07/2026" });
    expect(r.accepted).toBe(false);
    expect(repo.routes).toHaveLength(0);
  });

  it("é idempotente por providerMessageId", async () => {
    const { deps, txt, repo } = setup();
    const m = txt("06:00", "INICIO DE ROTA DIA 27/07/2026");
    await ingestMessage(deps, m);
    const again = await ingestMessage(deps, m);
    expect(again.duplicate).toBe(true);
    expect(repo.events).toHaveLength(1);
  });

  it("abre a rota no INICIO DE ROTA, encerra no FIM DE ROTA e notifica", async () => {
    const { deps, txt, repo, notifications } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    expect(repo.routes[0]?.status).toBe("ABERTA");
    expect(repo.routes[0]?.routeDate).toBe("2026-07-27");
    await ingestMessage(deps, txt("10:00", "FIM DE ROTA DIA 27/07/2026"));
    expect(repo.routes[0]?.status).toBe("ENCERRADA");
    expect(notifications.some((e) => e.type === "ROUTE_CLOSED")).toBe(true);
  });

  it("calcula divergência de pesagem em software e gera alerta urgente", async () => {
    const { deps, txt, img, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, txt("06:05", "DESLOCAMENTO PRIMEIRO CLIENTE COD. 1001"));
    await ingestMessage(deps, txt("07:00", "CHEGADA NO CLIENTE COD. 1001"));
    await ingestMessage(deps, txt("07:05", "DESCARGA INICIADA"));
    const r = await ingestMessage(deps, img("07:10", "pesagem 10.0/9.8"));
    expect(r.evidence?.result).toBe("DIVERGENTE");
    const alert = repo.alerts.find((a) => a.kind === "DIVERGENCIA_PESO");
    expect(alert?.severity).toBe("URGENTE");
    expect(alert?.details.differenceKg).toBe(-0.2);
  });

  it("detecta imagem idêntica já recebida e encaminha para averiguação humana (nunca declara fraude)", async () => {
    const { deps, txt, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    const same = Buffer.from("mesma-foto").toString("base64");
    await ingestMessage(deps, { providerMessageId: "a", groupId: "g1", senderId: "s", receivedAt: "2026-07-27T06:01:00-03:00", text: "placa", media: { mimeType: "image/jpeg", base64: same } });
    await ingestMessage(deps, { providerMessageId: "b", groupId: "g1", senderId: "s", receivedAt: "2026-07-27T06:02:00-03:00", text: "placa", media: { mimeType: "image/jpeg", base64: same } });
    const alert = repo.alerts.find((a) => a.kind === "SUSPEITA_REUSO_IMAGEM");
    expect(alert).toBeDefined();
    expect(alert!.title).toContain("averiguação humana");
  });

  it("confere a localização contra a referência do cliente quando ela existe", async () => {
    const { deps, txt, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, txt("06:05", "DESLOCAMENTO PRIMEIRO CLIENTE COD. 1001"));
    await ingestMessage(deps, txt("07:00", "CHEGADA NO CLIENTE COD. 1001"));
    const far = await ingestMessage(deps, { providerMessageId: "loc", groupId: "g1", senderId: "s", receivedAt: "2026-07-27T07:01:00-03:00", location: { latitude: -23.60, longitude: -46.70, isLive: true } });
    expect(far.evidence?.result).toBe("DIVERGENTE");
    expect(repo.alerts.some((a) => a.title.includes("Localização"))).toBe(true);
  });

  it("mensagem padrão sem código (ambígua) não vira evento e vai para revisão humana", async () => {
    const { deps, txt, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    const r = await ingestMessage(deps, txt("06:10", "CHEGADA NO CLIENTE"));
    expect(r.eventType).toBeNull();
    expect(repo.events).toHaveLength(1);
    expect(repo.reviewItems.some((i) => i.kind === "MENSAGEM_AMBIGUA")).toBe(true);
    expect(repo.alerts.some((a) => a.kind === "MENSAGEM_AMBIGUA")).toBe(true);
  });

  it("conversa livre sem padrão não gera evento nem revisão; dúvida vira alerta à supervisão", async () => {
    const { deps, txt, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, txt("06:10", "bom dia pessoal"));
    expect(repo.events).toHaveLength(1);
    expect(repo.reviewItems).toHaveLength(0);
    await ingestMessage(deps, txt("06:11", "posso entregar primeiro no 2002?"));
    expect(repo.alerts.some((a) => a.kind === "DUVIDA_MOTORISTA")).toBe(true);
  });

  it("fotos enviadas logo após FIM DE ROTA ficam na rota encerrada e contam como retorno", async () => {
    const { deps, txt, img, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, txt("10:00", "FIM DE ROTA DIA 27/07/2026"));
    const km = await ingestMessage(deps, img("10:01", "km"));
    expect(repo.routes).toHaveLength(1);
    expect(km.evidence?.kind).toBe("FOTO_KM_FINAL");
    expect(km.status?.returnItems.find((i) => i.key === "retorno.km_final")?.status).toBe("CONFORME");
  });

  it("mensagem muito depois do encerramento abre nova rota (fora da janela de tolerância)", async () => {
    const { deps, txt, repo } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, txt("10:00", "FIM DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, { providerMessageId: "late", groupId: "g1", senderId: "s", receivedAt: "2026-07-28T06:00:00-03:00", text: "DESCARGA INICIADA" });
    expect(repo.routes).toHaveLength(2);
  });

  it("Fase A não gera orientação ao motorista; Fase B gera sugestão sem enviar", async () => {
    const a = setup("A");
    await ingestMessage(a.deps, a.txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    expect(a.repo.instructorLogs).toHaveLength(0);
    expect(a.notifications.some((e) => e.type === "INSTRUCTOR_SUGGESTION")).toBe(false);

    const b = setup("B");
    await ingestMessage(b.deps, b.txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    expect(b.repo.instructorLogs).toHaveLength(1);
    expect(b.repo.instructorLogs[0]?.sent).toBe(false);
    expect(b.notifications.some((e) => e.type === "INSTRUCTOR_SUGGESTION")).toBe(true);
  });

  it("gera relatório de encerramento com números do software", async () => {
    const { deps, txt, img } = setup();
    await ingestMessage(deps, txt("06:00", "INICIO DE ROTA DIA 27/07/2026"));
    await ingestMessage(deps, img("06:01", "placa"));
    const closed = await ingestMessage(deps, txt("10:00", "FIM DE ROTA DIA 27/07/2026"));
    const report = await buildRouteReport(deps, closed.routeId!);
    expect(report.markdown).toContain("Relatório de encerramento de rota");
    expect(report.status.counts.CONFORME).toBeGreaterThan(0);
    expect(report.status.counts.PENDENTE).toBeGreaterThan(0);
  });
});
