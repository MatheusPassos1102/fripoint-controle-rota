import { describe, expect, it } from "vitest";
import { computeRouteStatus } from "../src/domain/route-state.js";
import type { RouteEvent, RouteEvidence } from "../src/domain/types.js";

const t = (hhmm: string) => `2026-07-27T${hhmm}:00-03:00`;

let seq = 0;
const ev = (eventType: RouteEvent["eventType"], at: string, clientCode: string | null = null): RouteEvent => ({
  id: `e${++seq}`,
  eventType,
  clientCode,
  occurredAt: at,
  sourceMessageId: `m${seq}`,
});
const photo = (kind: RouteEvidence["kind"], at: string, result: RouteEvidence["result"] = "CONFORME"): RouteEvidence => ({
  id: `v${++seq}`,
  kind,
  result,
  sourceMessageId: `m${seq}`,
  receivedAt: at,
  clientCode: null,
});

function fullCompliantRoute() {
  const events: RouteEvent[] = [
    ev("INICIO_ROTA", t("06:00")),
    ev("DESLOCAMENTO_PRIMEIRO_CLIENTE", t("06:10"), "1001"),
    ev("CHEGADA_CLIENTE", t("07:00"), "1001"),
    ev("DESCARGA_INICIADA", t("07:05")),
    ev("DESCARGA_FINALIZADA", t("07:40"), "1001"),
    ev("DESLOCAMENTO_CLIENTE", t("07:45"), "2002"),
    ev("CHEGADA_CLIENTE", t("08:30"), "2002"),
    ev("DESCARGA_INICIADA", t("08:35")),
    ev("DESCARGA_FINALIZADA", t("09:00"), "2002"),
    ev("FIM_ROTA", t("10:00")),
  ];
  const evidences: RouteEvidence[] = [
    photo("FOTO_PLACA", t("06:01")),
    photo("FOTO_KM_INICIAL", t("06:02")),
    photo("FOTO_COMBUSTIVEL_INICIAL", t("06:03")),
    photo("FOTO_NOTA_FISCAL", t("06:11")),
    photo("PRINT_GPS", t("06:12")),
    photo("LOCALIZACAO_WHATSAPP", t("07:01")),
    photo("FOTO_PESAGEM", t("07:20")),
    photo("FOTO_PESAGEM", t("07:25")),
    photo("FOTO_NOTA_ASSINADA", t("07:41")),
    photo("FOTO_BAU", t("07:46")),
    photo("FOTO_NOTA_FISCAL", t("07:47")),
    photo("PRINT_GPS", t("07:48")),
    photo("LOCALIZACAO_WHATSAPP", t("08:31")),
    photo("FOTO_PESAGEM", t("08:50")),
    photo("FOTO_NOTA_ASSINADA", t("09:01")),
    photo("FOTO_KM_FINAL", t("10:01")),
    photo("FOTO_COMBUSTIVEL_FINAL", t("10:02")),
  ];
  return { events, evidences };
}

describe("computeRouteStatus", () => {
  it("rota completa e conforme: sem pendências nem problemas de sequência", () => {
    const { events, evidences } = fullCompliantRoute();
    const status = computeRouteStatus(events, evidences);
    expect(status.stage).toBe("ENCERRADA");
    expect(status.stops.map((s) => s.clientCode)).toEqual(["1001", "2002"]);
    expect(status.sequenceIssues).toEqual([]);
    expect(status.counts.PENDENTE).toBe(0);
    expect(status.counts.ILEGIVEL_NAO_VERIFICAVEL).toBe(0);
    expect(status.stops[0]!.weighings.total).toBe(2);
    expect(status.stops[1]!.weighings.total).toBe(1);
    // itens de "próximo destino" só existem a partir do 2º cliente
    expect(status.stops[0]!.items.find((i) => i.key === "destino.foto_bau")).toBeUndefined();
    expect(status.stops[1]!.items.find((i) => i.key === "destino.foto_bau")?.status).toBe("CONFORME");
  });

  it("vincula evidências pelo contexto cronológico, nunca por palpite", () => {
    const { events, evidences } = fullCompliantRoute();
    const status = computeRouteStatus(events, evidences);
    const stop2 = status.stops[1]!;
    const assinada = stop2.items.find((i) => i.key === "encerramento.nota_assinada")!;
    expect(assinada.status).toBe("CONFORME");
    expect(assinada.sourceMessageIds).toHaveLength(1);
  });

  it("registro faltante permanece PENDENTE (não vira NÃO CONFORME sem marco da gestão)", () => {
    const { events, evidences } = fullCompliantRoute();
    const semNotaAssinada = evidences.filter((e) => !(e.kind === "FOTO_NOTA_ASSINADA" && e.receivedAt === t("09:01")));
    const status = computeRouteStatus(events, semNotaAssinada, { now: new Date("2026-07-28T10:00:00-03:00") });
    const item = status.stops[1]!.items.find((i) => i.key === "encerramento.nota_assinada")!;
    expect(item.status).toBe("PENDENTE");
    expect(status.counts.NAO_CONFORME).toBe(0);
  });

  it("converte PENDENTE em NÃO CONFORME somente após o marco parametrizado", () => {
    const { events, evidences } = fullCompliantRoute();
    const semNotaAssinada = evidences.filter((e) => !(e.kind === "FOTO_NOTA_ASSINADA" && e.receivedAt === t("09:01")));
    const before = computeRouteStatus(events, semNotaAssinada, {
      pendingToNonConformAfterRouteEndMinutes: 120,
      now: new Date("2026-07-27T11:00:00-03:00"),
    });
    expect(before.counts.NAO_CONFORME).toBe(0);
    const after = computeRouteStatus(events, semNotaAssinada, {
      pendingToNonConformAfterRouteEndMinutes: 120,
      now: new Date("2026-07-27T12:30:00-03:00"),
    });
    expect(after.counts.NAO_CONFORME).toBe(1);
  });

  it("foto ilegível não comprova; uma legível posterior regulariza", () => {
    const events = [ev("INICIO_ROTA", t("06:00"))];
    const only = computeRouteStatus(events, [photo("FOTO_PLACA", t("06:01"), "ILEGIVEL_NAO_VERIFICAVEL")]);
    expect(only.departure.find((i) => i.key === "saida.placa")?.status).toBe("ILEGIVEL_NAO_VERIFICAVEL");
    const fixed = computeRouteStatus(events, [
      photo("FOTO_PLACA", t("06:01"), "ILEGIVEL_NAO_VERIFICAVEL"),
      photo("FOTO_PLACA", t("06:05"), "CONFORME"),
    ]);
    expect(fixed.departure.find((i) => i.key === "saida.placa")?.status).toBe("CONFORME");
  });

  it("divergência de peso sem PROBLEMA NA ENTREGA gera pendência de tratamento", () => {
    const events = [
      ev("INICIO_ROTA", t("06:00")),
      ev("DESLOCAMENTO_PRIMEIRO_CLIENTE", t("06:10"), "1001"),
      ev("CHEGADA_CLIENTE", t("07:00"), "1001"),
      ev("DESCARGA_INICIADA", t("07:05")),
      ev("DESCARGA_FINALIZADA", t("07:40"), "1001"),
    ];
    const status = computeRouteStatus(events, [photo("FOTO_PESAGEM", t("07:20"), "DIVERGENTE")]);
    const stop = status.stops[0]!;
    expect(stop.items.find((i) => i.key === "descarga.pesagens")?.status).toBe("DIVERGENTE");
    expect(stop.items.find((i) => i.key === "encerramento.tratamento_divergencia")?.status).toBe("PENDENTE");
    expect(status.sequenceIssues.map((s) => s.code)).toContain("DIVERGENCIA_SEM_PROBLEMA_REGISTRADO");
  });

  it("exceção 4-B (cliente sem balança) substitui a pesagem e exige acompanhamento", () => {
    const events = [
      ev("INICIO_ROTA", t("06:00")),
      ev("DESLOCAMENTO_PRIMEIRO_CLIENTE", t("06:10"), "1001"),
      ev("CHEGADA_CLIENTE", t("07:00"), "1001"),
      ev("CLIENTE_SEM_BALANCA", t("07:05"), "1001"),
      ev("DESCARGA_FINALIZADA", t("07:40"), "1001"),
    ];
    const status = computeRouteStatus(events, [photo("FOTO_CAIXAS_CONTAVEIS", t("07:10"))]);
    const stop = status.stops[0]!;
    expect(stop.semBalanca).toBe(true);
    expect(stop.items.find((i) => i.key === "descarga.pesagens")).toBeUndefined();
    expect(stop.items.find((i) => i.key === "descarga.excecao_sem_balanca")?.status).toBe("EXCECAO_SEM_BALANCA");
    expect(status.sequenceIssues.map((s) => s.code)).not.toContain("FINALIZACAO_SEM_DESCARGA");
  });

  it("detecta problemas de sequência e código divergente do contexto", () => {
    const events = [
      ev("INICIO_ROTA", t("06:00")),
      ev("DESLOCAMENTO_PRIMEIRO_CLIENTE", t("06:10"), "1001"),
      ev("CHEGADA_CLIENTE", t("07:00"), "9999"),
      ev("DESCARGA_FINALIZADA", t("07:40"), "9999"),
    ];
    const status = computeRouteStatus(events, []);
    const codes = status.sequenceIssues.map((s) => s.code);
    expect(codes).toContain("CHEGADA_SEM_DESLOCAMENTO");
    expect(codes).toContain("CODIGO_DIVERGENTE_DO_CONTEXTO");
    expect(codes).toContain("FINALIZACAO_SEM_DESCARGA");
  });

  it("informa a próxima etapa esperada para a Fase B", () => {
    const inicio = computeRouteStatus([], []);
    expect(inicio.nextExpectedStep.eventType).toBe("INICIO_ROTA");

    const emDescarga = computeRouteStatus(
      [
        ev("INICIO_ROTA", t("06:00")),
        ev("DESLOCAMENTO_PRIMEIRO_CLIENTE", t("06:10"), "1001"),
        ev("CHEGADA_CLIENTE", t("07:00"), "1001"),
        ev("DESCARGA_INICIADA", t("07:05")),
      ],
      [],
    );
    expect(emDescarga.stage).toBe("EM_DESCARGA");
    expect(emDescarga.nextExpectedStep.eventType).toBe("DESCARGA_FINALIZADA");
    expect(emDescarga.nextExpectedStep.missingItems.map((i) => i.key)).toContain("descarga.pesagens");
  });
});
