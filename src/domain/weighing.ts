/**
 * Regras específicas das pesagens (POP 5.3).
 *
 *  - A IA pode extrair peso da etiqueta e do visor; o CÁLCULO da diferença é feito aqui, em software,
 *    mantendo os valores originais e a unidade (kg).
 *  - Sem peso de AMBOS os elementos legível no MESMO QUADRO, a foto é NÃO VERIFICÁVEL.
 *  - Toda diferença identificada é sinalizada. O POP não define tolerância numérica; nenhum
 *    limite automático deve ser inventado. A tolerância só existe se a gestão a parametrizar
 *    (system_settings.weighing_tolerance_kg) — ver docs/03-pontos-de-aprovacao.md.
 *  - Quando a nota não especifica caixas e pesos individuais, a auditoria indica limitação de cobertura.
 */

import type { AssessmentResult } from "./types.js";

export interface WeighingInput {
  labelKg: number | null | undefined;
  scaleKg: number | null | undefined;
  bothInSameFrame: boolean | null | undefined;
  /** Tolerância parametrizada pela gestão, em kg. undefined/null = sem tolerância (toda diferença sinaliza). */
  toleranceKg?: number | null;
}

export interface WeighingAssessment {
  result: Extract<AssessmentResult, "CONFORME" | "DIVERGENTE" | "ILEGIVEL_NAO_VERIFICAVEL">;
  labelKg: number | null;
  scaleKg: number | null;
  /** scaleKg - labelKg, em kg, com 3 casas; null quando não verificável. */
  differenceKg: number | null;
  reason: string;
}

export function assessWeighing(input: WeighingInput): WeighingAssessment {
  const labelKg = isFiniteNumber(input.labelKg) ? input.labelKg : null;
  const scaleKg = isFiniteNumber(input.scaleKg) ? input.scaleKg : null;

  if (input.bothInSameFrame !== true) {
    return {
      result: "ILEGIVEL_NAO_VERIFICAVEL",
      labelKg,
      scaleKg,
      differenceKg: null,
      reason: "etiqueta e visor da balança não estão legíveis no mesmo quadro",
    };
  }
  if (labelKg === null || scaleKg === null) {
    return {
      result: "ILEGIVEL_NAO_VERIFICAVEL",
      labelKg,
      scaleKg,
      differenceKg: null,
      reason: labelKg === null && scaleKg === null
        ? "peso da etiqueta e do visor não legíveis"
        : labelKg === null
          ? "peso da etiqueta não legível"
          : "peso do visor da balança não legível",
    };
  }

  const differenceKg = round3(scaleKg - labelKg);
  const tolerance = isFiniteNumber(input.toleranceKg) && input.toleranceKg >= 0 ? input.toleranceKg : null;

  if (differenceKg === 0) {
    return { result: "CONFORME", labelKg, scaleKg, differenceKg, reason: "pesos iguais" };
  }
  if (tolerance !== null && Math.abs(differenceKg) <= tolerance) {
    return {
      result: "CONFORME",
      labelKg,
      scaleKg,
      differenceKg,
      reason: `diferença de ${formatKg(differenceKg)} dentro da tolerância parametrizada pela gestão (${formatKg(tolerance)})`,
    };
  }
  return {
    result: "DIVERGENTE",
    labelKg,
    scaleKg,
    differenceKg,
    reason:
      tolerance === null
        ? `diferença de ${formatKg(differenceKg)} (POP não define tolerância; toda diferença é sinalizada)`
        : `diferença de ${formatKg(differenceKg)} acima da tolerância parametrizada (${formatKg(tolerance)})`,
  };
}

export interface CoverageInput {
  /** Caixas declaradas na nota fiscal; null quando a nota não especifica caixas/pesos individuais. */
  boxesOnInvoice: number | null | undefined;
  /** Fotos de pesagem verificáveis (CONFORME ou DIVERGENTE) recebidas para o cliente. */
  verifiableWeighings: number;
  /** Fotos de pesagem recebidas no total (inclui ilegíveis). */
  totalWeighings: number;
}

export interface CoverageAssessment {
  status: "COMPLETA" | "INCOMPLETA" | "LIMITACAO_COBERTURA" | "SEM_PESAGEM";
  reason: string;
}

export function assessCoverage(input: CoverageInput): CoverageAssessment {
  if (input.totalWeighings === 0) {
    return { status: "SEM_PESAGEM", reason: "nenhuma foto de pesagem recebida" };
  }
  if (!isFiniteNumber(input.boxesOnInvoice) || input.boxesOnInvoice <= 0) {
    return {
      status: "LIMITACAO_COBERTURA",
      reason:
        "a nota não especifica caixas e pesos individuais; não é possível assegurar que todas as caixas foram pesadas apenas pelas fotos recebidas",
    };
  }
  if (input.verifiableWeighings < input.boxesOnInvoice) {
    return {
      status: "INCOMPLETA",
      reason: `${input.verifiableWeighings} pesagem(ns) verificável(is) para ${input.boxesOnInvoice} caixa(s) na nota`,
    };
  }
  return { status: "COMPLETA", reason: `${input.verifiableWeighings} pesagem(ns) para ${input.boxesOnInvoice} caixa(s)` };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function formatKg(v: number): string {
  return `${v.toFixed(3).replace(/\.?0+$/, "")} kg`;
}
