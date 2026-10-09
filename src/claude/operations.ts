/**
 * Operações de IA do sistema. Cada função recebe dados já preparados pelo pipeline e devolve
 * observações estruturadas. Nenhuma delas decide sanção, tolerância ou vinculação de cliente.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClient, StructuredCallResult } from "./client.js";
import { EVIDENCE_ANALYST_SYSTEM, INSTRUCTOR_SYSTEM, MESSAGE_CLASSIFIER_SYSTEM, ROUTE_REPORT_SYSTEM } from "./prompts.js";
import {
  EvidenceAnalysisSchema,
  InstructorMessageSchema,
  MessageClassificationSchema,
  RouteReportNarrativeSchema,
  type EvidenceAnalysis,
  type InstructorMessage,
  type MessageClassification,
  type RouteReportNarrative,
} from "./schemas.js";
import type { NextStep, RouteStatus } from "../domain/route-state.js";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface EvidenceContext {
  /** Etapa da rota no momento do recebimento (ex.: "EM_DESCARGA no cliente 1234"). */
  routeStageDescription: string;
  /** Legenda enviada junto com a foto, se houver. */
  caption?: string | null;
  /** Tipos de evidência esperados neste momento, para orientar (não forçar) a classificação. */
  expectedKinds: string[];
}

/** Analisa uma fotografia de evidência. */
export async function analyzeEvidencePhoto(
  client: ClaudeClient,
  image: { base64: string; mediaType: ImageMediaType },
  context: EvidenceContext,
): Promise<StructuredCallResult<EvidenceAnalysis>> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
    {
      type: "text",
      text: [
        `Contexto da rota: ${context.routeStageDescription}.`,
        `Evidências esperadas neste momento: ${context.expectedKinds.join(", ") || "não determinadas"}.`,
        context.caption ? `Legenda enviada pelo motorista: "${context.caption}".` : "Sem legenda.",
        "Analise a imagem conforme as instruções e devolva o JSON.",
      ].join("\n"),
    },
  ];
  return client.structured({ system: EVIDENCE_ANALYST_SYSTEM, content, schema: EvidenceAnalysisSchema, effort: "high" });
}

/** Classifica uma mensagem de texto que o parser determinístico não reconheceu. */
export async function classifyAmbiguousMessage(
  client: ClaudeClient,
  text: string,
  context: { routeStageDescription: string; currentClientCode: string | null },
): Promise<StructuredCallResult<MessageClassification>> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: [
        `Contexto da rota: ${context.routeStageDescription}.`,
        `Cliente em contexto (apenas informativo; NÃO use para preencher client_code): ${context.currentClientCode ?? "nenhum"}.`,
        `Mensagem recebida: """${text}"""`,
      ].join("\n"),
    },
  ];
  return client.structured({ system: MESSAGE_CLASSIFIER_SYSTEM, content, schema: MessageClassificationSchema, effort: "medium", maxTokens: 1024 });
}

export interface InstructorInput {
  driverFirstName: string;
  routeStatus: Pick<RouteStatus, "stage" | "currentClientCode" | "sequenceIssues">;
  nextStep: NextStep;
  /** Chaves de itens já orientados recentemente (anti-repetição controlada pelo software). */
  recentlySentItemKeys: string[];
  /** Boas práticas observadas na última etapa, para reconhecimento. */
  goodPracticeNotes: string[];
  /** Gatilho que motivou a orientação. */
  trigger: "ETAPA_CONCLUIDA" | "EVIDENCIA_ILEGIVEL" | "DIVERGENCIA_PESO" | "SEM_BALANCA" | "ATRASO_PENDENCIA";
}

/** Gera (sem enviar) a orientação da Fase B. O envio é decisão do n8n e só ocorre com OPERATION_PHASE=B. */
export async function generateInstructorMessage(
  client: ClaudeClient,
  input: InstructorInput,
): Promise<StructuredCallResult<InstructorMessage>> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: JSON.stringify(
        {
          motorista_primeiro_nome: input.driverFirstName,
          gatilho: input.trigger,
          etapa_atual: input.routeStatus.stage,
          cliente_em_contexto: input.routeStatus.currentClientCode,
          proxima_etapa_esperada: input.nextStep.description,
          itens_faltantes: input.nextStep.missingItems.map((i) => ({ chave: i.key, item: i.label, status: i.status, motivo: i.reason })),
          problemas_de_sequencia: input.routeStatus.sequenceIssues.map((s) => s.description),
          orientacoes_ja_enviadas_recentemente: input.recentlySentItemKeys,
          boas_praticas_observadas: input.goodPracticeNotes,
        },
        null,
        2,
      ),
    },
  ];
  return client.structured({ system: INSTRUCTOR_SYSTEM, content, schema: InstructorMessageSchema, effort: "low", maxTokens: 1024 });
}

/** Redige a narrativa do relatório de encerramento a partir do estado calculado pelo software. */
export async function generateRouteReportNarrative(
  client: ClaudeClient,
  input: { driverName: string; routeDate: string | null; status: RouteStatus; weighingDetails: unknown[] },
): Promise<StructuredCallResult<RouteReportNarrative>> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: "text",
      text: `Estado documental da rota (gerado pelo software):\n${JSON.stringify(input, null, 2)}`,
    },
  ];
  return client.structured({ system: ROUTE_REPORT_SYSTEM, content, schema: RouteReportNarrativeSchema, effort: "medium", maxTokens: 4096 });
}
