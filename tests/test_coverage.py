"""Cobertura de Equipamentos: regras puras (domains/coverage.py) e gravação (domains/coverage_store.py).

Só dados sintéticos (SINT-001 ...), pastas temporárias e uma data fixa.
"""

import hashlib
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from domains import coverage as cov
from domains.coverage import CoberturaErro, Contexto, Manutencao
from domains.coverage_store import CoberturaStore, EstadoIlegivel, manutencao_de, manutencao_dos_chamados

HOJE = date(2026, 11, 6)
AGORA = "2026-11-06T09:00:00-03:00"


def ctx(hoje=HOJE, manutencao=Manutencao(), cadastro=None):
    return Contexto(hoje=hoje, agora=AGORA, manutencao=manutencao, cadastro=cadastro or {})


def aplicar(estado, funcao, *args, contexto=None, **kwargs):
    novo, registro = funcao(estado, contexto or ctx(), *args, **kwargs)
    return novo, registro


def cenario_v1_v4():
    """Quatro vagas na Cidade A para 20/11; SINT-001 e SINT-002 disponíveis; SINT-003 volta em 15/11."""
    estado = cov.estado_vazio()
    estado, demanda = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Cidade A", quantidade=4)
    for serie in ("SINT-001", "SINT-002"):
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie=serie, situacao="disponivel", cidade="Cidade A")
    estado, devolucao = aplicar(estado, cov.registrar_devolucao, serie="SINT-003", data_prevista="2026-11-15", cidade="Cidade A")
    return estado, demanda, devolucao


def situacoes(resultado):
    return [(v["situacao"], v["serie"]) for v in resultado["vagas"]]


def kit_completo(estado, reserva):
    for item in list(reserva["kit"]):
        estado, reserva = aplicar(estado, cov.marcar_kit, reserva["id"], reserva["rev"], item, True)
    return estado, reserva


def ate_em_transito(estado, mov):
    mov = dict(mov)
    estado["movimentacoes"][mov["id"]]["estado"] = "gerada"  # passo do bloco 2 (registrar-transferencia)
    for proximo in ("coletada", "em_transito"):
        estado, mov = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], estado["movimentacoes"][mov["id"]]["rev"], proximo)
    return estado, mov


class CoberturaCalculoTests(unittest.TestCase):
    def test_cenario_v1_v4_antes_e_depois_de_reservar(self):
        estado, demanda, _ = cenario_v1_v4()
        antes = cov.build_coverage(estado, HOJE)
        self.assertEqual(situacoes(antes), [
            ("atendivel", "SINT-001"), ("atendivel", "SINT-002"), ("condicionada", "SINT-003"), ("sem_cobertura", None),
        ])
        self.assertEqual([s["serie"] for s in antes["disponiveis"]], ["SINT-001", "SINT-002"])
        self.assertEqual(antes["contagens"], {"atendivel": 2, "condicionada": 1, "sem_cobertura": 1, "entregue": 0})

        estado, r1 = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        estado, r2 = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="sint 002")
        depois = cov.build_coverage(estado, HOJE)
        self.assertEqual(situacoes(depois), situacoes(antes))
        self.assertEqual([v["reserva_id"] for v in depois["vagas"][:2]], [r1["id"], r2["id"]])
        self.assertEqual(depois["disponiveis"], [])

        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        self.assertEqual((erro.exception.codigo, erro.exception.status, erro.exception.extra["motivo"]),
                         ("conflito_reserva", 409, "reserva_ativa"))
        self.assertEqual(erro.exception.extra["bloqueio_id"], r1["id"])

    def test_uma_serie_cobre_so_a_primeira_de_duas_vagas(self):
        estado = cov.estado_vazio()
        estado, primeira = aplicar(estado, cov.registrar_demanda, data="2026-11-12", cidade="Cidade A", quantidade=1)
        estado, segunda = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Cidade A", quantidade=1)
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel", cidade="Cidade A")
        vagas = {v["demanda_id"]: v for v in cov.build_coverage(estado, HOJE)["vagas"]}
        self.assertEqual(vagas[primeira["id"]]["situacao"], "atendivel")
        self.assertEqual(vagas[segunda["id"]]["situacao"], "sem_cobertura")

    def test_outra_cidade_e_transferencia_e_cidade_ignora_acento_e_caixa(self):
        estado = cov.estado_vazio()
        estado, _ = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Maringá", quantidade=2)
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel", cidade="MARINGA")
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-002", situacao="disponivel", cidade="Londrina")
        vagas = cov.build_coverage(estado, HOJE)["vagas"]
        self.assertEqual((vagas[0]["serie"], vagas[0]["selos"]), ("SINT-001", []))
        self.assertEqual((vagas[1]["serie"], vagas[1]["selos"]), ("SINT-002", ["Transferência"]))

    def test_devolucao_sem_prazo_de_preparo_nao_cobre(self):
        estado = cov.estado_vazio()
        estado, _ = aplicar(estado, cov.registrar_demanda, data="2026-11-16", cidade="Cidade A", quantidade=1)
        estado, _ = aplicar(estado, cov.registrar_devolucao, serie="SINT-003", data_prevista="2026-11-15", cidade="Cidade A")
        self.assertEqual(cov.build_coverage(estado, HOJE)["vagas"][0]["situacao"], "sem_cobertura")

    def test_disponibilidade_vencida_volta_a_confirmar(self):
        estado, _, _ = cenario_v1_v4()
        depois = HOJE + timedelta(days=8)
        resultado = cov.build_coverage(estado, depois)
        self.assertEqual(resultado["disponiveis"], [])
        self.assertEqual(cov.disponibilidade_efetiva(estado["disponibilidade"]["SINT001"], depois), "a_confirmar")

    def test_prazo_perdido(self):
        estado = cov.estado_vazio()
        estado, _ = aplicar(estado, cov.registrar_demanda, data="2026-11-01", cidade="Cidade A", quantidade=1)
        self.assertIn("Prazo perdido", cov.build_coverage(estado, HOJE)["vagas"][0]["selos"])


class CoberturaRegrasTests(unittest.TestCase):
    def test_reserva_vencida_continua_bloqueando_e_renovar_revalida(self):
        estado, demanda, _ = cenario_v1_v4()
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        depois = HOJE + timedelta(days=8)
        bloqueio = cov.motivo_bloqueio(estado, "SINT-001", depois, Manutencao())
        self.assertEqual(bloqueio, {"motivo": "reserva_vencida_em_revisao", "id": reserva["id"]})
        resultado = cov.build_coverage(estado, depois)
        self.assertEqual(resultado["reservas_vencidas"], [reserva["id"]])
        self.assertIn("Reserva vencida", resultado["vagas"][0]["selos"])
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001", contexto=ctx(hoje=depois))
        self.assertEqual(erro.exception.extra["motivo"], "reserva_vencida_em_revisao")

        # A disponibilidade também venceu: renovar pede nova confirmação (422).
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.renovar_reserva, reserva["id"], reserva["rev"], contexto=ctx(hoje=depois))
        self.assertEqual((erro.exception.status, erro.exception.extra["motivo"]), (422, "sem_disponibilidade"))

        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel",
                            rev=estado["disponibilidade"]["SINT001"]["rev"], contexto=ctx(hoje=depois))
        estado, renovada = aplicar(estado, cov.renovar_reserva, reserva["id"], reserva["rev"], contexto=ctx(hoje=depois))
        self.assertEqual(renovada["valida_ate"], (depois + timedelta(days=7)).isoformat())
        self.assertIsNone(cov.motivo_bloqueio(estado, "SINT-001", depois, Manutencao(), ignorar_reserva=reserva["id"]))

    def test_rev_antigo_devolve_registro_alterado(self):
        estado, demanda, _ = cenario_v1_v4()
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        estado, _ = aplicar(estado, cov.marcar_kit, reserva["id"], reserva["rev"], "notebook", True)
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.cancelar_reserva, reserva["id"], reserva["rev"])
        self.assertEqual((erro.exception.codigo, erro.exception.status), ("registro_alterado", 409))

    def test_devolucao_atrasada_e_cancelar_devolucao_cancela_reserva_em_espera(self):
        estado, demanda, devolucao = cenario_v1_v4()
        estado, espera = aplicar(estado, cov.reservar, demanda_id=demanda["id"], devolucao_id=devolucao["id"])
        self.assertEqual((espera["estado"], espera["serie"]), ("em_espera", "SINT-003"))
        atrasado = date(2026, 11, 18)
        vaga = next(v for v in cov.build_coverage(estado, atrasado)["vagas"] if v["reserva_id"] == espera["id"])
        self.assertEqual((vaga["situacao"], vaga["motivo"]), ("condicionada", "Devolução atrasada há 3 dias"))
        self.assertEqual(cov.situacao_devolucao(estado["devolucoes"][devolucao["id"]], atrasado), "atrasada")

        estado, _ = aplicar(estado, cov.cancelar_devolucao, devolucao["id"], devolucao["rev"])
        self.assertEqual(estado["reservas"][espera["id"]]["estado"], "cancelada")
        self.assertEqual(cov.build_coverage(estado, HOJE)["contagens"]["condicionada"], 0)

    def test_devolucao_recebida_e_confirmada_ativa_reserva_em_espera(self):
        estado, demanda, devolucao = cenario_v1_v4()
        estado, espera = aplicar(estado, cov.reservar, demanda_id=demanda["id"], devolucao_id=devolucao["id"])
        estado, _ = aplicar(estado, cov.receber_devolucao, devolucao["id"], devolucao["rev"])
        self.assertEqual(estado["disponibilidade"]["SINT003"]["estado"], "a_confirmar")
        self.assertEqual(estado["reservas"][espera["id"]]["estado"], "em_espera")
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-003", situacao="disponivel",
                            rev=estado["disponibilidade"]["SINT003"]["rev"])
        reserva = estado["reservas"][espera["id"]]
        self.assertEqual((reserva["estado"], reserva["valida_ate"]), ("ativa", "2026-11-13"))

    def test_manutencao_devolve_422_e_ilegivel_exige_conferencia(self):
        estado, demanda, _ = cenario_v1_v4()
        em_manutencao = ctx(manutencao=Manutencao(series=frozenset({"SINT001"})))
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001", contexto=em_manutencao)
        self.assertEqual((erro.exception.codigo, erro.exception.status, erro.exception.extra["motivo"]),
                         ("serie_indisponivel", 422, "manutencao"))

        ilegivel = ctx(manutencao=Manutencao(ilegivel=True))
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001", contexto=ilegivel)
        self.assertEqual(erro.exception.extra["motivo"], "manutencao_nao_verificada")
        _, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001",
                             manutencao_conferida=True, contexto=ilegivel)
        self.assertTrue(reserva["manutencao_conferida"])
        resultado = cov.build_coverage(estado, HOJE, Manutencao(ilegivel=True))
        self.assertEqual(resultado["manutencao"], {"verificada": False, "aviso": "Manutenção não verificada"})

    def test_chamado_ambiguo_nao_bloqueia_e_vinculo_unico_bloqueia(self):
        relatorio = {"chamados": [
            {"serie": "SINT-001", "oracle": [{"ordem_servico": "OS-1", "status": "Concluído"}], "simpress": {}},
            {"serie": "SINT-004", "oracle": [{"ordem_servico": "OS-9", "status": "Aberto"}], "simpress": {}},
            {"serie": "SINT-005", "oracle": [], "simpress": {"ordens_servico": ["OS-2", "OS-3"]}},
            {"serie": "SINT-006", "oracle": [], "simpress": {"ordens_servico": ["OS-7"]}},
        ]}
        abertos = [
            {"numero": "UTIC-2026-10", "automaticos": {"K": "SINT-005"}},  # duas OS: ambíguo
            {"numero": "UTIC-2026-11", "automaticos": {"K": "SINT-006"}},  # uma OS: vínculo único
        ]
        manutencao = manutencao_de(relatorio, abertos)
        self.assertEqual(manutencao.series, frozenset({"SINT004", "SINT006"}))
        self.assertEqual(manutencao.sinais, frozenset({"SINT005"}))

        estado = cov.estado_vazio()
        estado, demanda = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Cidade A", quantidade=1)
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-005", situacao="disponivel", cidade="Cidade A")
        resultado = cov.build_coverage(estado, HOJE, manutencao)
        self.assertEqual(resultado["vagas"][0]["serie"], "SINT-005")
        self.assertEqual(resultado["disponiveis"][0]["sinal"], "Chamado possivelmente relacionado")
        aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-005", contexto=ctx(manutencao=manutencao))

    def test_fonte_de_manutencao_ilegivel(self):
        with tempfile.TemporaryDirectory() as pasta:
            relatorio = Path(pasta) / "historico_chamados.json"
            relatorio.write_text("{quebrado", encoding="utf-8")
            self.assertTrue(manutencao_dos_chamados(relatorio, Path(pasta) / "ausente.json").ilegivel)
            relatorio.write_text(json.dumps({"chamados": []}), encoding="utf-8")
            self.assertFalse(manutencao_dos_chamados(relatorio, Path(pasta) / "ausente.json").ilegivel)

    def test_serie_do_sebrae_fica_fora(self):
        estado = cov.estado_vazio()
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.registrar_disponibilidade, serie="brt100xa01", situacao="disponivel", cidade="Cidade A")
        self.assertEqual(erro.exception.extra["motivo"], "fora_do_inventario")
        estado["disponibilidade"]["BRT100XA01"] = {
            "id": "BRT100XA01", "serie": "BRT100XA01", "estado": "disponivel", "cidade": "Cidade A",
            "valida_ate": "2026-11-13", "rev": 1,
        }
        estado, demanda = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Cidade A", quantidade=1)
        resultado = cov.build_coverage(estado, HOJE)
        self.assertEqual(resultado["disponiveis"], [])
        self.assertEqual(resultado["vagas"][0]["situacao"], "sem_cobertura")
        with self.assertRaises(CoberturaErro):
            aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="BRT100XA01")

    def test_prnotesjp_conta_como_curitiba(self):
        cadastro = cov.indexar_cadastro([
            {"serial": "SINT-007", "apelido": "prnotesjp0042", "retirada_cidade": "São José dos Pinhais"},
            {"serial": "SINT-008", "apelido": "PRNOTE0001", "retirada_cidade": "Londrina"},
        ])
        estado = cov.estado_vazio()
        estado, registro = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-007", situacao="disponivel",
                                   contexto=ctx(cadastro=cadastro))
        self.assertEqual(registro["cidade"], "Curitiba")
        estado, registro = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-008", situacao="disponivel",
                                   contexto=ctx(cadastro=cadastro))
        self.assertEqual(registro["cidade"], "Londrina")
        estado, _ = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="CURITIBA", quantidade=1)
        vaga = cov.build_coverage(estado, HOJE)["vagas"][0]
        self.assertEqual((vaga["serie"], vaga["selos"]), ("SINT-007", []))


class CoberturaMovimentacaoTests(unittest.TestCase):
    def preparar(self):
        estado, demanda, _ = cenario_v1_v4()
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"])
        self.assertEqual(erro.exception.codigo, "kit_incompleto")
        estado, reserva = kit_completo(estado, reserva)
        self.assertNotIn("monitor", reserva["kit"])
        estado, mov = aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"])
        return estado, demanda, reserva, mov

    def test_preparar_consome_reserva_e_cancelar_restaura(self):
        estado, _, reserva, mov = self.preparar()
        self.assertEqual(estado["reservas"][reserva["id"]]["estado"], "consumida")
        self.assertEqual(cov.motivo_bloqueio(estado, "SINT-001", HOJE, Manutencao())["motivo"], "movimentacao_aberta")
        self.assertEqual((mov["estado"], mov["destino_cidade"]), ("preparada", "Cidade A"))
        self.assertIn("Em movimento", cov.build_coverage(estado, HOJE)["vagas"][0]["selos"])
        estado, _ = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "cancelada")
        restaurada = estado["reservas"][reserva["id"]]
        self.assertEqual((restaurada["estado"], restaurada["valida_ate"]), ("ativa", reserva["valida_ate"]))

    def test_cancelar_coletada_restaura_reserva_e_libera_serie(self):
        # O caminho real até "gerada" e o cancelamento por HTTP (gerada e coletada) ficam em test_coverage_transporte;
        # gerada e coletada passam pelo mesmo ramo do domínio, então as asserções de estado abaixo valem para as duas.
        estado, demanda, reserva, mov = self.preparar()
        estado["movimentacoes"][mov["id"]].update({"estado": "gerada", "historico_id": "h1"})
        estado, _ = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], estado["movimentacoes"][mov["id"]]["rev"], "coletada")
        rev = estado["movimentacoes"][mov["id"]]["rev"]
        estado, cancelada = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], rev, "cancelada")
        self.assertEqual((cancelada["estado"], cancelada["fechado_em"], cancelada["rev"]), ("cancelada", HOJE.isoformat(), rev + 1))
        self.assertEqual(cancelada["historico_id"], "h1")  # rastro da planilha que continua no histórico
        restaurada = estado["reservas"][reserva["id"]]
        self.assertEqual((restaurada["estado"], restaurada["valida_ate"], restaurada["movimentacao_id"]), ("ativa", reserva["valida_ate"], None))
        self.assertEqual(cov.motivo_bloqueio(estado, "SINT-001", HOJE, Manutencao(), ignorar_reserva=reserva["id"]), None)
        self.assertIsNone(cov.build_coverage(estado, HOJE)["vagas"][0]["movimentacao_id"])
        self.assertEqual(estado["demandas"][demanda["id"]]["estado"], "aberta")

    def test_cancelar_gerada_com_reserva_vencida_fica_em_revisao(self):
        estado, _, reserva, mov = self.preparar()
        estado["movimentacoes"][mov["id"]].update({"estado": "gerada", "reserva_valida_ate": "2026-11-01"})
        estado, _ = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "cancelada")
        self.assertEqual(estado["reservas"][reserva["id"]]["valida_ate"], "2026-11-01")
        self.assertEqual(cov.motivo_bloqueio(estado, "SINT-001", HOJE, Manutencao())["motivo"], "reserva_vencida_em_revisao")

    def test_cancelar_em_transito_e_recebida_continua_recusado(self):
        estado, _, _, mov = self.preparar()
        estado, mov = ate_em_transito(estado, mov)
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "cancelada")
        self.assertEqual(erro.exception.codigo, "transicao_invalida")
        estado, recebida = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "recebida", recebido_por="Fulano", data="2026-11-06")
        with self.assertRaises(CoberturaErro) as erro:  # a transição recebida → encerrada saiu
            aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], recebida["rev"], "encerrada")
        self.assertEqual(erro.exception.codigo, "transicao_invalida")

    def test_recebida_entrega_e_encerra_demanda_unitaria(self):
        estado = cov.estado_vazio()
        estado, demanda = aplicar(estado, cov.registrar_demanda, data="2026-11-20", cidade="Cidade B", quantidade=1)
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel", cidade="Cidade A")
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        estado, reserva = kit_completo(estado, reserva)
        estado, mov = aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"])
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "coletada")
        self.assertEqual(erro.exception.codigo, "transicao_invalida")
        estado, mov = ate_em_transito(estado, mov)
        with self.assertRaises(CoberturaErro):
            aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "recebida")  # sem recebido_por
        estado, mov = aplicar(estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "recebida",
                              recebido_por="Pessoa Sintética", data="2026-11-19")
        self.assertEqual(estado["demandas"][demanda["id"]]["estado"], "encerrada")
        self.assertEqual(estado["disponibilidade"]["SINT001"]["estado"], "entregue")
        self.assertEqual(cov.motivo_bloqueio(estado, "SINT-001", HOJE, Manutencao())["motivo"], "sem_disponibilidade")

    def divergente(self):
        estado, demanda, _, mov = self.preparar()
        estado, mov = ate_em_transito(estado, mov)
        estado, mov = aplicar(
            estado, cov.mudar_estado_movimentacao, mov["id"], mov["rev"], "recebida_com_divergencia",
            recebido_por="Pessoa Sintética", data="2026-11-19", divergencia={"tipo": "serie_diferente"},
        )
        self.assertEqual(cov.motivo_bloqueio(estado, "SINT-001", HOJE, Manutencao())["motivo"], "movimentacao_aberta")
        return estado, demanda, mov

    def test_divergencia_aceitar(self):
        estado, _, mov = self.divergente()
        estado, mov = aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "aceitar")
        self.assertEqual(mov["estado"], "recebida")
        self.assertEqual(estado["disponibilidade"]["SINT001"]["estado"], "entregue")

    def test_divergencia_corrigir_registra_serie_recebida_sem_contar_duas_vezes(self):
        estado, _, mov = self.divergente()
        with self.assertRaises(CoberturaErro):
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="sint-001")
        estado, mov = aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="SINT-009")
        self.assertEqual((mov["estado"], mov["serie_recebida"]), ("recebida", "SINT-009"))
        self.assertEqual(estado["disponibilidade"]["SINT001"]["estado"], "a_confirmar")
        self.assertEqual(estado["disponibilidade"]["SINT009"]["estado"], "entregue")
        resultado = cov.build_coverage(estado, HOJE)
        self.assertEqual(resultado["vagas"][0]["situacao"], "entregue")
        self.assertEqual(resultado["vagas"][0]["serie"], "SINT-009")
        self.assertNotIn("SINT-009", [s["serie"] for s in resultado["disponiveis"]])
        self.assertEqual(resultado["contagens"]["entregue"], 1)

    def test_divergencia_corrigir_recusa_serie_com_outro_destino_sebrae_ou_manutencao(self):
        estado, demanda, mov = self.divergente()
        # SINT-002 está reservada para outra vaga da mesma necessidade: não pode virar a série entregue.
        estado, outra = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-002")
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="SINT-002")
        self.assertEqual((erro.exception.codigo, erro.exception.status, erro.exception.extra["motivo"]),
                         ("conflito_reserva", 409, "reserva_ativa"))
        self.assertEqual(erro.exception.extra["bloqueio_id"], outra["id"])
        self.assertEqual(estado["reservas"][outra["id"]]["estado"], "ativa")

        estado["movimentacoes"]["mov-outra"] = {"id": "mov-outra", "estado": "em_transito", "serie": "SINT-010", "rev": 1}
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="SINT-010")
        self.assertEqual(erro.exception.extra["motivo"], "movimentacao_aberta")

        estado["disponibilidade"]["SINT011"] = {"id": "SINT011", "serie": "SINT-011", "estado": "entregue", "cidade": "Cidade B",
                                                "movimentacao_id": "mov-velha", "rev": 1}
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="SINT-011")
        self.assertEqual((erro.exception.status, erro.exception.extra["motivo"]), (409, "serie_entregue"))

        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="BRT100XA01")
        self.assertEqual((erro.exception.status, erro.exception.extra["motivo"]), (422, "fora_do_inventario"))

        em_manutencao = ctx(manutencao=Manutencao(series=frozenset({"SINT012"})))
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "corrigir", serie_recebida="SINT-012",
                    contexto=em_manutencao)
        self.assertEqual((erro.exception.status, erro.exception.extra["motivo"]), (422, "manutencao"))

    def test_preparar_revalida_disponibilidade_manual(self):
        estado, demanda, _ = cenario_v1_v4()  # SINT-001 confirmada em 06/11, válida até 13/11
        tarde = ctx(hoje=HOJE + timedelta(days=3))
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001", contexto=tarde)
        estado, reserva = kit_completo(estado, reserva)
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"], contexto=ctx(hoje=HOJE + timedelta(days=8)))
        self.assertEqual((erro.exception.status, erro.exception.extra["motivo"]), (422, "sem_disponibilidade"))
        for situacao in ("em_manutencao", "indisponivel"):
            alterado = json.loads(json.dumps(estado))
            alterado["disponibilidade"]["SINT001"]["estado"] = situacao
            for tipo in ("transporte", "local"):
                with self.assertRaises(CoberturaErro) as erro:
                    aplicar(alterado, cov.preparar_movimentacao, reserva["id"], reserva["rev"], tipo)
                self.assertEqual(erro.exception.extra["motivo"], "sem_disponibilidade")
        aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"], "local")

    def test_disponibilidade_nao_muda_situacao_nem_cidade_de_serie_com_destino(self):
        estado, demanda, _ = cenario_v1_v4()
        estado, reserva = aplicar(estado, cov.reservar, demanda_id=demanda["id"], serie="SINT-001")
        rev = estado["disponibilidade"]["SINT001"]["rev"]
        for situacao, cidade in (("em_manutencao", None), ("indisponivel", None), ("disponivel", "Cidade B")):
            with self.assertRaises(CoberturaErro) as erro:
                aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao=situacao, cidade=cidade, rev=rev)
            self.assertEqual((erro.exception.codigo, erro.exception.status, erro.exception.extra["motivo"]),
                             ("conflito_reserva", 409, "reserva_ativa"))
        # Reconfirmar na mesma cidade continua valendo (renovar a reserva depende disso).
        estado, _ = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel", cidade="cidade a", rev=rev)
        # Sem cidade (botão Confirmar disponível), mantém a cidade do registro mesmo se o cadastro diz outra.
        cadastro = cov.indexar_cadastro([{"serial": "SINT-001", "retirada_cidade": "Cidade B"}])
        estado, registro = aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="disponivel",
                                   rev=estado["disponibilidade"]["SINT001"]["rev"], contexto=ctx(cadastro=cadastro))
        self.assertEqual(registro["cidade"], "cidade a")

        estado, reserva = kit_completo(estado, estado["reservas"][reserva["id"]])
        estado, _ = aplicar(estado, cov.preparar_movimentacao, reserva["id"], reserva["rev"])
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.registrar_disponibilidade, serie="SINT-001", situacao="indisponivel",
                    rev=estado["disponibilidade"]["SINT001"]["rev"])
        self.assertEqual(erro.exception.extra["motivo"], "movimentacao_aberta")
        # Série sem destino continua livre para mudar.
        aplicar(estado, cov.registrar_disponibilidade, serie="SINT-002", situacao="em_manutencao",
                rev=estado["disponibilidade"]["SINT002"]["rev"])

    def test_divergencia_cancelar_reabre_vaga(self):
        estado, demanda, mov = self.divergente()
        estado, mov = aplicar(estado, cov.resolver_divergencia, mov["id"], mov["rev"], "cancelar")
        self.assertEqual(mov["estado"], "cancelada")
        self.assertEqual(estado["disponibilidade"]["SINT001"]["estado"], "a_confirmar")
        self.assertIsNone(cov.build_coverage(estado, HOJE)["vagas"][0]["movimentacao_id"])

    def test_cancelar_demanda_com_movimentacao_aberta_e_recusado(self):
        estado, demanda, _, _ = self.preparar()
        with self.assertRaises(CoberturaErro) as erro:
            aplicar(estado, cov.cancelar_demanda, demanda["id"], estado["demandas"][demanda["id"]]["rev"])
        self.assertEqual(erro.exception.extra["motivo"], "movimentacao_aberta")


class CoberturaArquivamentoTests(unittest.TestCase):
    def test_fechado_ha_40_dias_referenciado_por_aberto_fica(self):
        estado = cov.estado_vazio()
        velho = (HOJE - timedelta(days=40)).isoformat()
        estado["demandas"]["dem-velha"] = {"id": "dem-velha", "estado": "encerrada", "fechado_em": velho, "rev": 3}
        estado["demandas"]["dem-solta"] = {"id": "dem-solta", "estado": "cancelada", "fechado_em": velho, "rev": 2}
        estado["demandas"]["dem-recente"] = {"id": "dem-recente", "estado": "cancelada", "fechado_em": HOJE.isoformat(), "rev": 2}
        estado["movimentacoes"]["mov-aberta"] = {
            "id": "mov-aberta", "estado": "em_transito", "demanda_id": "dem-velha", "reserva_id": None, "rev": 4,
        }
        restante, movidos = cov.separar_arquivaveis(estado, HOJE)
        self.assertIn("dem-velha", restante["demandas"])
        self.assertIn("dem-recente", restante["demandas"])
        self.assertEqual(list(movidos), ["demandas"])
        self.assertEqual(list(movidos["demandas"]), ["dem-solta"])


class CoberturaStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        state = self.root / "data" / "state"
        self.store = CoberturaStore(state / "operacao_cobertura.json", state / "operacao_cobertura_arquivados.json", self.root)

    def test_escrita_arquiva_e_le_de_volta(self):
        velho = (HOJE - timedelta(days=40)).isoformat()
        estado = cov.estado_vazio()
        estado["demandas"]["dem-solta"] = {"id": "dem-solta", "estado": "cancelada", "fechado_em": velho, "rev": 2}
        self.store.arquivo.parent.mkdir(parents=True)
        self.store.arquivo.write_text(json.dumps(estado), encoding="utf-8")
        registro = self.store.escrever(
            lambda atual: cov.registrar_demanda(atual, ctx(), data="2026-11-20", cidade="Cidade A", quantidade=1), HOJE,
        )
        lido = self.store.ler()
        self.assertIn(registro["id"], lido["demandas"])
        self.assertNotIn("dem-solta", lido["demandas"])
        self.assertIn("dem-solta", self.store.ler_arquivados()["demandas"])

    def test_erro_de_regra_nao_grava(self):
        with self.assertRaises(CoberturaErro):
            self.store.escrever(lambda atual: cov.cancelar_demanda(atual, ctx(), "inexistente", 1), HOJE)
        self.assertFalse(self.store.arquivo.exists())

    def test_json_ilegivel_nao_e_sobrescrito(self):
        self.store.arquivo.parent.mkdir(parents=True)
        for conteudo in ("{quebrado", json.dumps({"esquema": 99}), json.dumps({"esquema": 1, "demandas": {"x": {"id": "x"}}})):
            self.store.arquivo.write_text(conteudo, encoding="utf-8")
            with self.assertRaises(EstadoIlegivel):
                self.store.ler()
            with self.assertRaises(Exception):
                self.store.escrever(
                    lambda atual: cov.registrar_demanda(atual, ctx(), data="2026-11-20", cidade="Cidade A", quantidade=1),
                    HOJE,
                )
            self.assertEqual(self.store.arquivo.read_text(encoding="utf-8"), conteudo)

    def test_equipamentos_detalhes_sintetico_nao_muda(self):
        detalhes = self.root / "data" / "planilhas_entrada" / "EquipamentosDetalhes_atual.xlsx"
        detalhes.parent.mkdir(parents=True)
        detalhes.write_bytes(b"PK\x03\x04 sintetico SINT-001")
        antes = hashlib.sha256(detalhes.read_bytes()).hexdigest()
        cadastro = cov.indexar_cadastro([{"serial": "SINT-001", "retirada_cidade": "Cidade A"}])
        self.store.escrever(
            lambda atual: cov.registrar_disponibilidade(atual, ctx(cadastro=cadastro), serie="SINT-001", situacao="disponivel"),
            HOJE,
        )
        self.assertEqual(hashlib.sha256(detalhes.read_bytes()).hexdigest(), antes)
        self.assertEqual(self.store.ler()["disponibilidade"]["SINT001"]["cidade"], "Cidade A")


if __name__ == "__main__":
    unittest.main()
