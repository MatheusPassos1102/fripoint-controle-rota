/**
 * Tipos de domínio do Fripoint Route Intelligence.
 * Referência operacional: POP-LOG-001 v1.1 (minuta) — Anexo A e seções 3, 4 e 5.
 */

/** Eventos do Anexo A (dicionário mínimo para configuração da automação). */
export const EVENT_TYPES = [
  "INICIO_ROTA",
  "DESLOCAMENTO_PRIMEIRO_CLIENTE",
  "CHEGADA_CLIENTE",
  "DESCARGA_INICIADA",
  "PESAGEM",
  "CLIENTE_SEM_BALANCA",
  "PROBLEMA_ENTREGA",
  "DESCARGA_FINALIZADA",
  "DESLOCAMENTO_CLIENTE",
  "FIM_ROTA",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Resultados de classificação de evidência (POP 5.2). */
export const ASSESSMENT_RESULTS = [
  "CONFORME",
  "PENDENTE",
  "ILEGIVEL_NAO_VERIFICAVEL",
  "DIVERGENTE",
  "NAO_CONFORME",
  "EXCECAO_SEM_BALANCA",
] as const;
export type AssessmentResult = (typeof ASSESSMENT_RESULTS)[number];

/** Tipos de evidência esperados ao longo da rota (POP seção 3 e quadro 4). */
export const EVIDENCE_KINDS = [
  "FOTO_PLACA",
  "FOTO_KM_INICIAL",
  "FOTO_COMBUSTIVEL_INICIAL",
  "FOTO_NOTA_FISCAL",
  "PRINT_GPS",
  "LOCALIZACAO_WHATSAPP",
  "FOTO_PESAGEM",
  "FOTO_CAIXAS_CONTAVEIS",
  "FOTO_NOTA_ASSINADA",
  "FOTO_BAU",
  "FOTO_KM_FINAL",
  "FOTO_COMBUSTIVEL_FINAL",
  "OUTRA",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Mensagem canônica recebida do canal (WhatsApp) já normalizada pelo n8n. */
export interface InboundMessage {
  /** Identificador único da mensagem no provedor (idempotência). */
  providerMessageId: string;
  /** Identificador do grupo "Gestão de Rota — Nome do Motorista". */
  groupId: string;
  /** Identificador do remetente no provedor (telefone/JID). */
  senderId: string;
  /** Carimbo de tempo informado pelo provedor (ISO 8601) — data do recebimento. */
  receivedAt: string;
  /** Texto da mensagem ou legenda da mídia. */
  text?: string | null;
  /** Mídia anexada, se houver. */
  media?: {
    mimeType: string;
    /** URL temporária ou caminho já armazenado; o serviço decide como obter os bytes. */
    url?: string;
    /** Bytes em base64 quando o provedor já entrega inline. */
    base64?: string;
    /** Data de captura (EXIF) quando o provedor a preserva. */
    capturedAt?: string | null;
  } | null;
  /** Localização nativa do WhatsApp ("Enviar localização atual"). */
  location?: {
    latitude: number;
    longitude: number;
    /** true quando o provedor marca como localização ao vivo/atual; false para localização de lugar/pin. */
    isLive?: boolean;
  } | null;
}

/** Resultado do parser determinístico de mensagens (Anexo A). */
export interface ParsedEvent {
  eventType: EventType;
  clientCode: string | null;
  /** Data da rota declarada (DD/MM/AAAA → YYYY-MM-DD) quando o evento a carrega. */
  routeDate: string | null;
  /** Texto normalizado usado na decisão (para trilha de auditoria). */
  normalizedText: string;
}

export interface ParseOutcome {
  status: "MATCHED" | "AMBIGUOUS" | "NO_MATCH";
  event: ParsedEvent | null;
  /** Explicação curta para trilha de auditoria. */
  reason: string;
  normalizedText: string;
}

/** Evento já persistido, usado pelo motor de estado da rota. */
export interface RouteEvent {
  id: string;
  eventType: EventType;
  clientCode: string | null;
  occurredAt: string;
  /** Mensagem de origem (referência obrigatória: "o sistema guarda a referência da mensagem/foto"). */
  sourceMessageId: string;
}

/** Evidência classificada (foto/localização) vinculada à rota. */
export interface RouteEvidence {
  id: string;
  kind: EvidenceKind;
  result: AssessmentResult;
  sourceMessageId: string;
  receivedAt: string;
  /** Cliente ao qual a evidência foi vinculada pelo contexto (null = não vinculada com segurança). */
  clientCode: string | null;
  /** Campos extraídos pela IA quando legíveis. */
  fields?: EvidenceFields;
}

export interface EvidenceFields {
  plate?: string | null;
  odometerKm?: number | null;
  fuelLevel?: string | null;
  invoiceNumber?: string | null;
  clientCode?: string | null;
  labelKg?: number | null;
  scaleKg?: number | null;
  bothInSameFrame?: boolean | null;
  boxesCount?: number | null;
  signedOrStamped?: boolean | null;
  gpsDestination?: string | null;
}
