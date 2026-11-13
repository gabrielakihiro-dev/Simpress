import copy
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from domains import backups_regionais
from domains.backups_regionais import CIDADES_PRIORITARIAS, MINIMO, build_backups_regionais, identificar_marca
from domains.coverage import Manutencao
from domains.effective_alias import build_endpoint_alias_index, unavailable_endpoint_alias_index

AGORA = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
LOGIN = "joao.teste"
ESTADO_OK = object()


def antes(**delta):
    return AGORA - timedelta(**delta)


def notebook(serie, cidade="Cascavel", base="", **extra):
    item = {
        "serial": serie, "tipo": "NOTEBOOK", "modelo": "Latitude 5440", "retirada_cidade": cidade,
        "_apelido_base": base, "apelido": base, "_apelido_manual_override": False,
        "serie_detalhes_duplicada": False,
    }
    item.update(extra)
    return item


def endpoint(*linhas, manual=None, holds=None):
    """Cada linha: (serie, hostname, verificado_em|None, usuario)."""
    registros = [
        {
            "SERIAL": serie, "NOMEDOCOMPUTADOR": hostname, "USUARIOSLOGADOS": usuario,
            "ULTIMAVERIFICACAOCOMEXITO": verificado.isoformat() if verificado else "",
        }
        for serie, hostname, verificado, *resto in linhas
        for usuario in [resto[0] if resto else ""]
    ]
    indice = build_endpoint_alias_index(registros)
    indice["manual_users"] = dict(manual or {})
    indice["user_holds"] = dict(holds or {})
    return indice


def cobertura(**secoes):
    estado = {"disponibilidade": {}, "reservas": {}, "movimentacoes": {}, "devolucoes": {}}
    estado.update(secoes)
    return estado


def calcular(equipamentos, indice=None, confirmacoes=(), estado=ESTADO_OK, manutencao=None, agora=AGORA):
    return build_backups_regionais(
        equipamentos,
        endpoint() if indice is None else indice,
        list(confirmacoes),
        cobertura() if estado is ESTADO_OK else estado,
        Manutencao() if manutencao is None else manutencao,
        agora,
    )


def regional(resultado, nome):
    return next(item for item in resultado["prioritarias"] if item["cidade"] == nome)


def series(itens):
    return [item["serie"] for item in itens]


def todas_as_series(resultado):
    encontradas = []
    for regional_ in resultado["prioritarias"]:
        for lista in ("backups", "candidatos", "conferencia", "excluidos"):
            encontradas += series(regional_[lista])
    for grupo in resultado["outras_candidatos"]:
        encontradas += series(grupo["candidatos"])
    for sobra in resultado["sobras"]:
        encontradas += sobra["series"]
    return encontradas


class IdentificarMarcaTests(unittest.TestCase):
    def test_backup_com_cidade_inteira(self):
        self.assertEqual(identificar_marca("Backup Cascavel 01", "Cascavel"), ("Cascavel", None))
        self.assertEqual(identificar_marca("Backup Londrina 02", "Londrina"), ("Londrina", None))

    def test_backup_com_sigla(self):
        self.assertEqual(identificar_marca("backup-mar", "Maringá"), ("Maringá", None))

    def test_hostname_bk_com_sigla(self):
        self.assertEqual(identificar_marca("PRNOTEBKCAS01", "Cascavel"), ("Cascavel", None))

    def test_hostname_bkp_com_sigla_pg_e_nao_ppg(self):
        self.assertEqual(identificar_marca("PRNOTEBKPPG01", "Ponta Grossa"), ("Ponta Grossa", None))

    def test_hostname_bkp_pab_le_pato_branco(self):
        # BKP+AB01 não é token; BK+PAB01 é: só a segunda leitura vale.
        self.assertEqual(identificar_marca("PRNOTEBKPAB01", "Pato Branco"), ("Pato Branco", None))

    def test_leitura_ambigua_quando_as_duas_leituras_dao_cidades_distintas(self):
        with patch.dict(backups_regionais._TOKEN_CIDADE, {"AB": "Cascavel"}):
            self.assertEqual(identificar_marca("PRNOTEBKPAB01", "Pato Branco"), (None, "leitura_ambigua"))

    def test_caixa_acento_e_separador_nao_importam(self):
        self.assertEqual(identificar_marca("backup maringá", "Maringá"), ("Maringá", None))
        self.assertEqual(identificar_marca("BACKUP_PONTA-GROSSA", "Ponta Grossa"), ("Ponta Grossa", None))
        self.assertEqual(identificar_marca("Backup  Pato   Branco 3", "Pato Branco"), ("Pato Branco", None))
        self.assertEqual(identificar_marca("backup maringá", "MARINGA"), ("Maringá", None))

    def test_nome_sem_marca_devolve_none_none(self):
        for nome in ("PRNOTETI024", "Notebook Cascavel", "", None, "BACKUP 01"):
            with self.subTest(nome=nome):
                self.assertEqual(identificar_marca(nome, "Cascavel"), (None, None))

    def test_comeca_com_nao_vale(self):
        self.assertEqual(identificar_marca("BACKUPCASX", "Cascavel"), (None, None))
        self.assertEqual(identificar_marca("PRNOTEBKCASX01", "Cascavel"), (None, None))

    def test_cidade_divergente_e_ausente(self):
        self.assertEqual(identificar_marca("Backup Londrina 01", "Cascavel"), ("Londrina", "cidade_divergente"))
        self.assertEqual(identificar_marca("Backup Cascavel 01", ""), ("Cascavel", "cidade_ausente"))
        self.assertEqual(identificar_marca("Backup Cascavel 01", None), ("Cascavel", "cidade_ausente"))


class MarcaEContagemTests(unittest.TestCase):
    def test_marca_valida_com_endpoint_recente_conta(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            endpoint(("NB1", "PRNOTE-X", antes(days=1))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual((cascavel["status"], cascavel["contados"], cascavel["excedente"]), ("ok", 1, 0))
        self.assertEqual(cascavel["backups"], [{
            "serie": "NB1", "apelido": "Backup Cascavel 01", "origem": "marca",
            "ultima_verificacao": antes(days=1).isoformat(), "confirmado_ate": None, "confirmacao": None,
        }])

    def test_hostname_unico_do_endpoint_tambem_marca(self):
        resultado = calcular(
            [notebook("NB1", base="PRNOTE-ANTIGO")],
            endpoint(("NB1", "PRNOTEBKCAS01", antes(hours=2))),
        )
        self.assertEqual(series(regional(resultado, "Cascavel")["backups"]), ["NB1"])

    def test_apelido_manual_sem_marca_remove_o_backup(self):
        item = notebook("NB1", base="Backup Cascavel 01", apelido="NOTE-RENOMEADO (M)", _apelido_manual_override=True)
        resultado = calcular(
            [item],
            endpoint(("NB1", "PRNOTEBKCAS01", antes(days=1))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["contados"], 0)
        self.assertEqual([(c["serie"], c["motivo"], c["apelido"]) for c in cascavel["candidatos"]],
                         [("NB1", "encontrado_sem_usuario", "NOTE-RENOMEADO")])

    def test_apelido_manual_com_marca_conta_sem_o_marcador(self):
        item = notebook("NB1", base="OUTRO", apelido="Backup Cascavel 02 (M)", _apelido_manual_override=True)
        resultado = calcular([item], endpoint(("NB1", "PRNOTE-X", antes(days=1))))
        self.assertEqual(
            [(b["serie"], b["apelido"]) for b in regional(resultado, "Cascavel")["backups"]],
            [("NB1", "Backup Cascavel 02")],
        )

    def test_ux_e_hostname_com_cidades_diferentes_vao_para_conferencia(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            endpoint(("NB1", "PRNOTEBKLON01", antes(days=1))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["contados"], 0)
        self.assertEqual([(c["serie"], c["motivo"]) for c in cascavel["conferencia"]], [("NB1", "leitura_ambigua")])

    def test_cidade_divergente_fica_na_cidade_do_cadastro_e_nao_conta(self):
        resultado = calcular(
            [notebook("NB1", cidade="Cascavel", base="Backup Londrina 01")],
            endpoint(("NB1", "X", antes(days=1))),
        )
        self.assertEqual([(c["serie"], c["motivo"]) for c in regional(resultado, "Cascavel")["conferencia"]],
                         [("NB1", "cidade_divergente")])
        self.assertEqual(regional(resultado, "Londrina")["conferencia"], [])
        self.assertEqual(regional(resultado, "Cascavel")["contados"], 0)

    def test_cadastro_sem_cidade_vai_para_conferencia_da_cidade_do_nome(self):
        resultado = calcular(
            [notebook("NB1", cidade="", base="Backup Cascavel 01")],
            endpoint(("NB1", "X", antes(days=1))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual([(c["serie"], c["motivo"]) for c in cascavel["conferencia"]], [("NB1", "cidade_ausente")])
        self.assertEqual(cascavel["contados"], 0)

    def test_seis_dias_e_vinte_e_tres_horas_conta(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            endpoint(("NB1", "X", AGORA - timedelta(days=6, hours=23))),
        )
        self.assertEqual(regional(resultado, "Cascavel")["contados"], 1)

    def test_sete_dias_vira_candidato_sem_verificacao(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            endpoint(("NB1", "X", antes(days=7))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["contados"], 0)
        self.assertEqual(cascavel["candidatos"], [{
            "serie": "NB1", "apelido": "Backup Cascavel 01", "motivo": "sem_verificacao_7_dias",
            "ultima_verificacao": antes(days=7).isoformat(), "dias_sem_verificacao": 7, "confirmacao": None,
        }])
        self.assertEqual(cascavel["status"], "conferir")

    def test_presente_sem_data_e_sem_verificacao(self):
        resultado = calcular([notebook("NB1")], endpoint(("NB1", "X", None)))
        candidato = regional(resultado, "Cascavel")["candidatos"][0]
        self.assertEqual(
            (candidato["motivo"], candidato["ultima_verificacao"], candidato["dias_sem_verificacao"]),
            ("sem_verificacao_7_dias", None, None),
        )

    def test_hostname_vazio_no_endpoint_conta_como_presente(self):
        resultado = calcular([notebook("NB1")], endpoint(("NB1", "", antes(days=1))))
        self.assertEqual(regional(resultado, "Cascavel")["candidatos"][0]["motivo"], "encontrado_sem_usuario")

    def test_usuario_vazio_e_encontrado_e_serie_ausente_e_ausente(self):
        resultado = calcular(
            [notebook("NB1"), notebook("NB2")],
            endpoint(("NB1", "X", antes(days=1), "")),
        )
        motivos = {c["serie"]: c["motivo"] for c in regional(resultado, "Cascavel")["candidatos"]}
        self.assertEqual(motivos, {"NB1": "encontrado_sem_usuario", "NB2": "ausente_no_endpoint"})

    def test_duplicidade_nos_detalhes_com_ou_sem_marca_vai_para_conferencia(self):
        resultado = calcular(
            [
                notebook("NB1", base="Backup Cascavel 01", serie_detalhes_duplicada=True),
                notebook("NB2", serie_detalhes_duplicada=True),
            ],
            endpoint(("NB1", "X", antes(days=1)), ("NB2", "Y", antes(days=1))),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual([(c["serie"], c["motivo"]) for c in cascavel["conferencia"]],
                         [("NB1", "serie_duplicada"), ("NB2", "serie_duplicada")])
        self.assertEqual((cascavel["contados"], cascavel["candidatos"]), (0, []))

    def test_duplicidade_no_endpoint_vai_para_conferencia(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01"), notebook("NB2")],
            endpoint(
                ("NB1", "PRNOTEBKCAS01", antes(days=1)), ("NB1", "PRNOTEBKCAS02", antes(days=2)),
                ("NB2", "A", antes(days=1)), ("NB2", "B", antes(days=1)),
            ),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual([(c["serie"], c["motivo"]) for c in cascavel["conferencia"]],
                         [("NB1", "serie_duplicada"), ("NB2", "serie_duplicada")])
        self.assertEqual(cascavel["contados"], 0)

    def test_macbook_sebrae_e_outros_equipamentos_ficam_fora(self):
        resultado = calcular(
            [
                notebook("NB1", base="Backup Cascavel 01"),
                notebook("MAC1", base="Backup Cascavel 02", tipo="MacBook", modelo="MacBook Air"),
                notebook("BRJ135P5XS", base="Backup Cascavel 03"),
                notebook("MON1", base="Backup Cascavel 04", tipo="Monitor", modelo="Dell P2422H"),
            ],
            endpoint(*[(s, "X", antes(days=1)) for s in ("NB1", "MAC1", "BRJ135P5XS", "MON1")]),
        )
        self.assertEqual(todas_as_series(resultado), ["NB1"])
        self.assertEqual(series(regional(resultado, "Cascavel")["backups"]), ["NB1"])


class BloqueioETUsuarioTests(unittest.TestCase):
    def excluido_por(self, **kwargs):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            kwargs.pop("indice", endpoint(("NB1", "X", antes(days=1)))),
            **kwargs,
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["contados"], 0)
        return [(e["serie"], e["motivo"]) for e in cascavel["excluidos"]]

    def test_bloqueios_da_cobertura_excluem(self):
        casos = {
            "bloqueio:reserva_ativa": cobertura(
                reservas={"R1": {"id": "R1", "serie": "NB1", "estado": "ativa", "valida_ate": "2026-11-20"}}),
            "bloqueio:movimentacao_aberta": cobertura(
                movimentacoes={"M1": {"id": "M1", "serie": "NB1", "estado": "preparada"}}),
            "bloqueio:devolucao_pendente": cobertura(
                devolucoes={"D1": {"id": "D1", "serie": "NB1", "estado": "prevista", "data_prevista": "2026-11-20"}}),
            "bloqueio:em_manutencao": cobertura(disponibilidade={"NB1": {"estado": "em_manutencao"}}),
            "bloqueio:indisponivel": cobertura(disponibilidade={"NB1": {"estado": "indisponivel"}}),
        }
        for motivo, estado in casos.items():
            with self.subTest(motivo=motivo):
                self.assertEqual(self.excluido_por(estado=estado), [("NB1", motivo)])

    def test_manutencao_listada_exclui(self):
        self.assertEqual(
            self.excluido_por(manutencao=Manutencao(series=frozenset({"NB1"}))),
            [("NB1", "bloqueio:manutencao")],
        )

    def test_sem_disponibilidade_sem_registro_ou_a_confirmar_nao_bloqueia(self):
        for estado in (cobertura(), cobertura(disponibilidade={"NB1": {"estado": "a_confirmar"}})):
            with self.subTest(estado=estado):
                resultado = calcular(
                    [notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", antes(days=1))), estado=estado,
                )
                self.assertEqual(regional(resultado, "Cascavel")["contados"], 1)

    def test_cobertura_ilegivel_nao_bloqueia_mas_manutencao_listada_ainda_bloqueia(self):
        livre = calcular(
            [notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", antes(days=1))), estado=None,
        )
        self.assertEqual(regional(livre, "Cascavel")["contados"], 1)
        self.assertEqual(livre["fontes"]["cobertura"], "ilegivel")
        self.assertIn("Cobertura ilegível: reservas e movimentações não conferidas.", livre["limitacoes"])
        self.assertEqual(
            self.excluido_por(estado=None, manutencao=Manutencao(series=frozenset({"NB1"}))),
            [("NB1", "bloqueio:manutencao")],
        )

    def test_usuario_manual_exclui(self):
        self.assertEqual(
            self.excluido_por(indice=endpoint(("NB1", "X", antes(days=1)), manual={"NB1": LOGIN})),
            [("NB1", "usuario_vigente")],
        )

    def test_trava_de_usuario_ativa_exclui_e_inativa_nao(self):
        ativa = {"NB1": {"tipo": "usuario_ausente", "estado": "pendente", "usuario_atual": LOGIN}}
        self.assertEqual(
            self.excluido_por(indice=endpoint(("NB1", "X", antes(days=1)), holds=ativa)),
            [("NB1", "usuario_vigente")],
        )
        inativa = {"NB1": {"tipo": "usuario_ausente", "estado": "removida", "usuario_atual": LOGIN}}
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", antes(days=1)), holds=inativa),
        )
        self.assertEqual(regional(resultado, "Cascavel")["contados"], 1)

    def test_usuario_do_endpoint_com_verificacao_recente_exclui(self):
        self.assertEqual(
            self.excluido_por(indice=endpoint(("NB1", "X", antes(days=1), LOGIN))),
            [("NB1", "usuario_vigente")],
        )

    def test_usuario_de_verificacao_antiga_nao_exclui(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", antes(days=7), LOGIN)),
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["excluidos"], [])
        self.assertEqual([c["motivo"] for c in cascavel["candidatos"]], ["sem_verificacao_7_dias"])


class ConfirmacaoTests(unittest.TestCase):
    def confirmacao(self, serie="NB1", cidade="Cascavel", expira_em=None):
        return {
            "serie": serie, "cidade": cidade, "confirmado_em": antes(days=1).isoformat(),
            "expira_em": (expira_em or AGORA + timedelta(days=3)).isoformat(),
        }

    def test_confirmacao_vigente_conta_e_mostra_o_estado(self):
        expira = AGORA + timedelta(days=3)
        resultado = calcular([notebook("NB1")], endpoint(), [self.confirmacao(expira_em=expira)])
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["backups"], [{
            "serie": "NB1", "apelido": "", "origem": "confirmacao", "ultima_verificacao": None,
            "confirmado_ate": expira.isoformat(),
            "confirmacao": {"estado": "vigente", "expira_em": expira.isoformat()},
        }])
        self.assertEqual((cascavel["status"], cascavel["candidatos"]), ("ok", []))

    def test_confirmacao_vigente_vale_com_endpoint_indisponivel(self):
        resultado = calcular(
            [notebook("NB1")], unavailable_endpoint_alias_index(), [self.confirmacao()],
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual([(b["serie"], b["origem"]) for b in cascavel["backups"]], [("NB1", "confirmacao")])
        self.assertEqual(resultado["fontes"]["endpoint"], "indisponivel")

    def test_confirmacao_expirada_aparece_invalidada_no_candidato(self):
        for expira in (antes(seconds=1), AGORA):  # agora < expira_em é obrigatório
            with self.subTest(expira=expira):
                resultado = calcular([notebook("NB1")], endpoint(), [self.confirmacao(expira_em=expira)])
                cascavel = regional(resultado, "Cascavel")
                self.assertEqual(cascavel["contados"], 0)
                self.assertEqual(
                    cascavel["candidatos"][0]["confirmacao"], {"estado": "invalidada", "motivo": "expirada"},
                )

    def test_cidade_mudou_aparece_na_cidade_atual_do_cadastro(self):
        resultado = calcular(
            [notebook("NB1", cidade="Londrina")], endpoint(), [self.confirmacao(cidade="Cascavel")],
        )
        londrina = regional(resultado, "Londrina")
        self.assertEqual(londrina["contados"], 0)
        self.assertEqual(
            [(c["serie"], c["confirmacao"]) for c in londrina["candidatos"]],
            [("NB1", {"estado": "invalidada", "motivo": "cidade_mudou"})],
        )
        self.assertEqual(todas_as_series(resultado), ["NB1"])  # nunca na cidade antiga

    def test_usuario_vigente_invalida_a_confirmacao_no_excluido(self):
        resultado = calcular(
            [notebook("NB1")], endpoint(manual={"NB1": LOGIN}), [self.confirmacao()],
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["excluidos"], [{
            "serie": "NB1", "motivo": "usuario_vigente",
            "confirmacao": {"estado": "invalidada", "motivo": "usuario_vigente"},
        }])
        self.assertEqual(cascavel["contados"], 0)

    def test_bloqueio_invalida_a_confirmacao_no_excluido(self):
        estado = cobertura(reservas={"R1": {"id": "R1", "serie": "NB1", "estado": "ativa", "valida_ate": "2026-11-20"}})
        resultado = calcular([notebook("NB1")], endpoint(), [self.confirmacao()], estado=estado)
        self.assertEqual(regional(resultado, "Cascavel")["excluidos"], [{
            "serie": "NB1", "motivo": "bloqueio:reserva_ativa",
            "confirmacao": {"estado": "invalidada", "motivo": "bloqueio"},
        }])

    def test_confirmacao_de_serie_fora_do_escopo_ou_do_cadastro_e_ignorada(self):
        resultado = calcular(
            [notebook("MAC1", tipo="MacBook", modelo="MacBook Pro"), notebook("BRJ135P5XS")],
            endpoint(),
            [self.confirmacao("MAC1"), self.confirmacao("BRJ135P5XS"), self.confirmacao("DESCONHECIDA")],
        )
        self.assertEqual(todas_as_series(resultado), [])

    def test_confirmacao_em_serie_duplicada_nao_conta(self):
        resultado = calcular(
            [notebook("NB1", serie_detalhes_duplicada=True)], endpoint(), [self.confirmacao()],
        )
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual((cascavel["contados"], series(cascavel["conferencia"])), (0, ["NB1"]))

    def test_iso_sem_fuso_e_lido_no_fuso_de_agora_e_a_entrada_nao_muda(self):
        fuso = timezone(timedelta(hours=-3))
        agora = datetime(2026, 11, 12, 12, 0, tzinfo=fuso)
        entrada = [{"serie": "NB1", "cidade": "Cascavel", "confirmado_em": "2026-11-12T09:00:00",
                    "expira_em": "2026-11-15T12:00:00"}]
        copia = copy.deepcopy(entrada)
        resultado = calcular([notebook("NB1")], endpoint(), entrada, agora=agora)
        self.assertEqual(regional(resultado, "Cascavel")["backups"][0]["confirmado_ate"], "2026-11-15T12:00:00-03:00")
        self.assertEqual(entrada, copia)


class StatusESobrasTests(unittest.TestCase):
    def test_status_ok_conferir_sem_backup_e_dados_insuficientes(self):
        equipamentos = [
            notebook("OK1", cidade="Cascavel", base="Backup Cascavel 01"),
            notebook("CF1", cidade="Londrina"),  # sem marca, recente, sem usuário: candidato
            notebook("US1", cidade="Pato Branco"),  # em uso: excluído, sem candidato
        ]
        indice = endpoint(
            ("OK1", "X", antes(days=1)), ("CF1", "Y", antes(days=1)), ("US1", "Z", antes(days=1), LOGIN),
        )
        resultado = calcular(equipamentos, indice)
        status = {r["cidade"]: r["status"] for r in resultado["prioritarias"]}
        self.assertEqual(status, {
            "Cascavel": "ok", "Londrina": "conferir", "Pato Branco": "sem_backup",
            "Maringá": "sem_backup", "Ponta Grossa": "sem_backup",
        })
        self.assertEqual(resultado["pendencias"], {
            "sem_backup": ["Pato Branco", "Maringá", "Ponta Grossa"], "conferir": ["Londrina"],
        })
        self.assertEqual(resultado["limitacoes"], [])

    def test_dados_insuficientes_por_cada_fonte_ruim(self):
        # Só uma regional não prioritária no cadastro: nenhuma prioritária tem contado nem candidato.
        base = [notebook("T1", cidade="Toledo")]
        indice = endpoint(("T1", "Z", antes(days=1)))
        controle = calcular(base, indice)
        self.assertEqual({r["status"] for r in controle["prioritarias"]}, {"sem_backup"})
        casos = {
            "base_nao_importada": dict(equipamentos=None),
            "base_vazia": dict(equipamentos=[]),
            "endpoint_indisponivel": dict(indice=unavailable_endpoint_alias_index()),
            "cobertura_ilegivel": dict(estado=None),
            "manutencao_ilegivel": dict(manutencao=Manutencao(ilegivel=True)),
        }
        for nome, extra in casos.items():
            with self.subTest(nome):
                argumentos = {"equipamentos": base, "indice": indice, **extra}
                resultado = calcular(argumentos.pop("equipamentos"), argumentos.pop("indice"), **argumentos)
                self.assertEqual({r["status"] for r in resultado["prioritarias"]}, {"dados_insuficientes"})
                self.assertEqual(resultado["pendencias"], {"sem_backup": [], "conferir": []})
                self.assertEqual(len(resultado["limitacoes"]), 1)

    def test_fontes_e_limitacoes(self):
        resultado = calcular(None, unavailable_endpoint_alias_index(), estado=None, manutencao=Manutencao(ilegivel=True))
        self.assertEqual(resultado["fontes"], {
            "cadastro": False, "endpoint": "indisponivel", "cobertura": "ilegivel", "manutencao_verificada": False,
        })
        self.assertEqual(resultado["limitacoes"], [
            "Base de equipamentos não importada: dados insuficientes.",
            "Endpoint indisponível: uso recente não conferido.",
            "Cobertura ilegível: reservas e movimentações não conferidas.",
            "Manutenção não verificada: dados insuficientes.",
        ])

    def test_manutencao_ilegivel_nao_bloqueia(self):
        resultado = calcular(
            [notebook("NB1", base="Backup Cascavel 01")],
            endpoint(("NB1", "X", antes(days=1))),
            manutencao=Manutencao(series=frozenset({"NB1"}), ilegivel=True),
        )
        self.assertEqual(regional(resultado, "Cascavel")["contados"], 1)
        self.assertFalse(resultado["fontes"]["manutencao_verificada"])

    def test_endpoint_indisponivel_gera_candidatos_com_motivo_proprio(self):
        resultado = calcular([notebook("NB1", base="Backup Cascavel 01")], unavailable_endpoint_alias_index())
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual([c["motivo"] for c in cascavel["candidatos"]], ["fonte_endpoint_indisponivel"])
        self.assertEqual(cascavel["status"], "conferir")

    def test_sobras_da_prioritaria_com_excedente_e_das_demais_regionais(self):
        equipamentos = [
            notebook("C1", base="Backup Cascavel 01"),
            notebook("C2"),  # backup só por confirmação
            notebook("C3", base="Backup Cascavel 03"),
            notebook("L1", cidade="Londrina", base="Backup Londrina 01"),  # prioritária no mínimo: sem sobra
            notebook("T1", cidade="Toledo", base="Backup TOL 01"),
            notebook("T2", cidade="Toledo", base="Backup Toledo 02"),
            notebook("T3", cidade="Toledo"),  # candidato de regional não prioritária
            notebook("T4", cidade="Toledo", base="Backup Cascavel 09"),  # conferência da outra regional: não aparece
            notebook("U1", cidade="Umuarama"),  # só candidato
        ]
        indice = endpoint(*[
            (s, "X", antes(days=1)) for s in ("C1", "C3", "L1", "T1", "T2", "T3", "T4", "U1")
        ])
        confirmacao = {"serie": "C2", "cidade": "Cascavel", "confirmado_em": AGORA.isoformat(),
                       "expira_em": (AGORA + timedelta(days=2)).isoformat()}
        resultado = calcular(equipamentos, indice, [confirmacao])
        cascavel = regional(resultado, "Cascavel")
        self.assertEqual(cascavel["contados"], 3)
        self.assertEqual(cascavel["excedente"], 2)
        self.assertEqual([(b["serie"], b["origem"]) for b in cascavel["backups"]],
                         [("C1", "marca"), ("C3", "marca"), ("C2", "confirmacao")])
        ate_c2 = (AGORA + timedelta(days=2)).isoformat()
        self.assertEqual(resultado["sobras"], [
            {"cidade": "Cascavel", "quantidade": 2, "series": ["C3", "C2"], "prioritaria": True, "itens": [
                {"serie": "C3", "origem": "marca", "confirmado_ate": None},
                {"serie": "C2", "origem": "confirmacao", "confirmado_ate": ate_c2},
            ]},
            {"cidade": "Toledo", "quantidade": 2, "series": ["T1", "T2"], "prioritaria": False, "itens": [
                {"serie": "T1", "origem": "marca", "confirmado_ate": None},
                {"serie": "T2", "origem": "marca", "confirmado_ate": None},
            ]},
        ])
        self.assertEqual(
            [(g["cidade"], series(g["candidatos"])) for g in resultado["outras_candidatos"]],
            [("Toledo", ["T3"]), ("Umuarama", ["U1"])],
        )
        self.assertNotIn("T4", todas_as_series(resultado))
        self.assertEqual(MINIMO, 1)


class SaidaETests(unittest.TestCase):
    def test_formato_da_saida(self):
        resultado = calcular([notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", antes(days=1))))
        self.assertEqual(
            list(resultado),
            ["gerado_em", "minimo", "fontes", "limitacoes", "prioritarias", "sobras", "outras_candidatos", "pendencias"],
        )
        self.assertEqual(resultado["gerado_em"], AGORA.isoformat())
        self.assertEqual([r["cidade"] for r in resultado["prioritarias"]], list(CIDADES_PRIORITARIAS))
        self.assertEqual(
            list(resultado["prioritarias"][0]),
            ["cidade", "status", "contados", "minimo", "excedente", "backups", "candidatos", "conferencia", "excluidos"],
        )

    def test_login_nunca_aparece_na_saida(self):
        indice = endpoint(
            ("NB1", "X", antes(days=1), LOGIN),
            ("NB2", "Y", antes(days=8), LOGIN),
            ("NB3", "Z", antes(days=1)),
            manual={"NB3": LOGIN},
            holds={"NB4": {"tipo": "substituicao_manual", "estado": "pendente", "usuario_atual": LOGIN}},
        )
        resultado = calcular([notebook(s) for s in ("NB1", "NB2", "NB3", "NB4")], indice)
        self.assertEqual(len(regional(resultado, "Cascavel")["excluidos"]), 3)
        self.assertNotIn("joao", json.dumps(resultado, ensure_ascii=False))

    def test_agora_sem_fuso_levanta_value_error(self):
        with self.assertRaises(ValueError):
            calcular([notebook("NB1")], agora=datetime(2026, 11, 12, 12, 0))


class CorrecoesDaRevisaoTests(unittest.TestCase):
    def test_data_do_endpoint_sem_fuso_e_lida_no_fuso_de_agora(self):
        fuso = timezone(timedelta(hours=-3))
        agora = datetime(2026, 11, 12, 12, 0, tzinfo=fuso)
        casos = {datetime(2026, 11, 5, 13, 0): "backups", datetime(2026, 11, 5, 12, 0): "candidatos"}
        for verificado, lista in casos.items():
            with self.subTest(verificado=verificado):
                resultado = calcular(
                    [notebook("NB1", base="Backup Cascavel 01")], endpoint(("NB1", "X", verificado)), agora=agora,
                )
                self.assertEqual(series(regional(resultado, "Cascavel")[lista]), ["NB1"])

    def test_confirmacao_de_outra_cidade_com_validade_maior_nao_esconde_a_vigente(self):
        expira = AGORA + timedelta(days=3)
        confirmacoes = [
            {"serie": "NB1", "cidade": "Londrina", "confirmado_em": antes(days=1).isoformat(),
             "expira_em": (AGORA + timedelta(days=30)).isoformat()},
            {"serie": "NB1", "cidade": "Cascavel", "confirmado_em": antes(days=1).isoformat(),
             "expira_em": expira.isoformat()},
        ]
        backups = regional(calcular([notebook("NB1")], endpoint(), confirmacoes), "Cascavel")["backups"]
        self.assertEqual([(b["serie"], b["confirmado_ate"]) for b in backups], [("NB1", expira.isoformat())])

    def test_serie_com_separador_bate_com_disponibilidade_por_chave_serie(self):
        resultado = calcular(
            [notebook("NB-1", base="Backup Cascavel 01")],
            endpoint(("NB-1", "X", antes(days=1))),
            estado=cobertura(disponibilidade={"NB1": {"estado": "em_manutencao"}}),
        )
        excluidos = regional(resultado, "Cascavel")["excluidos"]
        self.assertEqual([(e["serie"], e["motivo"]) for e in excluidos], [("NB-1", "bloqueio:em_manutencao")])


if __name__ == "__main__":
    unittest.main()
