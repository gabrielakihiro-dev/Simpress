"""Sugestão de Categoria (coluna B) e Tipo (coluna J) dos chamados novos do Sebrae.

A sugestão só aparece na tela: nunca é gravada no Dashboard. O índice (``sebrae_categoria_indice.json``,
estado local fora do Git) guarda apenas contagens de palavras de uso comum, sem texto, nome, CPF nem e-mail,
e é refeito a cada importação ou atualização do Dashboard. Ordem da categoria: solicitante de sistema,
regras (DESLIGAMENTO, NOVO USUÁRIO, INSTALAÇÃO, PERIFÉRICO, ENDPOINT CENTER, categorias novas), Naive Bayes
e, por último, OUTRO."""
from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Dict, FrozenSet, Iterable, List, Mapping, NamedTuple, Optional, Pattern, Sequence, Tuple

from core.integrity import atomic_write_json
from domains.assistant_lgpd import e_solicitante_sistema, limpar_texto_sensivel
from domains.sebrae_chamados import mascarar_cpfs
from domains.sebrae_dashboard import omitir_credenciais
from domains.sebrae_dashboard_gravacao import valores_dos_chamados

CATEGORIAS_NOVAS = ("IMPRESSORA", "LICENÇA", "SISTEMA", "REDE")
TIPOS = ("INCIDENTE", "SOLICITAÇÃO")
INCIDENTE, SOLICITACAO = TIPOS
LIMITE_NB = 0.3  # probabilidade mínima do topo para o Naive Bayes sugerir; abaixo disso cai em OUTRO (melhor acerto da cascata na validação cruzada)
ETAPA_FINAL_J = "nb"  # "nb" (Naive Bayes de J) ou "mapa" (J majoritário da categoria, com Naive Bayes de reserva); medidos empatados, "nb" é mais simples
VERSAO_INDICE = 1
MIN_DOCUMENTOS_PALAVRA = 2  # uma palavra de um só chamado poderia identificar quem o abriu
MIN_CASOS_MAPA = 5
MIN_FRACAO_MAPA = 0.8
MAX_CARACTERES_CAMPO = 20_000
ARQUIVO_INDICE = "sebrae_categoria_indice.json"

# Índices em ``valores_dos_chamados`` (``COLUNAS_DE_DADO``: A..P, R, S).
_B, _F, _G, _H, _I, _J = 1, 5, 6, 7, 8, 9

_STOP = frozenset(
    "para com uma uns umas que nao por dos das mais como foi esta este isso ele ela seu sua seus suas meu minha tem ter "
    "sem mas nos nas aos ser sao era ate pelo pela pelos pelas sobre entre quando onde qual quais cada todo toda todos "
    "todas muito muita ainda tambem apos antes depois aqui ali vez vai vao pode podem poderia fazer feito favor bom dia "
    "boa tarde noite ola prezado prezados prezada atenciosamente obrigado obrigada grato cordialmente att".split()
)

# Regras de categoria, na ordem de prioridade; cada rótulo só vale se estiver nas opções da lista de B.
REGRAS_B: Tuple[Tuple[str, Pattern[str]], ...] = tuple(
    (rotulo, re.compile(padrao))
    for rotulo, padrao in (
        ("DESLIGAMENTO", r"\b(desligament\w*|deslig\w* (de |do |da )?(usuario|colaborador|funcionario|estagiario)|remoc\w* (de |do |da )?(usuario|acesso|conta|colaborador)|remover (o |a )?(usuario|acesso|conta)|exclu\w* (de |do |da )?(usuario|conta|acesso)|demiss\w*|demitid\w*|rescis\w*|desativ\w* (de |da |a )?(conta|usuario|login)|bloque\w* (de |da |do )?(conta|usuario|login|acesso)|retirada (de |do |dos )?(equipamento|kit|notebook)|devoluc\w* (de |do |dos )?(equipamento|kit|notebook)|saida (de |do |da )?(colaborador|funcionario|estagiario)|fim (de |do )?contrato)\b"),
        ("NOVO USUÁRIO", r"\b(novos? usuarios?|usuarios? novos?|novos? colaborador\w*|colaborador\w* novos?|novos? funcionari\w*|novos? estagiari\w*|criac\w* (de |do |da )?(login|usuario|conta|acesso|e ?mail)|cria\w* (o |a |um |uma )?(login|usuario|conta)|login novo|novo login|nova conta|conta nova|admiss\w*|admitid\w*|contratad\w*|onboarding|inicio (das )?atividades|liberac\w* (de |do )?acesso (para|ao|a) (o |a )?novo)\b"),
        ("INSTALAÇÃO", r"\b(instal\w*|reinstal\w*)\b"),
        ("PERIFÉRICO", r"\b(teclad\w*|mouses?|monitor(es)?|fones?|headsets?|headphones?|webcam\w*|perifer\w*|caixa de som|auricular\w*)\b"),
        ("ENDPOINT CENTER", r"\b(computer added|central inactivity|staged)\b"),
        ("IMPRESSORA", r"\b(impressor\w*|impressao|impressoes|imprimi\w*|scanner\w*|digitaliz\w*|toner\w*)\b"),
        ("LICENÇA", r"\b(licenc\w*|adobe|acrobat)\b"),
        ("SISTEMA", r"\b(sap|erp|totvs|protheus|sistemas?(?! operacional))\b"),
        ("REDE", r"\b(vpn|wi ?fi|rede|redes|internet)\b"),
    )
)

# Tipo: o que o texto diz de forma explícita vale mais que o Naive Bayes.
_SOL_EXPLICITO = re.compile(
    r"\b(instal\w*|reinstal\w*|novos? (usuario|colaborador|funcionario|estagiario|login)\w*|"
    r"(usuario|colaborador|funcionario|estagiario)s? novos?|login novo|nova conta|conta nova|"
    r"criac\w* (de |do |da )?(login|usuario|conta|acesso|e ?mail)|cria\w* (o |a |um |uma )?(login|usuario|conta)|"
    r"desligament\w*|admiss\w*|onboarding)\b"
)
_INC = re.compile(
    r"\b(erro\w*|falha\w*|problema\w*|nao (liga|funciona|abre|conecta|carrega|acessa|consigo|esta)|parou|travad\w*|"
    r"travand\w*|trava|lent\w*|quebrad\w*|danificad\w*|defeito\w*|queimad\w*|imprevist\w*|contingenc\w*|"
    r"incontingenc\w*|incidente\w*|instabilidade|inoperante|caiu|desligando|reinicia\w*|tela azul|pane|avaria\w*|"
    r"sem (acesso|internet|rede|conexao|som|imagem|video))\b"
)


class Linha(NamedTuple):
    titulo: str
    descricao: str
    atendimento: str
    solicitante: str
    b: str
    j: str


def normalizar(texto: Any) -> str:
    """Sem acento nem maiúscula, só letras e números separados por um espaço."""
    sem_acento = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    return " ".join(re.findall(r"[a-z0-9]+", sem_acento.lower()))


def texto_mascarado(titulo: Any, descricao: Any, atendimento: Any) -> str:
    """Título, descrição e atendimento juntos, com CPF, senha, e-mail e telefone já ocultados."""
    juntos = "\n".join(str(parte or "")[:MAX_CARACTERES_CAMPO] for parte in (titulo, descricao, atendimento))
    return limpar_texto_sensivel(omitir_credenciais(mascarar_cpfs(juntos)))


def texto_normalizado(titulo: Any, descricao: Any, atendimento: Any) -> str:
    """O texto mascarado normalizado, sem os marcadores ``[...]`` da máscara."""
    return normalizar(re.sub(r"\[[^\]]*\]", " ", texto_mascarado(titulo, descricao, atendimento)))


def tokens(texto: Any, nomes: FrozenSet[str] = frozenset()) -> List[str]:
    """Palavras distintas de 3 letras ou mais, sem palavras de ligação e sem nomes de pessoas."""
    vistos: Dict[str, None] = {}
    for palavra in re.findall(r"[a-z]{3,}", normalizar(texto)):
        if palavra not in _STOP and palavra not in nomes:
            vistos.setdefault(palavra)
    return list(vistos)


def _chave_rotulo(rotulo: Any) -> str:
    return " ".join(str(rotulo or "").split()).upper()


def _opcao(opcoes: Sequence[str], rotulo: str) -> Optional[str]:
    """A grafia exata da lista de opções para o rótulo (sem distinguir acento nem maiúscula)."""
    alvo = normalizar(rotulo)
    return next((opcao for opcao in opcoes if normalizar(opcao) == alvo), None)


def ler_linhas(conteudo: bytes) -> Tuple[List[Linha], FrozenSet[str]]:
    """Linhas de chamado do Dashboard e as palavras da coluna I (solicitantes), para nunca virarem palavra do índice."""
    linhas: List[Linha] = []
    nomes: set[str] = set()
    for valores in valores_dos_chamados(conteudo).values():
        solicitante = valores[_I]
        nomes.update(re.findall(r"[a-z]{3,}", normalizar(solicitante)))
        linhas.append(Linha(valores[_G], valores[_H], valores[_F], solicitante, valores[_B], valores[_J]))
    return linhas, frozenset(nomes)


def documento_da_linha(linha: Linha, nomes: FrozenSet[str]) -> Dict[str, Any]:
    """Só palavras e os dois rótulos: o texto do chamado não sai daqui."""
    return {
        "tokens": tokens(texto_normalizado(linha.titulo, linha.descricao, linha.atendimento), nomes),
        "b": _chave_rotulo(linha.b), "j": _chave_rotulo(linha.j),
    }


def palavras_de_nomes(nomes: Iterable[Any]) -> FrozenSet[str]:
    """Palavras (3+ letras, sem acento) de nomes de pessoas, para nunca virarem palavra do índice."""
    return frozenset(p for nome in nomes if isinstance(nome, str) for p in re.findall(r"[a-z]{3,}", normalizar(nome)))


def extrair_documentos(conteudo: bytes, nomes_extras: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    """Documentos de treino do Dashboard; chamados abertos pelo solicitante de sistema (API SEBRAE) ficam de fora.

    `nomes_extras` (inventário, representantes) também saem dos tokens: o técnico citado no atendimento não vira palavra.
    """
    linhas, nomes = ler_linhas(conteudo)
    nomes = nomes | palavras_de_nomes(nomes_extras)
    return [documento_da_linha(linha, nomes) for linha in linhas if not e_solicitante_sistema(linha.solicitante)]


def _treinar_alvo(documentos: Sequence[Mapping[str, Any]], alvo: str) -> Dict[str, Any]:
    rotulados = [doc for doc in documentos if doc.get(alvo)]
    presenca: Counter[str] = Counter()
    for doc in rotulados:
        presenca.update(set(doc["tokens"]))
    vocabulario = {palavra for palavra, quantos in presenca.items() if quantos >= MIN_DOCUMENTOS_PALAVRA}
    classes: Dict[str, Dict[str, Any]] = {}
    for doc in rotulados:
        classe = classes.setdefault(doc[alvo], {"docs": 0, "total": 0, "contagens": Counter()})
        classe["docs"] += 1
        for palavra in doc["tokens"]:
            if palavra in vocabulario:
                classe["contagens"][palavra] += 1
                classe["total"] += 1
    return {
        "vocab": sorted(vocabulario),
        "classes": {nome: {**dados, "contagens": dict(dados["contagens"])} for nome, dados in sorted(classes.items())},
    }


def _mapa_b_j(documentos: Sequence[Mapping[str, Any]]) -> Dict[str, str]:
    por_categoria: Dict[str, Counter[str]] = {}
    for doc in documentos:
        if doc.get("b") and doc.get("j"):
            por_categoria.setdefault(doc["b"], Counter())[doc["j"]] += 1
    mapa: Dict[str, str] = {}
    for categoria, tipos in por_categoria.items():
        total = sum(tipos.values())
        tipo, quantos = tipos.most_common(1)[0]
        if total >= MIN_CASOS_MAPA and quantos / total >= MIN_FRACAO_MAPA:
            mapa[categoria] = tipo
    return mapa


def treinar(documentos: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    """Naive Bayes multinomial de B e de J (vocabulário só com palavras de 2 chamados ou mais) e o mapa B para J."""
    return {
        "versao": VERSAO_INDICE,
        "b": _treinar_alvo(documentos, "b"),
        "j": _treinar_alvo(documentos, "j"),
        "mapa_b_j": _mapa_b_j(documentos),
    }


def pontuar(modelo: Mapping[str, Any], palavras: Sequence[str], opcoes: Sequence[str]) -> Dict[str, float]:
    """Probabilidade de cada classe do modelo que esteja em ``opcoes`` (grafia das opções); {} se nenhuma estiver."""
    classes = modelo.get("classes") or {}
    permitidas = {nome: exata for nome in classes if (exata := _opcao(opcoes, nome))}
    if not permitidas:
        return {}
    vocabulario = set(modelo.get("vocab") or ())
    presentes = [palavra for palavra in palavras if palavra in vocabulario]
    total_docs = sum(int(dados.get("docs", 0)) for dados in classes.values()) or 1
    tamanho = len(vocabulario)
    logs: Dict[str, float] = {}
    for nome, exata in permitidas.items():
        dados = classes[nome]
        contagens = dados.get("contagens") or {}
        total = int(dados.get("total", 0))
        pontos = math.log(max(int(dados.get("docs", 0)), 1) / total_docs)
        for palavra in presentes:
            pontos += math.log((int(contagens.get(palavra, 0)) + 1) / (total + tamanho))
        logs[exata] = pontos
    maior = max(logs.values())
    pesos = {nome: math.exp(pontos - maior) for nome, pontos in logs.items()}
    soma = sum(pesos.values())
    return {nome: peso / soma for nome, peso in pesos.items()}


def _indice_valido(indice: Any) -> bool:
    return (
        isinstance(indice, dict) and indice.get("versao") == VERSAO_INDICE
        and all(isinstance(indice.get(chave), dict) for chave in ("b", "j", "mapa_b_j"))
    )


def construir_indice(conteudo: bytes, destino: Path, nomes_extras: Iterable[Any] = ()) -> Dict[str, Any]:
    """Treina com o Dashboard e grava o índice de forma atômica; a falha de leitura ou de gravação sobe ao chamador."""
    indice = treinar(extrair_documentos(conteudo, nomes_extras))
    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(destino, indice)
    return indice


def carregar_indice(caminho: Path) -> Optional[Dict[str, Any]]:
    """O índice salvo, ou ``None`` se o arquivo não existe, está corrompido ou é de outra versão."""
    try:
        indice = json.loads(Path(caminho).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return indice if _indice_valido(indice) else None


def regra_categoria(texto: str, opcoes: Sequence[str]) -> Optional[str]:
    """Primeira regra de ``REGRAS_B`` que casa com o texto normalizado; rótulo fora de ``opcoes`` é ignorado."""
    for rotulo, padrao in REGRAS_B:
        exata = _opcao(opcoes, rotulo)
        if exata and padrao.search(texto):
            return exata
    return None


def regra_tipo(texto: str) -> Optional[Tuple[str, str]]:
    """``(etapa, tipo)`` da primeira regra de J que casa (``explicito`` ou ``incidente``), ou ``None``."""
    if _SOL_EXPLICITO.search(texto):
        return "explicito", SOLICITACAO
    if _INC.search(texto):
        return "incidente", INCIDENTE
    return None


def sugerir(
    titulo: Any, descricao: Any, atendimento: Any, solicitante: Any, opcoes: Sequence[str], indice: Optional[Mapping[str, Any]],
) -> Optional[str]:
    """Categoria sugerida para B na grafia exata de ``opcoes``; ``None`` quando não há o que sugerir."""
    if e_solicitante_sistema(solicitante):
        return None
    texto = texto_normalizado(titulo, descricao, atendimento)
    regra = regra_categoria(texto, opcoes)
    if regra:
        return regra
    if indice and _indice_valido(indice):
        probabilidades = pontuar(indice["b"], tokens(texto), opcoes)
        if probabilidades:
            melhor, chance = max(probabilidades.items(), key=lambda par: par[1])
            if chance >= LIMITE_NB:
                return melhor
    return _opcao(opcoes, "OUTRO")


def sugerir_tipo(
    titulo: Any, descricao: Any, atendimento: Any, solicitante: Any, indice: Optional[Mapping[str, Any]], categoria: Optional[str] = None,
) -> Optional[str]:
    """``INCIDENTE`` ou ``SOLICITAÇÃO`` para J; ``None`` sem indício claro e sem índice."""
    if e_solicitante_sistema(solicitante):
        return None
    texto = texto_normalizado(titulo, descricao, atendimento)
    regra = regra_tipo(texto)
    if regra:
        return regra[1]
    if not (indice and _indice_valido(indice)):
        return None
    if ETAPA_FINAL_J == "mapa" and categoria:
        do_mapa = indice["mapa_b_j"].get(_chave_rotulo(categoria))
        if do_mapa:
            return _opcao(TIPOS, do_mapa)
    probabilidades = pontuar(indice["j"], tokens(texto), TIPOS)
    return max(probabilidades.items(), key=lambda par: par[1])[0] if probabilidades else None


# Responsável (A): CLIENTE cuida de usuário, acesso e software; SIMPRESS, de defeito de hardware (periférico e monitor).
RESPONSAVEIS = ("CLIENTE", "SIMPRESS")
CLIENTE, SIMPRESS = RESPONSAVEIS
_A_PESSOAS = re.compile(
    dict(REGRAS_B)["DESLIGAMENTO"].pattern + "|" + dict(REGRAS_B)["NOVO USUÁRIO"].pattern
    + r"|\b(libera\w* (de |do |da )?(usuario|acesso|login|conta)|remoc\w* (de |do |da )?usuario|desbloque\w*)\b"
)
_A_HARDWARE = re.compile(
    r"\b(teclad\w*|mouses?|monitor(es)?|fones?|headsets?|headphones?|webcam\w*|perifer\w*|caixa de som|auricular\w*|"
    r"hardware|carregador\w*)\b"
)
# Notebook ou computador só é SIMPRESS com defeito físico explícito; lentidão e erro de programa ficam com o CLIENTE.
_A_EQUIPAMENTO = re.compile(r"\b(notebooks?|computador\w*|desktops?|bateria\w*|telas?|carcaca|dobradic\w*)\b")
_A_DEFEITO = re.compile(r"\b(quebrad\w*|danificad\w*|defeito\w*|queimad\w*|trincad\w*|avaria\w*|nao liga|tela azul|estufad\w*)\b")
_A_SOFTWARE = re.compile(
    r"\b(instal\w*|reinstal\w*|aplicativ\w*|apps?|softwares?|programas?|edge|chrome|navegador\w*|whats ?app|power ?bi|"
    r"teams|outlook|office|excel|word|e ?mails?|phishing|spam|suspeit\w*|malware|virus|endpoint|pdfs?|acrobat|adobe|"
    r"arquivos?|impressor\w*|impressao|imprimi\w*|senhas?|acessos?|licenc\w*)\b"
)


def sugerir_responsavel(titulo: Any, descricao: Any, atendimento: Any, solicitante: Any, opcoes: Sequence[str] = ()) -> Optional[str]:
    """``CLIENTE`` ou ``SIMPRESS`` para A, na grafia de ``opcoes`` quando ela traz o rótulo; ``None`` sem indício.

    Ordem: entrada, saída ou liberação de usuário é do CLIENTE mesmo com periférico no texto (kit do colaborador);
    depois defeito de hardware (periférico, ou notebook com defeito físico) é da SIMPRESS; por fim software, e-mail, arquivo, acesso e impressora são do CLIENTE.
    """
    if e_solicitante_sistema(solicitante):
        return None
    texto = texto_normalizado(titulo, descricao, atendimento)
    if _A_PESSOAS.search(texto):
        rotulo = CLIENTE
    elif _A_HARDWARE.search(texto) or (_A_EQUIPAMENTO.search(texto) and _A_DEFEITO.search(texto)):
        rotulo = SIMPRESS
    elif _A_SOFTWARE.search(texto):
        rotulo = CLIENTE
    else:
        return None
    return _opcao(opcoes, rotulo) or rotulo
