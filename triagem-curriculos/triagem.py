#!/usr/bin/env python3
"""Triagem automática de currículos baixados do Indeed.

Lê uma pasta de currículos (PDF, DOCX ou TXT), avalia cada um contra os
requisitos de uma vaga descrita em YAML e gera uma planilha ordenada por nota.

Uso:
    python triagem.py --vaga vagas/motorista-entregador.yaml --curriculos curriculos/
    python triagem.py --vaga vagas/motorista-entregador.yaml --curriculos curriculos/ --sem-ia
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import re
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import yaml

MODELO = "claude-opus-5-5"
EXTENSOES = {".pdf", ".docx", ".txt"}
DIR_CACHE = Path(".cache")

# ---------------------------------------------------------------------------
# Esquema da resposta da IA (saída estruturada: o JSON sempre segue este formato)
# ---------------------------------------------------------------------------
ESQUEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "nome", "email", "telefone", "cidade", "nota", "recomendacao",
        "requisitos", "pontos_fortes", "pontos_de_atencao", "resumo",
    ],
    "properties": {
        "nome": {"type": "string"},
        "email": {"type": "string"},
        "telefone": {"type": "string"},
        "cidade": {"type": "string"},
        "nota": {"type": "integer", "description": "0 a 100"},
        "recomendacao": {"type": "string", "enum": ["avancar", "talvez", "descartar"]},
        "requisitos": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["requisito", "tipo", "atendido", "evidencia"],
                "properties": {
                    "requisito": {"type": "string"},
                    "tipo": {"type": "string", "enum": ["obrigatorio", "desejavel"]},
                    "atendido": {"type": "string", "enum": ["sim", "nao", "incerto"]},
                    "evidencia": {"type": "string"},
                },
            },
        },
        "pontos_fortes": {"type": "array", "items": {"type": "string"}},
        "pontos_de_atencao": {"type": "array", "items": {"type": "string"}},
        "resumo": {"type": "string"},
    },
}

INSTRUCOES = """Você é um analista de recrutamento fazendo a triagem inicial de currículos.
Avalie o currículo exclusivamente contra os requisitos da vaga informada.

Regras:
- Avalie cada requisito obrigatório e desejável, citando a evidência encontrada no currículo.
  Se o currículo não menciona o requisito, marque "nao"; se a informação é ambígua, "incerto".
- Se algum obrigatório estiver "nao", a recomendação é "descartar". Se algum estiver "incerto",
  a recomendação no máximo é "talvez", para que uma pessoa confirme.
- "avancar" exige todos os obrigatórios atendidos e nota igual ou acima da nota de corte.
- A nota (0 a 100) reflete aderência à vaga: obrigatórios pesam mais, desejáveis complementam.
- Não considere nem comente idade, gênero, raça, cor, religião, estado civil, filhos,
  deficiência, orientação sexual, aparência ou foto. Esses dados não podem influenciar a avaliação.
- Não invente informações. Campos de contato ausentes ficam como string vazia.
- Escreva em português, de forma objetiva. O resumo tem no máximo 3 frases."""


# ---------------------------------------------------------------------------
# Leitura de arquivos
# ---------------------------------------------------------------------------
def extrair_texto(caminho: Path) -> str:
    ext = caminho.suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        leitor = PdfReader(str(caminho))
        return "\n".join((p.extract_text() or "") for p in leitor.pages).strip()
    if ext == ".docx":
        import docx
        doc = docx.Document(str(caminho))
        partes = [p.text for p in doc.paragraphs]
        for tabela in doc.tables:
            for linha in tabela.rows:
                partes.append(" | ".join(c.text for c in linha.cells))
        return "\n".join(partes).strip()
    return caminho.read_text(encoding="utf-8", errors="ignore").strip()


def normalizar(texto: str) -> str:
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", texto.lower()).strip()


def carregar_csv_indeed(caminho: Path | None) -> list[dict]:
    """Lê a planilha de candidatos exportada do Indeed (opcional)."""
    if not caminho:
        return []
    with caminho.open(encoding="utf-8-sig", newline="") as f:
        amostra = f.read(4096)
        f.seek(0)
        try:
            dialeto = csv.Sniffer().sniff(amostra, delimiters=",;\t")
        except csv.Error:
            dialeto = csv.excel
        return [dict(l) for l in csv.DictReader(f, dialect=dialeto)]


def achar_linha_csv(arquivo: Path, linhas: list[dict]) -> dict | None:
    """Associa um currículo à linha do CSV cujo nome aparece no nome do arquivo."""
    nome_arquivo = normalizar(arquivo.stem)
    melhor, melhor_qtd = None, 0
    for linha in linhas:
        nome = next((v for k, v in linha.items() if k and normalizar(k) in ("name", "nome", "candidate name", "nome do candidato")), "")
        tokens = [t for t in normalizar(nome or "").split() if len(t) > 2]
        if tokens and all(t in nome_arquivo.split() for t in tokens) and len(tokens) > melhor_qtd:
            melhor, melhor_qtd = linha, len(tokens)
    return melhor


# ---------------------------------------------------------------------------
# Avaliação com IA
# ---------------------------------------------------------------------------
def descrever_vaga(vaga: dict) -> str:
    linhas = [f"Vaga: {vaga['titulo']}"]
    if vaga.get("local"):
        linhas.append(f"Local: {vaga['local']}")
    if vaga.get("descricao"):
        linhas.append(f"Descrição: {vaga['descricao'].strip()}")
    linhas.append("Requisitos obrigatórios:")
    linhas += [f"- {r}" for r in vaga.get("obrigatorios", [])]
    linhas.append("Requisitos desejáveis:")
    linhas += [f"- {r}" for r in vaga.get("desejaveis", [])]
    if vaga.get("observacoes"):
        linhas.append(f"Observações do recrutador: {vaga['observacoes'].strip()}")
    linhas.append(f"Nota de corte para 'avancar': {vaga.get('nota_corte', 70)}")
    return "\n".join(linhas)


def avaliar_com_ia(cliente, vaga: dict, arquivo: Path, texto: str, extra_csv: dict | None) -> dict:
    conteudo: list[dict] = []
    if texto:
        conteudo.append({"type": "text", "text": f"<curriculo arquivo=\"{arquivo.name}\">\n{texto}\n</curriculo>"})
    elif arquivo.suffix.lower() == ".pdf":
        # PDF escaneado (imagem, sem texto): a IA lê o PDF diretamente.
        dados = base64.standard_b64encode(arquivo.read_bytes()).decode()
        conteudo.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": dados}})
    else:
        raise ValueError("arquivo sem texto legível")

    if extra_csv:
        dados_csv = "\n".join(f"{k}: {v}" for k, v in extra_csv.items() if k and v)
        conteudo.append({"type": "text", "text": f"<dados_indeed>\n{dados_csv}\n</dados_indeed>"})

    conteudo.append({"type": "text", "text": descrever_vaga(vaga) + "\n\nAvalie este candidato para a vaga acima."})

    resposta = cliente.messages.create(
        model=MODELO,
        max_tokens=16000,
        system=INSTRUCOES,
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": ESQUEMA}},
        messages=[{"role": "user", "content": conteudo}],
        # Se a IA recusar a análise, a Anthropic refaz a chamada com outro modelo automaticamente.
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default"},
    )
    if resposta.stop_reason == "refusal":
        raise RuntimeError("a IA recusou analisar este currículo")
    if resposta.stop_reason == "max_tokens":
        raise RuntimeError("resposta cortada por limite de tamanho")
    texto_json = next(b.text for b in resposta.content if b.type == "text")
    return json.loads(texto_json)


# ---------------------------------------------------------------------------
# Avaliação sem IA (palavras-chave)
# ---------------------------------------------------------------------------
def avaliar_por_palavras(vaga: dict, texto: str) -> dict:
    alvo = normalizar(texto)
    chaves = vaga.get("palavras_chave", {})
    obrig = chaves.get("obrigatorias", [])
    desej = chaves.get("desejaveis", [])
    faltando = [p for p in obrig if normalizar(p) not in alvo]
    achadas = [p for p in desej if normalizar(p) in alvo]
    nota = 0 if faltando else int(40 + 60 * len(achadas) / max(len(desej), 1))
    email = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", texto)
    fone = re.search(r"\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}", texto)
    corte = vaga.get("nota_corte", 70)
    return {
        "nome": "", "email": email.group(0) if email else "",
        "telefone": fone.group(0) if fone else "", "cidade": "",
        "nota": nota,
        "recomendacao": "descartar" if faltando else ("avancar" if nota >= corte else "talvez"),
        "requisitos": [{"requisito": p, "tipo": "obrigatorio", "atendido": "nao" if p in faltando else "sim", "evidencia": ""} for p in obrig],
        "pontos_fortes": [f"Menciona: {', '.join(achadas)}"] if achadas else [],
        "pontos_de_atencao": [f"Não menciona: {', '.join(faltando)}"] if faltando else [],
        "resumo": "Avaliação por palavras-chave, sem IA.",
    }


# ---------------------------------------------------------------------------
# Planilha de resultado
# ---------------------------------------------------------------------------
ORDEM_REC = {"avancar": 0, "talvez": 1, "descartar": 2, "erro": 3}
CORES = {"avancar": "C6EFCE", "talvez": "FFEB9C", "descartar": "FFC7CE", "erro": "D9D9D9"}


def salvar_planilha(resultados: list[dict], destino: Path, vaga: dict) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Triagem"
    colunas = ["Recomendação", "Nota", "Nome", "Telefone", "E-mail", "Cidade", "Resumo",
               "Obrigatórios", "Desejáveis", "Pontos fortes", "Pontos de atenção", "Arquivo"]
    ws.append(colunas)
    for c in ws[1]:
        c.font = Font(bold=True)

    for r in resultados:
        reqs = r.get("requisitos", [])
        def fmt(tipo):
            return "\n".join(f"[{q['atendido']}] {q['requisito']}" + (f" ({q['evidencia']})" if q.get("evidencia") else "")
                             for q in reqs if q.get("tipo") == tipo)
        ws.append([
            r["recomendacao"], r.get("nota", 0), r.get("nome", ""), r.get("telefone", ""),
            r.get("email", ""), r.get("cidade", ""), r.get("resumo", ""),
            fmt("obrigatorio"), fmt("desejavel"),
            "\n".join(r.get("pontos_fortes", [])), "\n".join(r.get("pontos_de_atencao", [])),
            r["arquivo"],
        ])
        cor = CORES.get(r["recomendacao"], "FFFFFF")
        ws.cell(ws.max_row, 1).fill = PatternFill("solid", fgColor=cor)

    larguras = [14, 7, 28, 16, 28, 18, 60, 60, 50, 40, 40, 30]
    for i, w in enumerate(larguras, start=1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = w
    for linha in ws.iter_rows(min_row=2):
        for c in linha:
            c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions

    resumo = wb.create_sheet("Resumo")
    resumo.append(["Vaga", vaga["titulo"]])
    resumo.append(["Gerado em", datetime.now().strftime("%d/%m/%Y %H:%M")])
    for rec in ("avancar", "talvez", "descartar", "erro"):
        resumo.append([rec, sum(1 for r in resultados if r["recomendacao"] == rec)])
    wb.save(destino)


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------
def chave_cache(arquivo: Path, vaga_txt: str, modo: str) -> str:
    h = hashlib.sha256()
    h.update(arquivo.read_bytes())
    h.update(vaga_txt.encode())
    h.update(modo.encode())
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="Triagem automática de currículos do Indeed.")
    ap.add_argument("--vaga", required=True, type=Path, help="arquivo YAML da vaga")
    ap.add_argument("--curriculos", required=True, type=Path, help="pasta com os currículos (PDF/DOCX/TXT)")
    ap.add_argument("--csv-indeed", type=Path, help="planilha de candidatos exportada do Indeed (opcional)")
    ap.add_argument("--saida", type=Path, help="planilha de saída (.xlsx)")
    ap.add_argument("--sem-ia", action="store_true", help="usa só palavras-chave, sem chamar a IA")
    ap.add_argument("--paralelo", type=int, default=4, help="currículos avaliados ao mesmo tempo")
    args = ap.parse_args()

    vaga_txt = args.vaga.read_text(encoding="utf-8")
    vaga = yaml.safe_load(vaga_txt)
    arquivos = sorted(p for p in args.curriculos.rglob("*") if p.suffix.lower() in EXTENSOES)
    if not arquivos:
        print(f"Nenhum currículo PDF/DOCX/TXT encontrado em {args.curriculos}", file=sys.stderr)
        return 1
    linhas_csv = carregar_csv_indeed(args.csv_indeed)

    cliente = None
    if not args.sem_ia:
        import anthropic
        cliente = anthropic.Anthropic()  # usa a variável de ambiente ANTHROPIC_API_KEY

    modo = "palavras" if args.sem_ia else MODELO
    DIR_CACHE.mkdir(exist_ok=True)

    def processar(arquivo: Path) -> dict:
        cache = DIR_CACHE / f"{chave_cache(arquivo, vaga_txt, modo)}.json"
        if cache.exists():
            return json.loads(cache.read_text(encoding="utf-8"))
        try:
            texto = extrair_texto(arquivo)
            if args.sem_ia:
                r = avaliar_por_palavras(vaga, texto)
            else:
                r = avaliar_com_ia(cliente, vaga, arquivo, texto, achar_linha_csv(arquivo, linhas_csv))
        except Exception as e:  # um currículo com problema não interrompe os demais
            return {"arquivo": arquivo.name, "recomendacao": "erro", "nota": 0, "resumo": f"Erro: {e}"}
        r["arquivo"] = arquivo.name
        if not r.get("nome"):
            r["nome"] = arquivo.stem
        cache.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")
        return r

    resultados = []
    with ThreadPoolExecutor(max_workers=max(1, args.paralelo)) as pool:
        futuros = {pool.submit(processar, a): a for a in arquivos}
        for i, f in enumerate(as_completed(futuros), start=1):
            r = f.result()
            resultados.append(r)
            print(f"[{i}/{len(arquivos)}] {r['recomendacao']:<9} {r.get('nota', 0):>3}  {r['arquivo']}")

    resultados.sort(key=lambda r: (ORDEM_REC.get(r["recomendacao"], 9), -int(r.get("nota", 0))))
    destino = args.saida or Path("resultados") / f"triagem-{args.vaga.stem}-{datetime.now():%Y%m%d-%H%M}.xlsx"
    destino.parent.mkdir(parents=True, exist_ok=True)
    salvar_planilha(resultados, destino, vaga)

    contagem = {k: sum(1 for r in resultados if r["recomendacao"] == k) for k in ORDEM_REC}
    print(f"\nAvançar: {contagem['avancar']} | Talvez: {contagem['talvez']} | "
          f"Descartar: {contagem['descartar']} | Erros: {contagem['erro']}")
    print(f"Planilha salva em: {destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
