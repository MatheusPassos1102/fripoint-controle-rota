/**
 * Porta de IA: abstrai as operações Claude para que o pipeline rode offline (stub) em testes e simulação.
 */

import type { StructuredCallResult } from "../claude/client.js";
import type { EvidenceContext, ImageMediaType, InstructorInput } from "../claude/operations.js";
import type { EvidenceAnalysis, InstructorMessage, MessageClassification, RouteReportNarrative } from "../claude/schemas.js";
import type { RouteStatus } from "../domain/route-state.js";

export interface AiPort {
  analyzePhoto(image: { base64: string; mediaType: ImageMediaType }, context: EvidenceContext): Promise<StructuredCallResult<EvidenceAnalysis>>;
  classifyMessage(text: string, context: { routeStageDescription: string; currentClientCode: string | null }): Promise<StructuredCallResult<MessageClassification>>;
  instructor(input: InstructorInput): Promise<StructuredCallResult<InstructorMessage>>;
  reportNarrative(input: { driverName: string; routeDate: string | null; status: RouteStatus; weighingDetails: unknown[] }): Promise<StructuredCallResult<RouteReportNarrative>>;
}

/** Implementação real sobre a Claude API. */
export async function createClaudeAiPort(): Promise<AiPort> {
  const { ClaudeClient, claudeConfigFromEnv } = await import("../claude/client.js");
  const ops = await import("../claude/operations.js");
  const client = new ClaudeClient(claudeConfigFromEnv());
  return {
    analyzePhoto: (image, context) => ops.analyzeEvidencePhoto(client, image, context),
    classifyMessage: (text, context) => ops.classifyAmbiguousMessage(client, text, context),
    instructor: (input) => ops.generateInstructorMessage(client, input),
    reportNarrative: (input) => ops.generateRouteReportNarrative(client, input),
  };
}

const stubMeta = {
  servedBy: "stub",
  fallbackUsed: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  requestId: null,
};

/**
 * Stub determinístico para simulação offline: interpreta a legenda da foto como "dica" do tipo
 * (ex.: "pesagem 12.5/12.5") e nunca acessa a rede. Só para desenvolvimento e testes.
 */
export function createStubAiPort(): AiPort {
  return {
    async analyzePhoto(_image, context) {
      const caption = (context.caption ?? "").toLowerCase();
      const pick = (kind: EvidenceAnalysis["kind"], extra: Partial<EvidenceAnalysis["fields"]> = {}, legibility: EvidenceAnalysis["legibility"] = "LEGIVEL"): EvidenceAnalysis => ({
        kind,
        legibility,
        fields: {
          plate: null,
          odometer_km: null,
          fuel_level: null,
          invoice_number: null,
          client_code: null,
          label_kg: null,
          scale_kg: null,
          both_in_same_frame: null,
          boxes_count: null,
          signed_or_stamped: null,
          gps_destination: null,
          ...extra,
        },
        issues: legibility === "LEGIVEL" ? [] : ["simulação: foto marcada como ilegível"],
        possible_reuse_indicators: [],
        confidence: 0.95,
        summary: `simulação: ${kind}`,
      });
      let analysis: EvidenceAnalysis;
      const weigh = caption.match(/pesagem\s+([\d.,]+)\s*\/\s*([\d.,]+)/);
      if (weigh) {
        analysis = pick("FOTO_PESAGEM", { label_kg: Number(weigh[1]!.replace(",", ".")), scale_kg: Number(weigh[2]!.replace(",", ".")), both_in_same_frame: true });
      } else if (caption.includes("pesagem")) analysis = pick("FOTO_PESAGEM", {}, "ILEGIVEL");
      else if (caption.includes("placa")) analysis = pick("FOTO_PLACA", { plate: "ABC1D23" });
      else if (caption.includes("km")) analysis = pick("FOTO_KM_INICIAL", { odometer_km: 123456 });
      else if (caption.includes("combust")) analysis = pick("FOTO_COMBUSTIVEL_INICIAL", { fuel_level: "3/4" });
      else if (caption.includes("assinada") || caption.includes("carimb")) analysis = pick("FOTO_NOTA_ASSINADA", { signed_or_stamped: true });
      else if (caption.includes("nota")) analysis = pick("FOTO_NOTA_FISCAL", { invoice_number: "000123" });
      else if (caption.includes("gps") || caption.includes("waze")) analysis = pick("PRINT_GPS", { gps_destination: "Rua Exemplo, 100" });
      else if (caption.includes("bau") || caption.includes("baú")) analysis = pick("FOTO_BAU");
      else if (caption.includes("caixas")) analysis = pick("FOTO_CAIXAS_CONTAVEIS", { boxes_count: 6 });
      else if (caption.includes("ilegivel") || caption.includes("ilegível")) analysis = pick("FOTO_PLACA", {}, "ILEGIVEL");
      else analysis = pick("OUTRA", {}, "ILEGIVEL");
      return { data: analysis, ...stubMeta };
    },
    async classifyMessage(text) {
      return {
        data: { event_type: null, client_code: null, route_date: null, is_problem_report: /problema|avaria|falta/i.test(text), is_question_to_supervision: /\?/.test(text), confidence: 0.5, reason: "simulação" },
        ...stubMeta,
      };
    },
    async instructor(input) {
      return {
        data: {
          should_send: input.nextStep.missingItems.length > 0,
          message: `${input.driverFirstName}, próximo passo: ${input.nextStep.description}.`,
          teaches: { what: input.nextStep.description, how: "siga o padrão do POP", why: "garante a rastreabilidade da entrega" },
          reinforces_good_practice: input.goodPracticeNotes.length > 0,
        },
        ...stubMeta,
      };
    },
    async reportNarrative(input) {
      const c = input.status.counts;
      return {
        data: {
          headline: `Rota ${input.status.stage.toLowerCase()} — ${c.CONFORME} conformes, ${c.PENDENTE} pendentes, ${c.DIVERGENTE} divergentes`,
          summary: "Narrativa gerada em modo simulação (sem IA).",
          attention_points: input.status.sequenceIssues.map((s) => s.description),
          training_opportunities: [],
          good_practices: [],
        },
        ...stubMeta,
      };
    },
  };
}
