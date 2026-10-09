/**
 * Pipeline de ingestão: uma mensagem do WhatsApp entra, o estado da rota sai atualizado.
 *
 *   mensagem → idempotência → rota do motorista → (texto: parser → IA se ambíguo)
 *            → (foto: armazenar → IA → regras de pesagem) → (localização: conferência opcional)
 *            → recomputar estado → alertas à supervisão → (Fase B) sugestão do instrutor
 *
 * Fase A (padrão): nada é enviado ao grupo do motorista. Alertas vão para a supervisão via n8n.
 */

import { createHash } from "node:crypto";
import { parseMessage } from "../domain/event-parser.js";
import { computeRouteStatus, type RouteStatus } from "../domain/route-state.js";
import type { AssessmentResult, EvidenceFields, EvidenceKind, InboundMessage } from "../domain/types.js";
import { assessWeighing } from "../domain/weighing.js";
import type { Driver, NewAlert, Repository, Route, SystemSettings } from "../db/repository.js";
import type { ImageMediaType } from "../claude/operations.js";
import type { EvidenceAnalysis } from "../claude/schemas.js";
import type { AiPort } from "./ai-port.js";

export interface IngestDeps {
  repo: Repository;
  ai: AiPort;
  phase: "A" | "B";
  /** Busca bytes de mídia por URL (injetável; em simulação não é usado). */
  fetchMedia?: (url: string) => Promise<Uint8Array>;
  now?: () => Date;
  /** Notifica sistemas externos (n8n). Opcional; ausente = sem notificação. */
  notify?: (event: OutboundNotification) => Promise<void>;
}

export type OutboundNotification =
  | { type: "ALERT"; routeId: string; alert: NewAlert & { id: string } }
  | { type: "ROUTE_CLOSED"; routeId: string; driverId: string }
  | { type: "INSTRUCTOR_SUGGESTION"; routeId: string; groupId: string; message: string; trigger: string };

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  reason: string;
  routeId: string | null;
  messageId: string | null;
  eventType?: string | null;
  evidence?: { kind: EvidenceKind; result: AssessmentResult; reason: string } | null;
  status?: RouteStatus | null;
  alertsCreated: number;
}

const IMAGE_TYPES: ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export async function ingestMessage(deps: IngestDeps, msg: InboundMessage): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date());
  const settings = await deps.repo.getSettings();

  const driver = await deps.repo.findDriverByGroup(msg.groupId);
  if (!driver) {
    const saved = await deps.repo.saveMessage(msg, null, "NO_MATCH", "grupo não cadastrado para nenhum motorista ativo");
    return { accepted: false, duplicate: saved.duplicate, reason: "grupo não cadastrado", routeId: null, messageId: saved.id, alertsCreated: 0 };
  }

  // Classificação prévia do tipo de mensagem (texto/mídia/localização)
  const isImage = Boolean(msg.media && IMAGE_TYPES.includes(msg.media.mimeType as ImageMediaType));
  const parse = parseMessage(msg.text);

  // Rota: abre na mensagem INICIO DE ROTA; qualquer outra mensagem sem rota aberta cria rota "sem início"
  // (o motor de estado registra EVENTO_ANTES_INICIO_ROTA para a supervisão avaliar).
  let route = await deps.repo.getOpenRoute(driver.id);
  if (parse.status === "MATCHED" && parse.event!.eventType === "INICIO_ROTA") {
    if (route) {
      // Novo início com rota aberta: encerra a anterior administrativamente (fica registrado como pendente).
      await deps.repo.closeRoute(route.id, msg.receivedAt);
      route = null;
    }
    route = await deps.repo.openRoute(driver.id, parse.event!.routeDate, msg.receivedAt);
  }
  if (!route) {
    // Fotos do retorno (KM/combustível final) chegam depois de FIM DE ROTA: anexar à rota recém-encerrada
    // dentro da janela de tolerância, em vez de abrir uma rota nova.
    const lastClosed = await deps.repo.getLastClosedRoute(driver.id);
    const withinGrace =
      lastClosed?.closedAt && Date.parse(msg.receivedAt) - Date.parse(lastClosed.closedAt) <= settings.postRouteGraceMinutes * 60_000;
    route = withinGrace ? lastClosed! : await deps.repo.openRoute(driver.id, null, msg.receivedAt);
  }

  const parseStatus = msg.location ? "LOCATION" : isImage ? "MEDIA" : parse.status;
  const saved = await deps.repo.saveMessage(msg, route.id, parseStatus, parse.reason);
  if (saved.duplicate) {
    return { accepted: true, duplicate: true, reason: "mensagem já processada", routeId: route.id, messageId: saved.id, alertsCreated: 0 };
  }

  const alerts: NewAlert[] = [];
  let eventType: string | null = null;
  let evidenceOut: IngestResult["evidence"] = null;

  // ---------- Texto padrão ----------
  if (parse.status === "MATCHED") {
    const ev = parse.event!;
    await deps.repo.saveEvent({ routeId: route.id, sourceMessageId: saved.id, eventType: ev.eventType, clientCode: ev.clientCode, occurredAt: msg.receivedAt, origin: "PARSER", needsReview: false });
    eventType = ev.eventType;
    if (ev.eventType === "PROBLEMA_ENTREGA") {
      alerts.push({ routeId: route.id, kind: "PROBLEMA_RELATADO", severity: "URGENTE", title: `Problema na entrega — cliente ${ev.clientCode}`, details: { text: msg.text }, sourceMessageId: saved.id });
    }
    if (ev.eventType === "CLIENTE_SEM_BALANCA") {
      alerts.push({ routeId: route.id, kind: "CLIENTE_SEM_BALANCA", severity: "ATENCAO", title: `Cliente sem balança — ${ev.clientCode} (incluir na auditoria volante)`, details: { text: msg.text }, sourceMessageId: saved.id });
    }
  } else if ((parse.status === "AMBIGUOUS" || parse.status === "NO_MATCH") && msg.text && !isImage && !msg.location) {
    eventType = await handleFreeText(deps, settings, route, saved.id, msg, parse.status, alerts);
  }

  // ---------- Localização nativa ----------
  if (msg.location) {
    const status = await currentStatus(deps.repo, route, settings, now());
    const clientCode = status.currentClientCode;
    const client = clientCode ? await deps.repo.findClient(clientCode) : null;
    let result: AssessmentResult = "CONFORME";
    let reason = "localização atual nativa recebida";
    if (msg.location.isLive === false) {
      result = "ILEGIVEL_NAO_VERIFICAVEL";
      reason = "localização enviada como lugar/pin, não como localização atual";
    } else if (client?.latitude != null && client.longitude != null && client.arrivalRadiusMeters != null) {
      const d = haversineMeters(msg.location.latitude, msg.location.longitude, client.latitude, client.longitude);
      if (d > client.arrivalRadiusMeters) {
        result = "DIVERGENTE";
        reason = `localização a ${Math.round(d)} m do endereço de referência do cliente ${clientCode} (raio ${client.arrivalRadiusMeters} m)`;
      } else reason = `localização a ${Math.round(d)} m do endereço de referência do cliente ${clientCode}`;
    } else if (clientCode) {
      reason = "localização recebida; conferência de endereço não realizada (sem referência confiável cadastrada)";
    }
    await deps.repo.saveEvidence({
      routeId: route.id, sourceMessageId: saved.id, kind: "LOCALIZACAO_WHATSAPP", result, receivedAt: msg.receivedAt, capturedAt: null, clientCode: null,
      storagePath: null, sha256: null, fields: null, analysis: msg.location, reason, needsReview: false, servedByModel: null,
    });
    evidenceOut = { kind: "LOCALIZACAO_WHATSAPP", result, reason };
    if (result === "DIVERGENTE") {
      alerts.push({ routeId: route.id, kind: "SEQUENCIA_IRREGULAR", severity: "ATENCAO", title: "Localização de chegada divergente da referência", details: { reason }, sourceMessageId: saved.id });
    }
  }

  // ---------- Fotografia ----------
  if (isImage && msg.media) {
    evidenceOut = await handlePhoto(deps, settings, driver, route, saved.id, msg, now(), alerts);
  }

  // ---------- Recomputar estado, encerrar rota, alertas de sequência ----------
  const previous = await deps.repo.getLatestRouteStatus(route.id);
  const status = await currentStatus(deps.repo, route, settings, now());
  await deps.repo.saveRouteStatusSnapshot(route.id, status);

  const knownIssues = new Set((previous?.sequenceIssues ?? []).map((s) => `${s.code}|${s.description}`));
  for (const issue of status.sequenceIssues) {
    if (!knownIssues.has(`${issue.code}|${issue.description}`)) {
      alerts.push({ routeId: route.id, kind: "SEQUENCIA_IRREGULAR", severity: "ATENCAO", title: issue.description, details: { code: issue.code }, sourceMessageId: issue.sourceMessageId });
    }
  }

  if (eventType === "FIM_ROTA") {
    await deps.repo.closeRoute(route.id, msg.receivedAt);
    await deps.notify?.({ type: "ROUTE_CLOSED", routeId: route.id, driverId: driver.id });
  }

  for (const alert of alerts) {
    const stored = await deps.repo.saveAlert(alert);
    await deps.notify?.({ type: "ALERT", routeId: route.id, alert: stored });
  }

  // ---------- Fase B: sugestão do instrutor (gerada, nunca enviada diretamente daqui) ----------
  if (deps.phase === "B" && eventType !== "FIM_ROTA") {
    await maybeInstruct(deps, settings, driver, route, status, msg, evidenceOut, now());
  }

  return { accepted: true, duplicate: false, reason: parse.reason, routeId: route.id, messageId: saved.id, eventType, evidence: evidenceOut, status, alertsCreated: alerts.length };
}

async function currentStatus(repo: Repository, route: Route, settings: SystemSettings, now: Date): Promise<RouteStatus> {
  const [events, evidences] = await Promise.all([repo.listEvents(route.id), repo.listEvidences(route.id)]);
  return computeRouteStatus(events, evidences, { pendingToNonConformAfterRouteEndMinutes: settings.pendingToNonConformAfterRouteEndMinutes, now, routeDate: route.routeDate });
}

async function handleFreeText(
  deps: IngestDeps,
  settings: SystemSettings,
  route: Route,
  messageId: string,
  msg: InboundMessage,
  parseStatus: "AMBIGUOUS" | "NO_MATCH",
  alerts: NewAlert[],
): Promise<string | null> {
  const status = await currentStatus(deps.repo, route, settings, new Date());
  let classification;
  try {
    classification = await deps.ai.classifyMessage(msg.text!, { routeStageDescription: describeStage(status), currentClientCode: status.currentClientCode });
  } catch (err) {
    await deps.repo.saveReviewItem({ routeId: route.id, sourceMessageId: messageId, kind: "MENSAGEM_AMBIGUA", payload: { text: msg.text, parseStatus, error: String(err) } });
    return null;
  }
  const c = classification.data;

  if (c.is_problem_report) {
    alerts.push({ routeId: route.id, kind: "PROBLEMA_RELATADO", severity: "ATENCAO", title: "Possível problema relatado em texto livre", details: { text: msg.text, reason: c.reason }, sourceMessageId: messageId });
  }
  if (c.is_question_to_supervision) {
    // Fase A: a IA não responde ao motorista; a dúvida é encaminhada à supervisão.
    alerts.push({ routeId: route.id, kind: "DUVIDA_MOTORISTA", severity: "INFO", title: "Dúvida do motorista aguardando resposta da supervisão", details: { text: msg.text }, sourceMessageId: messageId });
  }

  const requiresCode = c.event_type && !["INICIO_ROTA", "FIM_ROTA", "DESCARGA_INICIADA", "PESAGEM"].includes(c.event_type);
  const confident = c.confidence >= settings.minClassificationConfidence;
  if (c.event_type && confident && (!requiresCode || c.client_code)) {
    await deps.repo.saveEvent({ routeId: route.id, sourceMessageId: messageId, eventType: c.event_type, clientCode: c.client_code, occurredAt: msg.receivedAt, origin: "IA_CLASSIFICACAO", needsReview: true });
    await deps.repo.saveReviewItem({ routeId: route.id, sourceMessageId: messageId, kind: "EVENTO_CLASSIFICADO_POR_IA", payload: { text: msg.text, classification: c, servedBy: classification.servedBy } });
    return c.event_type;
  }

  if (parseStatus === "AMBIGUOUS" || c.event_type) {
    await deps.repo.saveReviewItem({ routeId: route.id, sourceMessageId: messageId, kind: "MENSAGEM_AMBIGUA", payload: { text: msg.text, parseStatus, classification: c } });
    alerts.push({ routeId: route.id, kind: "MENSAGEM_AMBIGUA", severity: "INFO", title: "Mensagem ambígua aguardando revisão humana", details: { text: msg.text, reason: c.reason }, sourceMessageId: messageId });
  }
  return null;
}

async function handlePhoto(
  deps: IngestDeps,
  settings: SystemSettings,
  driver: Driver,
  route: Route,
  messageId: string,
  msg: InboundMessage,
  now: Date,
  alerts: NewAlert[],
): Promise<IngestResult["evidence"]> {
  const media = msg.media!;
  let bytes: Uint8Array;
  if (media.base64) bytes = Buffer.from(media.base64, "base64");
  else if (media.url && deps.fetchMedia) bytes = await deps.fetchMedia(media.url);
  else throw new Error("mídia sem conteúdo acessível (base64 ou url + fetchMedia)");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storagePath = await deps.repo.storeMedia(`${driver.id}/${route.id}/${messageId}.${extensionFor(media.mimeType)}`, bytes, media.mimeType);

  const reuse = await deps.repo.findEvidenceBySha256(driver.id, sha256);
  const status = await currentStatus(deps.repo, route, settings, now);
  const scopeAfterEnd = status.stage === "ENCERRADA";

  let analysis: EvidenceAnalysis;
  let servedBy: string | null = null;
  try {
    const r = await deps.ai.analyzePhoto(
      { base64: Buffer.from(bytes).toString("base64"), mediaType: media.mimeType as ImageMediaType },
      { routeStageDescription: describeStage(status), caption: msg.text ?? null, expectedKinds: status.nextExpectedStep.missingItems.map((i) => i.label) },
    );
    analysis = r.data;
    servedBy = r.servedBy;
  } catch (err) {
    const reason = `análise automática indisponível: ${err instanceof Error ? err.message : String(err)}`;
    await deps.repo.saveEvidence({
      routeId: route.id, sourceMessageId: messageId, kind: "OUTRA", result: "PENDENTE", receivedAt: msg.receivedAt, capturedAt: media.capturedAt ?? null, clientCode: null,
      storagePath, sha256, fields: null, analysis: null, reason, needsReview: true, servedByModel: null,
    });
    await deps.repo.saveReviewItem({ routeId: route.id, sourceMessageId: messageId, kind: "EVIDENCIA_BAIXA_CONFIANCA", payload: { reason } });
    return { kind: "OUTRA", result: "PENDENTE", reason };
  }

  // Inicial/final decidido pelo contexto da rota, não pela IA
  let kind: EvidenceKind = analysis.kind;
  if (kind === "FOTO_KM_INICIAL" && scopeAfterEnd) kind = "FOTO_KM_FINAL";
  if (kind === "FOTO_COMBUSTIVEL_INICIAL" && scopeAfterEnd) kind = "FOTO_COMBUSTIVEL_FINAL";
  if (kind === "FOTO_KM_FINAL" && !scopeAfterEnd) kind = "FOTO_KM_INICIAL";
  if (kind === "FOTO_COMBUSTIVEL_FINAL" && !scopeAfterEnd) kind = "FOTO_COMBUSTIVEL_INICIAL";

  const fields: EvidenceFields = {
    plate: analysis.fields.plate, odometerKm: analysis.fields.odometer_km, fuelLevel: analysis.fields.fuel_level, invoiceNumber: analysis.fields.invoice_number,
    clientCode: analysis.fields.client_code, labelKg: analysis.fields.label_kg, scaleKg: analysis.fields.scale_kg, bothInSameFrame: analysis.fields.both_in_same_frame,
    boxesCount: analysis.fields.boxes_count, signedOrStamped: analysis.fields.signed_or_stamped, gpsDestination: analysis.fields.gps_destination,
  };

  let result: AssessmentResult;
  let reason: string;
  if (kind === "FOTO_PESAGEM") {
    const w = assessWeighing({ labelKg: fields.labelKg, scaleKg: fields.scaleKg, bothInSameFrame: fields.bothInSameFrame, toleranceKg: settings.weighingToleranceKg });
    result = w.result;
    reason = w.reason;
    if (w.result === "DIVERGENTE") {
      alerts.push({
        routeId: route.id, kind: "DIVERGENCIA_PESO", severity: "URGENTE",
        title: `Divergência de peso${status.currentClientCode ? ` — cliente ${status.currentClientCode}` : ""}: etiqueta ${w.labelKg} kg × balança ${w.scaleKg} kg`,
        details: { labelKg: w.labelKg, scaleKg: w.scaleKg, differenceKg: w.differenceKg }, sourceMessageId: messageId,
      });
    }
  } else if (kind === "OUTRA") {
    result = "ILEGIVEL_NAO_VERIFICAVEL";
    reason = `imagem não corresponde a evidência do POP: ${analysis.summary}`;
  } else if (kind === "FOTO_NOTA_ASSINADA" && fields.signedOrStamped === false) {
    result = "ILEGIVEL_NAO_VERIFICAVEL";
    reason = "nota sem assinatura/carimbo visível";
  } else if (analysis.legibility === "LEGIVEL") {
    result = "CONFORME";
    reason = analysis.summary;
  } else {
    result = "ILEGIVEL_NAO_VERIFICAVEL";
    reason = `${analysis.legibility === "PARCIAL" ? "leitura parcial" : "ilegível"}: ${analysis.issues.join("; ") || analysis.summary}`;
  }

  const needsReview = analysis.confidence < settings.minEvidenceConfidence || analysis.possible_reuse_indicators.length > 0 || reuse !== null;

  await deps.repo.saveEvidence({
    routeId: route.id, sourceMessageId: messageId, kind, result, receivedAt: msg.receivedAt, capturedAt: media.capturedAt ?? null, clientCode: null,
    storagePath, sha256, fields, analysis, reason, needsReview, servedByModel: servedBy,
  });

  if (result === "ILEGIVEL_NAO_VERIFICAVEL" && kind !== "OUTRA") {
    alerts.push({ routeId: route.id, kind: "EVIDENCIA_ILEGIVEL", severity: "INFO", title: `Evidência não verificável (${kind}) — solicitar correção`, details: { reason }, sourceMessageId: messageId });
  }
  if (reuse) {
    alerts.push({ routeId: route.id, kind: "SUSPEITA_REUSO_IMAGEM", severity: "ATENCAO", title: "Imagem idêntica a outra já recebida — para averiguação humana", details: { previous: reuse }, sourceMessageId: messageId });
  } else if (analysis.possible_reuse_indicators.length > 0) {
    alerts.push({ routeId: route.id, kind: "SUSPEITA_REUSO_IMAGEM", severity: "INFO", title: "Indícios de imagem reaproveitada — para averiguação humana", details: { indicators: analysis.possible_reuse_indicators }, sourceMessageId: messageId });
  }
  if (needsReview && analysis.confidence < settings.minEvidenceConfidence) {
    await deps.repo.saveReviewItem({ routeId: route.id, sourceMessageId: messageId, kind: "EVIDENCIA_BAIXA_CONFIANCA", payload: { confidence: analysis.confidence, kind, result } });
  }

  return { kind, result, reason };
}

async function maybeInstruct(
  deps: IngestDeps,
  settings: SystemSettings,
  driver: Driver,
  route: Route,
  status: RouteStatus,
  msg: InboundMessage,
  evidence: IngestResult["evidence"],
  now: Date,
): Promise<void> {
  const trigger: Parameters<AiPort["instructor"]>[0]["trigger"] =
    evidence?.result === "DIVERGENTE" && evidence.kind === "FOTO_PESAGEM" ? "DIVERGENCIA_PESO"
    : evidence?.result === "ILEGIVEL_NAO_VERIFICAVEL" ? "EVIDENCIA_ILEGIVEL"
    : status.stops.some((s) => s.semBalanca && s.clientCode === status.currentClientCode) ? "SEM_BALANCA"
    : "ETAPA_CONCLUIDA";

  const recent = await deps.repo.recentInstructorItemKeys(route.id, settings.instructorRepeatWindowMinutes, now);
  const keys = status.nextExpectedStep.missingItems.map((i) => i.key);
  if (trigger === "ETAPA_CONCLUIDA" && keys.length > 0 && keys.every((k) => recent.includes(k))) return; // anti-repetição

  const suggestion = await deps.ai.instructor({
    driverFirstName: driver.firstName,
    routeStatus: { stage: status.stage, currentClientCode: status.currentClientCode, sequenceIssues: status.sequenceIssues },
    nextStep: status.nextExpectedStep,
    recentlySentItemKeys: recent,
    goodPracticeNotes: evidence?.result === "CONFORME" ? [`${evidence.kind} recebida legível`] : [],
    trigger,
  });
  if (!suggestion.data.should_send) return;

  await deps.repo.saveInstructorLog({ routeId: route.id, trigger, itemKeys: keys, message: suggestion.data.message, sent: false, createdAt: now.toISOString() });
  await deps.notify?.({ type: "INSTRUCTOR_SUGGESTION", routeId: route.id, groupId: msg.groupId, message: suggestion.data.message, trigger });
}

export function describeStage(status: RouteStatus): string {
  const client = status.currentClientCode ? ` (cliente ${status.currentClientCode})` : "";
  return `${status.stage}${client}; próxima etapa esperada: ${status.nextExpectedStep.description}`;
}

function extensionFor(mime: string): string {
  return { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[mime] ?? "bin";
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
