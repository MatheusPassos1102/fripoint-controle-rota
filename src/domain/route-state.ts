/**
 * Motor de estado da rota — implementa em software o "Quadro rápido de conferência" (POP seção 4)
 * e a regra de ouro (seção 1): a entrega só é documentalmente conforme quando TODAS as evidências
 * aplicáveis foram recebidas, legíveis e vinculadas ao cliente certo, na sequência prevista.
 *
 * Princípios:
 *  - Registro faltante permanece PENDENTE; vira NÃO CONFORME apenas após marco definido pela gestão
 *    (settings.pendingToNonConformAfterRouteEndMinutes). Sem parâmetro, permanece PENDENTE.
 *  - Nenhuma evidência é vinculada a um cliente por "palpite": a vinculação segue o contexto
 *    cronológico dos eventos padrão (último DESLOCAMENTO/CHEGADA antes da evidência).
 *  - Nada aqui chama IA. A IA só classifica evidências individuais; a conclusão sobre a rota é determinística.
 */

import type { AssessmentResult, EventType, EvidenceKind, RouteEvent, RouteEvidence } from "./types.js";

export type RouteStage = "NAO_INICIADA" | "EM_DESLOCAMENTO" | "NO_CLIENTE" | "EM_DESCARGA" | "ENCERRADA";

export type ScopeKey = "SAIDA" | "RETORNO" | `CLIENTE:${string}`;

export interface ChecklistItem {
  scope: ScopeKey;
  /** Identificador estável do item (usado em relatórios e no instrutor). */
  key: string;
  label: string;
  status: AssessmentResult;
  reason: string;
  /** Mensagens que fundamentam a conclusão (referência obrigatória, POP 5.2). */
  sourceMessageIds: string[];
}

export interface StopSummary {
  clientCode: string;
  order: number;
  deslocamentoAt: string | null;
  chegadaAt: string | null;
  descargaIniciadaAt: string | null;
  descargaFinalizadaAt: string | null;
  semBalanca: boolean;
  problemaRegistrado: boolean;
  weighings: { total: number; conformes: number; divergentes: number; naoVerificaveis: number };
  items: ChecklistItem[];
}

export interface SequenceIssue {
  code:
    | "CHEGADA_SEM_DESLOCAMENTO"
    | "DESCARGA_SEM_CHEGADA"
    | "FINALIZACAO_SEM_DESCARGA"
    | "CODIGO_DIVERGENTE_DO_CONTEXTO"
    | "EVENTO_APOS_FIM_ROTA"
    | "EVENTO_ANTES_INICIO_ROTA"
    | "DIVERGENCIA_SEM_PROBLEMA_REGISTRADO";
  description: string;
  sourceMessageId: string | null;
}

export interface RouteStatus {
  stage: RouteStage;
  routeDate: string | null;
  currentClientCode: string | null;
  departure: ChecklistItem[];
  stops: StopSummary[];
  returnItems: ChecklistItem[];
  sequenceIssues: SequenceIssue[];
  /** Próxima etapa esperada (alimenta a Fase B — instrutor). */
  nextExpectedStep: NextStep;
  /** Resumo em contagem para alertas e relatório. */
  counts: Record<AssessmentResult, number>;
}

export interface NextStep {
  eventType: EventType | null;
  description: string;
  missingItems: ChecklistItem[];
}

export interface RouteSettings {
  /** Minutos após FIM_ROTA para converter PENDENTE em NÃO CONFORME. null = nunca automaticamente. */
  pendingToNonConformAfterRouteEndMinutes?: number | null;
  /** Instante de referência para avaliar marcos (default: agora). */
  now?: Date;
  /** Data da rota (YYYY-MM-DD) declarada no INICIO DE ROTA, vinda do registro persistido. */
  routeDate?: string | null;
}

const DEPARTURE_ITEMS: Array<{ key: string; label: string; kind: EvidenceKind }> = [
  { key: "saida.placa", label: "Foto legível da placa", kind: "FOTO_PLACA" },
  { key: "saida.km_inicial", label: "Foto do painel com KM inicial", kind: "FOTO_KM_INICIAL" },
  { key: "saida.combustivel_inicial", label: "Foto do nível de combustível", kind: "FOTO_COMBUSTIVEL_INICIAL" },
];

const RETURN_ITEMS: Array<{ key: string; label: string; kind: EvidenceKind }> = [
  { key: "retorno.km_final", label: "Foto do KM final", kind: "FOTO_KM_FINAL" },
  { key: "retorno.combustivel_final", label: "Foto do nível de combustível final", kind: "FOTO_COMBUSTIVEL_FINAL" },
];

export function computeRouteStatus(
  eventsInput: RouteEvent[],
  evidencesInput: RouteEvidence[],
  settings: RouteSettings = {},
): RouteStatus {
  const events = [...eventsInput].sort(byTime((e) => e.occurredAt));
  const evidences = [...evidencesInput].sort(byTime((e) => e.receivedAt));

  const sequenceIssues: SequenceIssue[] = [];
  const stops: StopSummary[] = [];
  const stopByCode = new Map<string, StopSummary>();

  let stage: RouteStage = "NAO_INICIADA";
  const routeDate: string | null = settings.routeDate ?? null;
  let currentClientCode: string | null = null;
  let started = false;
  let finished = false;
  let fimRotaAt: string | null = null;

  const getOrCreateStop = (code: string): StopSummary => {
    let stop = stopByCode.get(code);
    if (!stop) {
      stop = {
        clientCode: code,
        order: stops.length + 1,
        deslocamentoAt: null,
        chegadaAt: null,
        descargaIniciadaAt: null,
        descargaFinalizadaAt: null,
        semBalanca: false,
        problemaRegistrado: false,
        weighings: { total: 0, conformes: 0, divergentes: 0, naoVerificaveis: 0 },
        items: [],
      };
      stops.push(stop);
      stopByCode.set(code, stop);
    }
    return stop;
  };

  for (const ev of events) {
    if (finished && ev.eventType !== "FIM_ROTA") {
      sequenceIssues.push({
        code: "EVENTO_APOS_FIM_ROTA",
        description: `${ev.eventType} recebido após FIM DE ROTA`,
        sourceMessageId: ev.sourceMessageId,
      });
    }
    if (!started && ev.eventType !== "INICIO_ROTA") {
      sequenceIssues.push({
        code: "EVENTO_ANTES_INICIO_ROTA",
        description: `${ev.eventType} recebido antes de INICIO DE ROTA`,
        sourceMessageId: ev.sourceMessageId,
      });
    }

    switch (ev.eventType) {
      case "INICIO_ROTA": {
        started = true;
        stage = "EM_DESLOCAMENTO";
        break;
      }
      case "DESLOCAMENTO_PRIMEIRO_CLIENTE":
      case "DESLOCAMENTO_CLIENTE": {
        if (ev.clientCode) {
          const stop = getOrCreateStop(ev.clientCode);
          stop.deslocamentoAt ??= ev.occurredAt;
          currentClientCode = ev.clientCode;
        }
        stage = "EM_DESLOCAMENTO";
        break;
      }
      case "CHEGADA_CLIENTE": {
        if (ev.clientCode) {
          const existing = stopByCode.get(ev.clientCode);
          if (!existing || !existing.deslocamentoAt) {
            sequenceIssues.push({
              code: "CHEGADA_SEM_DESLOCAMENTO",
              description: `CHEGADA no cliente ${ev.clientCode} sem DESLOCAMENTO prévio`,
              sourceMessageId: ev.sourceMessageId,
            });
          }
          if (currentClientCode && currentClientCode !== ev.clientCode) {
            sequenceIssues.push({
              code: "CODIGO_DIVERGENTE_DO_CONTEXTO",
              description: `CHEGADA informa ${ev.clientCode}, mas o deslocamento em curso era para ${currentClientCode}`,
              sourceMessageId: ev.sourceMessageId,
            });
          }
          const stop = getOrCreateStop(ev.clientCode);
          stop.chegadaAt ??= ev.occurredAt;
          currentClientCode = ev.clientCode;
        }
        stage = "NO_CLIENTE";
        break;
      }
      case "DESCARGA_INICIADA": {
        const stop = currentClientCode ? stopByCode.get(currentClientCode) : undefined;
        if (!stop || !stop.chegadaAt) {
          sequenceIssues.push({
            code: "DESCARGA_SEM_CHEGADA",
            description: "DESCARGA INICIADA sem CHEGADA registrada para o cliente em contexto",
            sourceMessageId: ev.sourceMessageId,
          });
        }
        if (stop) stop.descargaIniciadaAt ??= ev.occurredAt;
        stage = "EM_DESCARGA";
        break;
      }
      case "CLIENTE_SEM_BALANCA": {
        const code = ev.clientCode ?? currentClientCode;
        if (code) {
          const stop = getOrCreateStop(code);
          stop.semBalanca = true;
          if (currentClientCode && ev.clientCode && ev.clientCode !== currentClientCode) {
            sequenceIssues.push({
              code: "CODIGO_DIVERGENTE_DO_CONTEXTO",
              description: `CLIENTE SEM BALANÇA informa ${ev.clientCode}, contexto atual é ${currentClientCode}`,
              sourceMessageId: ev.sourceMessageId,
            });
          }
        }
        stage = "EM_DESCARGA";
        break;
      }
      case "PROBLEMA_ENTREGA": {
        const code = ev.clientCode ?? currentClientCode;
        if (code) getOrCreateStop(code).problemaRegistrado = true;
        break;
      }
      case "DESCARGA_FINALIZADA": {
        const code = ev.clientCode ?? currentClientCode;
        if (code) {
          const stop = getOrCreateStop(code);
          if (!stop.descargaIniciadaAt && !stop.semBalanca) {
            sequenceIssues.push({
              code: "FINALIZACAO_SEM_DESCARGA",
              description: `DESCARGA FINALIZADA no cliente ${code} sem DESCARGA INICIADA`,
              sourceMessageId: ev.sourceMessageId,
            });
          }
          if (currentClientCode && ev.clientCode && ev.clientCode !== currentClientCode) {
            sequenceIssues.push({
              code: "CODIGO_DIVERGENTE_DO_CONTEXTO",
              description: `DESCARGA FINALIZADA informa ${ev.clientCode}, contexto atual é ${currentClientCode}`,
              sourceMessageId: ev.sourceMessageId,
            });
          }
          stop.descargaFinalizadaAt ??= ev.occurredAt;
        }
        stage = "NO_CLIENTE";
        break;
      }
      case "PESAGEM": {
        // Mensagem textual opcional; as fotos é que contam (tratadas abaixo).
        break;
      }
      case "FIM_ROTA": {
        finished = true;
        fimRotaAt = ev.occurredAt;
        stage = "ENCERRADA";
        break;
      }
    }
  }

  // ---- Vinculação de evidências por contexto cronológico ----
  const scopedEvidence = new Map<ScopeKey, RouteEvidence[]>();
  for (const evd of evidences) {
    const scope = evd.clientCode ? (`CLIENTE:${evd.clientCode}` as ScopeKey) : scopeAt(evd.receivedAt, events, fimRotaAt);
    const list = scopedEvidence.get(scope) ?? [];
    list.push(evd);
    scopedEvidence.set(scope, list);
  }

  // ---- Checklist de saída ----
  const departure: ChecklistItem[] = [];
  const saidaEvidence = scopedEvidence.get("SAIDA") ?? [];
  departure.push(
    eventItem("SAIDA", "saida.inicio_rota", "Mensagem INICIO DE ROTA DIA DD/MM/AAAA", events, "INICIO_ROTA"),
  );
  for (const item of DEPARTURE_ITEMS) {
    departure.push(evidenceItem("SAIDA", item.key, item.label, saidaEvidence, item.kind));
  }
  const firstStop = stops[0];
  if (firstStop) {
    const firstScope = scopedEvidence.get(`CLIENTE:${firstStop.clientCode}`) ?? [];
    departure.push(
      evidenceItem("SAIDA", "saida.nota_primeiro_cliente", "Foto da nota fiscal do 1º cliente", firstScope, "FOTO_NOTA_FISCAL"),
    );
    departure.push(evidenceItem("SAIDA", "saida.print_gps", "Print do destino/rota no Waze/GPS", firstScope, "PRINT_GPS"));
  } else {
    departure.push(pendingItem("SAIDA", "saida.deslocamento_primeiro_cliente", "DESLOCAMENTO PRIMEIRO CLIENTE COD. XXXX"));
  }
  // ---- Checklist por cliente (Quadro 4) ----
  for (const stop of stops) {
    const scope: ScopeKey = `CLIENTE:${stop.clientCode}`;
    const evd = scopedEvidence.get(scope) ?? [];
    const items: ChecklistItem[] = [];

    // Próximo destino (não se aplica ao 1º cliente: nota e print já estão em "saída")
    if (stop.order > 1) {
      items.push(evidenceItem(scope, "destino.foto_bau", "Foto do interior do baú antes de sair", evd, "FOTO_BAU"));
      items.push(evidenceItem(scope, "destino.nota_fiscal", "Foto da nota do cliente", evd, "FOTO_NOTA_FISCAL"));
      items.push(evidenceItem(scope, "destino.print_gps", "Print da rota/endereço no Waze/GPS", evd, "PRINT_GPS"));
    }

    // Chegada
    items.push(
      stop.chegadaAt
        ? conformeItem(scope, "chegada.mensagem", "Mensagem CHEGADA NO CLIENTE COD. correto", eventIds(events, "CHEGADA_CLIENTE", stop.clientCode))
        : pendingItem(scope, "chegada.mensagem", "Mensagem CHEGADA NO CLIENTE COD. correto"),
    );
    items.push(evidenceItem(scope, "chegada.localizacao", "Localização atual nativa do WhatsApp", evd, "LOCALIZACAO_WHATSAPP"));

    // Descarga
    items.push(
      stop.descargaIniciadaAt
        ? conformeItem(scope, "descarga.inicio", "Aviso DESCARGA INICIADA", eventIds(events, "DESCARGA_INICIADA", null))
        : pendingItem(scope, "descarga.inicio", "Aviso DESCARGA INICIADA"),
    );

    const weighings = evd.filter((e) => e.kind === "FOTO_PESAGEM");
    stop.weighings = {
      total: weighings.length,
      conformes: weighings.filter((w) => w.result === "CONFORME").length,
      divergentes: weighings.filter((w) => w.result === "DIVERGENTE").length,
      naoVerificaveis: weighings.filter((w) => w.result === "ILEGIVEL_NAO_VERIFICAVEL").length,
    };

    if (stop.semBalanca) {
      const caixas = evd.filter((e) => e.kind === "FOTO_CAIXAS_CONTAVEIS");
      items.push({
        scope,
        key: "descarga.excecao_sem_balanca",
        label: "Exceção 4-B: CLIENTE SEM BALANÇA + fotos contáveis das caixas",
        status: "EXCECAO_SEM_BALANCA",
        reason:
          caixas.length > 0
            ? `${caixas.length} foto(s) contável(is) recebida(s); registro de aviso à supervisão deve ser confirmado pela gestão`
            : "exceção declarada sem fotos contáveis das caixas",
        sourceMessageIds: [...eventIds(events, "CLIENTE_SEM_BALANCA", stop.clientCode), ...caixas.map((c) => c.sourceMessageId)],
      });
    } else {
      items.push(weighingItem(scope, stop));
    }

    // Encerramento do cliente
    items.push(
      stop.descargaFinalizadaAt
        ? conformeItem(scope, "encerramento.mensagem", "Aviso DESCARGA FINALIZADA COD.", eventIds(events, "DESCARGA_FINALIZADA", stop.clientCode))
        : pendingItem(scope, "encerramento.mensagem", "Aviso DESCARGA FINALIZADA COD."),
    );
    items.push(evidenceItem(scope, "encerramento.nota_assinada", "Foto legível da nota assinada e/ou carimbada", evd, "FOTO_NOTA_ASSINADA"));

    if (stop.weighings.divergentes > 0 && !stop.problemaRegistrado) {
      sequenceIssues.push({
        code: "DIVERGENCIA_SEM_PROBLEMA_REGISTRADO",
        description: `cliente ${stop.clientCode}: ${stop.weighings.divergentes} pesagem(ns) divergente(s) sem PROBLEMA NA ENTREGA registrado`,
        sourceMessageId: null,
      });
      items.push({
        scope,
        key: "encerramento.tratamento_divergencia",
        label: "Tratamento de divergência (PROBLEMA NA ENTREGA + solução registrada)",
        status: "PENDENTE",
        reason: "há divergência de peso sem registro de problema/solução; não declarar conferência sem divergência",
        sourceMessageIds: weighings.filter((w) => w.result === "DIVERGENTE").map((w) => w.sourceMessageId),
      });
    } else if (stop.weighings.divergentes > 0) {
      items.push({
        scope,
        key: "encerramento.tratamento_divergencia",
        label: "Tratamento de divergência (PROBLEMA NA ENTREGA + solução registrada)",
        status: "DIVERGENTE",
        reason: "divergência registrada; solução orientada deve constar e ser avaliada pela supervisão",
        sourceMessageIds: eventIds(events, "PROBLEMA_ENTREGA", stop.clientCode),
      });
    }

    stop.items = items;
  }

  // ---- Retorno ao pátio ----
  const returnItems: ChecklistItem[] = [];
  const retornoEvidence = scopedEvidence.get("RETORNO") ?? [];
  returnItems.push(eventItem("RETORNO", "retorno.fim_rota", "Mensagem FIM DE ROTA DIA DD/MM/AAAA", events, "FIM_ROTA"));
  for (const item of RETURN_ITEMS) {
    returnItems.push(evidenceItem("RETORNO", item.key, item.label, retornoEvidence, item.kind));
  }

  // ---- Marco de não conformidade (parametrizado pela gestão) ----
  applyNonConformityMarker([...departure, ...stops.flatMap((s) => s.items), ...returnItems], fimRotaAt, settings);

  const allItems = [...departure, ...stops.flatMap((s) => s.items), ...returnItems];
  const counts = countResults(allItems);

  return {
    stage,
    routeDate,
    currentClientCode,
    departure,
    stops,
    returnItems,
    sequenceIssues,
    nextExpectedStep: computeNextStep(stage, started, finished, currentClientCode, stops, departure, returnItems),
    counts,
  };
}

// ---------------------------------------------------------------------------
// helpers

function byTime<T>(get: (t: T) => string) {
  return (a: T, b: T) => Date.parse(get(a)) - Date.parse(get(b));
}

/** Determina o escopo de uma evidência sem cliente explícito pelo contexto cronológico. */
function scopeAt(at: string, events: RouteEvent[], fimRotaAt: string | null): ScopeKey {
  const t = Date.parse(at);
  if (fimRotaAt && t >= Date.parse(fimRotaAt)) return "RETORNO";
  let scope: ScopeKey = "SAIDA";
  for (const ev of events) {
    if (Date.parse(ev.occurredAt) > t) break;
    if (
      (ev.eventType === "DESLOCAMENTO_PRIMEIRO_CLIENTE" ||
        ev.eventType === "DESLOCAMENTO_CLIENTE" ||
        ev.eventType === "CHEGADA_CLIENTE") &&
      ev.clientCode
    ) {
      scope = `CLIENTE:${ev.clientCode}`;
    }
  }
  return scope;
}

function eventIds(events: RouteEvent[], type: EventType, clientCode: string | null): string[] {
  return events
    .filter((e) => e.eventType === type && (clientCode === null || e.clientCode === clientCode))
    .map((e) => e.sourceMessageId);
}

function eventItem(scope: ScopeKey, key: string, label: string, events: RouteEvent[], type: EventType): ChecklistItem {
  const ids = eventIds(events, type, null);
  return ids.length > 0 ? conformeItem(scope, key, label, ids) : pendingItem(scope, key, label);
}

function conformeItem(scope: ScopeKey, key: string, label: string, ids: string[]): ChecklistItem {
  return { scope, key, label, status: "CONFORME", reason: "registro recebido", sourceMessageIds: ids };
}

function pendingItem(scope: ScopeKey, key: string, label: string): ChecklistItem {
  return { scope, key, label, status: "PENDENTE", reason: "evidência ainda não recebida", sourceMessageIds: [] };
}

/**
 * Item baseado em evidência classificada pela IA. Prioridade: CONFORME > DIVERGENTE > ILEGÍVEL > PENDENTE.
 * Uma foto ilegível NÃO comprova; se depois chegar uma legível, o item vira CONFORME.
 */
function evidenceItem(scope: ScopeKey, key: string, label: string, evidences: RouteEvidence[], kind: EvidenceKind): ChecklistItem {
  const ofKind = evidences.filter((e) => e.kind === kind);
  if (ofKind.length === 0) return pendingItem(scope, key, label);
  const conforme = ofKind.filter((e) => e.result === "CONFORME");
  if (conforme.length > 0) {
    return { scope, key, label, status: "CONFORME", reason: "evidência legível recebida", sourceMessageIds: conforme.map((e) => e.sourceMessageId) };
  }
  const divergente = ofKind.filter((e) => e.result === "DIVERGENTE");
  if (divergente.length > 0) {
    return { scope, key, label, status: "DIVERGENTE", reason: "evidência recebida com informação divergente", sourceMessageIds: divergente.map((e) => e.sourceMessageId) };
  }
  return {
    scope,
    key,
    label,
    status: "ILEGIVEL_NAO_VERIFICAVEL",
    reason: "evidência recebida, mas sem leitura ou associação segura; solicitar correção",
    sourceMessageIds: ofKind.map((e) => e.sourceMessageId),
  };
}

function weighingItem(scope: ScopeKey, stop: StopSummary): ChecklistItem {
  const w = stop.weighings;
  const key = "descarga.pesagens";
  const label = "Fotos de TODAS as pesagens (etiqueta + visor no mesmo quadro)";
  if (w.total === 0) return pendingItem(scope, key, label);
  if (w.divergentes > 0) {
    return { scope, key, label, status: "DIVERGENTE", reason: `${w.divergentes} de ${w.total} pesagem(ns) com diferença entre etiqueta e balança`, sourceMessageIds: [] };
  }
  if (w.naoVerificaveis > 0 && w.conformes === 0) {
    return { scope, key, label, status: "ILEGIVEL_NAO_VERIFICAVEL", reason: `${w.naoVerificaveis} foto(s) de pesagem não verificável(is)`, sourceMessageIds: [] };
  }
  return {
    scope,
    key,
    label,
    status: "CONFORME",
    reason:
      w.naoVerificaveis > 0
        ? `${w.conformes} pesagem(ns) conforme(s); ${w.naoVerificaveis} não verificável(is) — cobertura deve ser confirmada contra a nota`
        : `${w.conformes} pesagem(ns) conforme(s) — cobertura deve ser confirmada contra a nota`,
    sourceMessageIds: [],
  };
}

function applyNonConformityMarker(items: ChecklistItem[], fimRotaAt: string | null, settings: RouteSettings): void {
  const minutes = settings.pendingToNonConformAfterRouteEndMinutes;
  if (minutes === null || minutes === undefined || !fimRotaAt) return;
  const now = settings.now ?? new Date();
  const deadline = Date.parse(fimRotaAt) + minutes * 60_000;
  if (now.getTime() < deadline) return;
  for (const item of items) {
    if (item.status === "PENDENTE") {
      item.status = "NAO_CONFORME";
      item.reason = `pendência não regularizada após marco definido (${minutes} min após FIM DE ROTA)`;
    }
  }
}

function countResults(items: ChecklistItem[]): Record<AssessmentResult, number> {
  const counts: Record<AssessmentResult, number> = {
    CONFORME: 0,
    PENDENTE: 0,
    ILEGIVEL_NAO_VERIFICAVEL: 0,
    DIVERGENTE: 0,
    NAO_CONFORME: 0,
    EXCECAO_SEM_BALANCA: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

function computeNextStep(
  stage: RouteStage,
  started: boolean,
  finished: boolean,
  currentClientCode: string | null,
  stops: StopSummary[],
  departure: ChecklistItem[],
  returnItems: ChecklistItem[],
): NextStep {
  const missing = (items: ChecklistItem[]) => items.filter((i) => i.status === "PENDENTE" || i.status === "ILEGIVEL_NAO_VERIFICAVEL");

  if (!started) {
    return { eventType: "INICIO_ROTA", description: "Enviar INICIO DE ROTA DIA DD/MM/AAAA com fotos da placa, KM e combustível", missingItems: missing(departure) };
  }
  if (finished) {
    const m = missing(returnItems);
    return { eventType: null, description: m.length ? "Regularizar pendências do retorno ao pátio" : "Rota encerrada", missingItems: m };
  }
  const current = currentClientCode ? stops.find((s) => s.clientCode === currentClientCode) : undefined;
  if (!current) {
    return { eventType: "DESLOCAMENTO_PRIMEIRO_CLIENTE", description: "Enviar DESLOCAMENTO PRIMEIRO CLIENTE COD. XXXX com nota e print do GPS", missingItems: missing(departure) };
  }
  if (stage === "EM_DESLOCAMENTO") {
    return { eventType: "CHEGADA_CLIENTE", description: `Ao chegar no cliente ${current.clientCode}, enviar CHEGADA NO CLIENTE COD. ${current.clientCode} + localização atual`, missingItems: missing(current.items) };
  }
  if (stage === "NO_CLIENTE" && !current.descargaIniciadaAt && !current.semBalanca) {
    return { eventType: "DESCARGA_INICIADA", description: "Enviar DESCARGA INICIADA após autorização do cliente", missingItems: missing(current.items) };
  }
  if (stage === "EM_DESCARGA") {
    return { eventType: "DESCARGA_FINALIZADA", description: "Fotografar todas as pesagens (etiqueta + visor no mesmo quadro) e, ao terminar, enviar DESCARGA FINALIZADA COD. + nota assinada", missingItems: missing(current.items) };
  }
  // NO_CLIENTE com descarga finalizada: próximo destino ou fim de rota
  return { eventType: "DESLOCAMENTO_CLIENTE", description: "Enviar DESLOCAMENTO CLIENTE COD. XXXX (foto do baú, nota do próximo cliente, print GPS) ou FIM DE ROTA", missingItems: missing(current.items) };
}
