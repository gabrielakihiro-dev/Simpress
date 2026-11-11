"""Equipment routes: read one record, save an edit and export the active base.

``GET /api/equipamento/{serial}``, ``POST /api/equipamento/salvar`` and
``GET /api/exportar-equipamentos``. The workbook edit lives in
``domains/equipment_edit.py``; ``main.py`` wires every dependency with
late-bound callables so tests that patch ``main`` keep working.
"""

import io
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from domains import equipment_edit, equipment_export, inventory_state
from domains.alias_changes import validate_equipment_serial
from domains.inventory_comparison import normalize_reference_value
from domains.inventory_state import STATE_LOCK


class EquipamentoUpdatePayload(BaseModel):
    serial: str = Field(..., min_length=1, max_length=128, description="Número de Série do Equipamento")
    novo: bool = Field(False, description="Indica que o formulário está cadastrando um equipamento novo")
    modelo: Optional[str] = Field("", max_length=300, description="Modelo do Equipamento")
    tipo: Optional[str] = Field("", max_length=120, description="Tipo (Notebook, Micro Computador, Headsets...)")
    apelido: Optional[str] = Field("", max_length=160, description="Apelido / Hostname")
    idCliente: Optional[str] = Field("", max_length=128, description="ID do Cliente")
    revisao: Optional[str] = Field(None, min_length=64, max_length=64)
    # Mantidos para compatibilidade com clientes antigos; a rota ignora esses campos.
    endereco: Optional[str] = Field("", max_length=500, description="Endereço carregado da Simpress")
    cidade: Optional[str] = Field("", max_length=160, description="Cidade carregada da Simpress")
    uf: Optional[str] = Field("PR", max_length=2, description="UF carregada da Simpress")
    cep: Optional[str] = Field("", max_length=12, description="CEP carregado da Simpress")
    cnpj_instalacao: Optional[str] = Field("", max_length=24, description="CNPJ carregado da Simpress")

    @field_validator("serial")
    @classmethod
    def validate_serial(cls, value: str) -> str:
        return validate_equipment_serial(value)


@dataclass(frozen=True)
class EquipmentRouteServices:
    edit: equipment_edit.EquipmentEditServices
    public_equipment: Callable[[Dict[str, Any]], Dict[str, Any]]
    validate_json_object: Callable[[Any, str], Dict[str, Any]]
    build_export: Callable[[], equipment_export.EquipmentExport]


@dataclass(frozen=True)
class EquipmentRouteExports:
    """Routes exposed to ``main`` for direct calls in tests and helpers."""

    get_equipamento: Callable[..., Any]
    salvar_equipamento: Callable[..., Any]
    exportar_equipamentos: Callable[..., Any]


def create_equipment_router(services: EquipmentRouteServices) -> Tuple[APIRouter, EquipmentRouteExports]:
    router = APIRouter()

    @router.get("/api/equipamento/{serial}")
    def get_equipamento(serial: str):
        """Busca um equipamento pelo número de série (sem distinção de maiúsculas/minúsculas)."""
        clean_serial = serial.strip().upper()
        with STATE_LOCK:
            equipment = deepcopy(inventory_state.equipamentos_cache.get(clean_serial))
        if equipment is not None:
            return services.public_equipment(equipment)

        raise HTTPException(status_code=404, detail=f"Equipamento com serial '{serial}' não encontrado na base de dados.")

    @router.post("/api/equipamento/salvar")
    def salvar_equipamento(payload: EquipamentoUpdatePayload):
        """Atualiza ou cadastra um equipamento tanto na memória do site quanto diretamente na planilha Excel."""
        if not payload.serial or not payload.serial.strip():
            raise HTTPException(status_code=400, detail="Número de série é obrigatório.")
        if not normalize_reference_value(payload.serial):
            raise HTTPException(status_code=422, detail="O número de série precisa conter letras ou números.")

        target_serial = payload.serial.strip().upper()
        requested_fields = set(payload.model_fields_set)
        with STATE_LOCK:
            equipamento_existente = deepcopy(inventory_state.equipamentos_cache.get(target_serial))
        if payload.novo and equipamento_existente is not None:
            raise HTTPException(
                status_code=409,
                detail="A série já está cadastrada; atualize a base antes de criar um novo equipamento.",
            )
        if not payload.novo and equipamento_existente is None:
            raise HTTPException(
                status_code=409,
                detail="Este equipamento não está mais na base carregada; recarregue o inventário antes de editar.",
            )
        if equipamento_existente is not None and not payload.revisao:
            raise HTTPException(
                status_code=409,
                detail="A revisão deste equipamento não foi informada; recarregue-o antes de salvar.",
            )
        if equipamento_existente is not None:
            # Para equipamentos já cadastrados, o apelido só pode ser alterado pela rota dedicada.
            # Isso impede que o formulário de dados/endereço sobrescreva apelidos acidentalmente.
            # Keep the stored EquipamentosDetalhes alias, not its InvAll presentation value.
            payload.apelido = equipamento_existente.get("_apelido_local", equipamento_existente.get("_apelido_base", ""))

        json_mutations = {}
        if equipamento_existente is None and payload.apelido is not None and payload.apelido.strip():
            new_alias = payload.apelido.strip()

            def save_new_alias(data):
                aliases = dict(services.validate_json_object(data, "apelidos"))
                for key in list(aliases):
                    if normalize_reference_value(key) == normalize_reference_value(target_serial):
                        aliases.pop(key, None)
                aliases[target_serial] = new_alias
                return aliases

            json_mutations[services.edit.modified_aliases_file()] = save_new_alias

        saved_equipment, modified_alias_count = equipment_edit.save_equipment_to_excel(
            services.edit,
            payload,
            json_mutations=json_mutations,
            fields_to_update=requested_fields,
        )
        return {
            "sucesso": True,
            "mensagem": f"Equipamento {target_serial} atualizado com sucesso no site e na planilha Excel!",
            "equipamento": services.public_equipment(saved_equipment),
            "total_modificados": modified_alias_count,
        }

    @router.get("/api/exportar-equipamentos")
    def exportar_equipamentos():
        """Exporta a apresentação de referência com os registros da base ativa."""
        export = services.build_export()
        return StreamingResponse(
            io.BytesIO(export.content),
            media_type=equipment_export.XLSX_MEDIA_TYPE,
            headers=export.headers,
        )

    return router, EquipmentRouteExports(get_equipamento, salvar_equipamento, exportar_equipamentos)
