# Triagem de currículos (Indeed)

Avalia automaticamente os currículos recebidos no Indeed contra os requisitos de uma vaga
e gera uma planilha Excel ordenada, com recomendação **avançar / talvez / descartar**,
nota de 0 a 100, evidência de cada requisito e dados de contato.

## Como funciona

1. Você baixa os currículos da vaga no painel de empregador do Indeed.
2. Descreve a vaga num arquivo YAML (requisitos obrigatórios e desejáveis).
3. O script lê cada currículo (PDF, DOCX ou TXT, inclusive PDF escaneado) e usa a IA da
   Anthropic (Claude) para avaliar requisito por requisito.
4. Sai uma planilha em `resultados/` com os melhores candidatos no topo.

A decisão final continua sendo de uma pessoa. A ferramenta serve para priorizar quem ler primeiro.

## Por que não conecta direto no Indeed

O Indeed não oferece uma API aberta para empresas puxarem candidatos. O acesso por API
é restrito a parceiros de ATS (sistemas de recrutamento). Automatizar o painel com robô
viola os termos de uso e pode bloquear a conta. Por isso o fluxo usa os arquivos que o
próprio Indeed permite baixar.

## 1. Baixar os currículos do Indeed

No painel de empregador (employers.indeed.com):

1. Abra a vaga e vá em **Candidatos**.
2. Selecione os candidatos e use a opção de **baixar currículos**. Descompacte o arquivo
   numa pasta, por exemplo `curriculos/motorista/`.
3. Opcional: use **exportar** para baixar a planilha CSV de candidatos. Ela traz as
   respostas das perguntas de triagem, que também são enviadas para a avaliação.

Os nomes dos menus podem mudar. Se não encontrar, procure por "download" ou "exportar" na
lista de candidatos.

## 2. Instalar (uma vez)

Requer Python 3.10 ou superior.

```bash
pip install -r requirements.txt
```

Crie uma chave de API em https://console.anthropic.com e configure:

```bash
export ANTHROPIC_API_KEY="sua-chave-aqui"
```

No Windows (PowerShell): `$env:ANTHROPIC_API_KEY="sua-chave-aqui"`.

## 3. Descrever a vaga

Copie `vagas/motorista-entregador.yaml` e ajuste título, requisitos obrigatórios,
desejáveis, observações e nota de corte. Escreva os requisitos como escreveria para
uma pessoa, por exemplo "CNH categoria D válida".

## 4. Rodar

```bash
python triagem.py --vaga vagas/motorista-entregador.yaml --curriculos curriculos/motorista/
```

Com a planilha exportada do Indeed:

```bash
python triagem.py --vaga vagas/motorista-entregador.yaml --curriculos curriculos/motorista/ --csv-indeed candidatos.csv
```

Sem IA, só por palavras-chave, para um teste grátis e bem mais simples:

```bash
python triagem.py --vaga vagas/motorista-entregador.yaml --curriculos curriculos/motorista/ --sem-ia
```

Opções úteis:

| Opção | O que faz |
|---|---|
| `--saida arquivo.xlsx` | Define o nome da planilha gerada |
| `--paralelo 4` | Quantos currículos avaliar ao mesmo tempo |

Currículos já avaliados ficam guardados em `.cache/`. Rodar de novo com novos currículos
só avalia os novos. Se você alterar o arquivo da vaga, todos são reavaliados.

## A planilha

- **Aba Triagem:** uma linha por candidato, colorida por recomendação, com filtros.
  As colunas de requisitos mostram `[sim]`, `[nao]` ou `[incerto]` e o trecho do currículo
  que comprova.
- **Aba Resumo:** quantos candidatos em cada recomendação.

Qualquer obrigatório marcado "não" leva a "descartar". Um obrigatório "incerto" leva no
máximo a "talvez", para alguém confirmar na entrevista.

## Custo

Cada currículo é uma chamada à API, cobrada por uso no console da Anthropic. Faça um teste
com 5 a 10 currículos e confira o custo no console antes de rodar centenas.

## Cuidados com LGPD e discriminação

- Currículos são dados pessoais. O texto é enviado à API da Anthropic para análise. Informe
  isso na sua política de privacidade de recrutamento e não guarde os arquivos além do necessário.
- A IA é instruída a ignorar idade, gênero, raça, estado civil, foto e outros dados
  sensíveis. Mesmo assim, revise os descartados de vez em quando.
- As pastas `curriculos/`, `resultados/` e `.cache/` estão no `.gitignore` para que dados de
  candidatos nunca sejam enviados ao repositório.
