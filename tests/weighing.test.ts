import { describe, expect, it } from "vitest";
import { assessCoverage, assessWeighing } from "../src/domain/weighing.js";

describe("assessWeighing (POP 5.3)", () => {
  it("é CONFORME quando etiqueta e visor coincidem no mesmo quadro", () => {
    const r = assessWeighing({ labelKg: 12.5, scaleKg: 12.5, bothInSameFrame: true });
    expect(r.result).toBe("CONFORME");
    expect(r.differenceKg).toBe(0);
  });

  it("sinaliza TODA diferença — nenhuma tolerância inventada", () => {
    const r = assessWeighing({ labelKg: 12.5, scaleKg: 12.52, bothInSameFrame: true });
    expect(r.result).toBe("DIVERGENTE");
    expect(r.differenceKg).toBe(0.02);
    expect(r.reason).toContain("POP não define tolerância");
  });

  it("aplica tolerância somente quando parametrizada pela gestão", () => {
    const within = assessWeighing({ labelKg: 12.5, scaleKg: 12.52, bothInSameFrame: true, toleranceKg: 0.05 });
    expect(within.result).toBe("CONFORME");
    const above = assessWeighing({ labelKg: 12.5, scaleKg: 12.6, bothInSameFrame: true, toleranceKg: 0.05 });
    expect(above.result).toBe("DIVERGENTE");
  });

  it("é NÃO VERIFICÁVEL sem os dois elementos no mesmo quadro", () => {
    const r = assessWeighing({ labelKg: 12.5, scaleKg: 12.5, bothInSameFrame: false });
    expect(r.result).toBe("ILEGIVEL_NAO_VERIFICAVEL");
    expect(r.differenceKg).toBeNull();
  });

  it("é NÃO VERIFICÁVEL quando um dos pesos não foi lido, preservando o valor lido", () => {
    const r = assessWeighing({ labelKg: null, scaleKg: 12.5, bothInSameFrame: true });
    expect(r.result).toBe("ILEGIVEL_NAO_VERIFICAVEL");
    expect(r.scaleKg).toBe(12.5);
    expect(r.labelKg).toBeNull();
  });
});

describe("assessCoverage (limitação de cobertura)", () => {
  it("indica limitação quando a nota não especifica caixas", () => {
    expect(assessCoverage({ boxesOnInvoice: null, verifiableWeighings: 3, totalWeighings: 3 }).status).toBe("LIMITACAO_COBERTURA");
  });
  it("indica cobertura incompleta quando há menos pesagens verificáveis que caixas", () => {
    expect(assessCoverage({ boxesOnInvoice: 5, verifiableWeighings: 3, totalWeighings: 4 }).status).toBe("INCOMPLETA");
  });
  it("indica cobertura completa", () => {
    expect(assessCoverage({ boxesOnInvoice: 3, verifiableWeighings: 3, totalWeighings: 3 }).status).toBe("COMPLETA");
  });
  it("indica ausência de pesagem", () => {
    expect(assessCoverage({ boxesOnInvoice: 3, verifiableWeighings: 0, totalWeighings: 0 }).status).toBe("SEM_PESAGEM");
  });
});
