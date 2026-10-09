/**
 * Porta de persistência. O pipeline depende apenas desta interface; há duas implementações:
 *  - InMemoryRepository (testes e simulação offline, sem integrações externas)
 *  - SupabaseRepository (produção; ver supabase/migrations)
 */

import type { ChecklistItem, RouteStatus } from "../domain/route-state.js";
import type { AssessmentResult, EventType, EvidenceFields, EvidenceKind, InboundMessage, RouteEvent, RouteEvidence } from "../domain/types.js";

export interface Driver {
  id: string;
  fullName: string;
  firstName: string;
  whatsappGroupId: string;
  active: boolean;
}

export interface ClientRecord {
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Raio (m) para conferência de localização; null = referência não confiável (não conferir). */
  arrivalRadiusMeters: number | null;
}

export interface Route {
  id: string;
  driverId: string;
  routeDate: string | null;
  status: "ABERTA" | "ENCERRADA";
  openedAt: string;
  closedAt: string | null;
}

export interface StoredMessage {
  id: string;
  routeId: string | null;
  providerMessageId: string;
  receivedAt: string;
  text: string | null;
  hasMedia: boolean;
  parseStatus: "MATCHED" | "AMBIGUOUS" | "NO_MATCH" | "MEDIA" | "LOCATION";
  parseReason: string;
}

export interface NewEvent {
  routeId: string;
  sourceMessageId: string;
  eventType: EventType;
  clientCode: string | null;
  occurredAt: string;
  origin: "PARSER" | "IA_CLASSIFICACAO";
  needsReview: boolean;
}

export interface NewEvidence {
  routeId: string;
  sourceMessageId: string;
  kind: EvidenceKind;
  result: AssessmentResult;
  receivedAt: string;
  capturedAt: string | null;
  clientCode: string | null;
  storagePath: string | null;
  sha256: string | null;
  fields: EvidenceFields | null;
  analysis: unknown;
  reason: string;
  needsReview: boolean;
  servedByModel: string | null;
}

export interface NewAlert {
  routeId: string;
  kind:
    | "DIVERGENCIA_PESO"
    | "EVIDENCIA_ILEGIVEL"
    | "MENSAGEM_AMBIGUA"
    | "PROBLEMA_RELATADO"
    | "SEQUENCIA_IRREGULAR"
    | "CLIENTE_SEM_BALANCA"
    | "SUSPEITA_REUSO_IMAGEM"
    | "DUVIDA_MOTORISTA"
    | "PENDENCIA_ATRASADA";
  severity: "INFO" | "ATENCAO" | "URGENTE";
  title: string;
  details: Record<string, unknown>;
  sourceMessageId: string | null;
}

export interface Alert extends NewAlert {
  id: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface ReviewItem {
  routeId: string;
  sourceMessageId: string;
  kind: "MENSAGEM_AMBIGUA" | "EVIDENCIA_BAIXA_CONFIANCA" | "EVENTO_CLASSIFICADO_POR_IA";
  payload: Record<string, unknown>;
}

export interface InstructorLog {
  routeId: string;
  trigger: string;
  itemKeys: string[];
  message: string;
  sent: boolean;
  createdAt: string;
}

export interface SystemSettings {
  /** Tolerância de pesagem em kg. null = não parametrizada (toda diferença sinaliza). */
  weighingToleranceKg: number | null;
  /** Minutos após FIM_ROTA para PENDENTE → NÃO CONFORME. null = nunca automaticamente. */
  pendingToNonConformAfterRouteEndMinutes: number | null;
  /** Confiança mínima da IA para aceitar classificação de mensagem sem revisão humana prévia. */
  minClassificationConfidence: number;
  /** Confiança mínima da análise de foto; abaixo disso a evidência vai para revisão. */
  minEvidenceConfidence: number;
  /** Minutos para não repetir uma orientação da Fase B sobre o mesmo item. */
  instructorRepeatWindowMinutes: number;
  /** Minutos após FIM DE ROTA em que mensagens ainda são anexadas à rota encerrada (fotos do retorno). */
  postRouteGraceMinutes: number;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  weighingToleranceKg: null,
  pendingToNonConformAfterRouteEndMinutes: null,
  minClassificationConfidence: 0.85,
  minEvidenceConfidence: 0.6,
  instructorRepeatWindowMinutes: 60,
  postRouteGraceMinutes: 240,
};

export interface RouteReportRecord {
  routeId: string;
  generatedAt: string;
  status: RouteStatus;
  narrative: unknown;
  markdown: string;
  servedByModel: string | null;
}

export interface Repository {
  getSettings(): Promise<SystemSettings>;
  findDriverByGroup(groupId: string): Promise<Driver | null>;
  getDriver(driverId: string): Promise<Driver | null>;
  findClient(code: string): Promise<ClientRecord | null>;

  getOpenRoute(driverId: string): Promise<Route | null>;
  /** Última rota encerrada do motorista (para anexar evidências do retorno enviadas após FIM DE ROTA). */
  getLastClosedRoute(driverId: string): Promise<Route | null>;
  getRoute(routeId: string): Promise<Route | null>;
  openRoute(driverId: string, routeDate: string | null, openedAt: string): Promise<Route>;
  closeRoute(routeId: string, closedAt: string): Promise<void>;
  listRoutes(filter: { status?: Route["status"]; driverId?: string }): Promise<Route[]>;

  /** Devolve { duplicate: true } quando providerMessageId já existe (idempotência). */
  saveMessage(msg: InboundMessage, routeId: string | null, parseStatus: StoredMessage["parseStatus"], parseReason: string): Promise<{ id: string; duplicate: boolean }>;

  saveEvent(ev: NewEvent): Promise<RouteEvent>;
  listEvents(routeId: string): Promise<RouteEvent[]>;

  saveEvidence(ev: NewEvidence): Promise<RouteEvidence>;
  listEvidences(routeId: string): Promise<RouteEvidence[]>;
  listEvidenceDetails(routeId: string): Promise<NewEvidence[]>;
  findEvidenceBySha256(driverId: string, sha256: string): Promise<{ routeId: string; sourceMessageId: string } | null>;

  storeMedia(path: string, bytes: Uint8Array, mimeType: string): Promise<string>;

  saveRouteStatusSnapshot(routeId: string, status: RouteStatus): Promise<void>;
  getLatestRouteStatus(routeId: string): Promise<RouteStatus | null>;

  saveAlert(alert: NewAlert): Promise<Alert>;
  listPendingAlerts(): Promise<Alert[]>;
  acknowledgeAlert(alertId: string, by: string): Promise<void>;

  saveReviewItem(item: ReviewItem): Promise<void>;

  saveInstructorLog(log: InstructorLog): Promise<void>;
  recentInstructorItemKeys(routeId: string, withinMinutes: number, now: Date): Promise<string[]>;

  saveReport(report: RouteReportRecord): Promise<void>;
  getReport(routeId: string): Promise<RouteReportRecord | null>;
}

export type { ChecklistItem };
