"""Routes for the local unit catalog."""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from integrity import AtomicFileTransaction, FileBusyError, FileTransactionError


class UnidadePayload(BaseModel):
    id: Optional[int] = None
    cidade: str = Field(..., min_length=1, max_length=160)
    endereco: str = Field(..., min_length=1, max_length=300)
    uf: Optional[str] = Field("PR", max_length=2)
    cep: str = Field("", max_length=12)
    cnpj: str = Field(..., min_length=1, max_length=24)

    @field_validator("uf")
    @classmethod
    def validate_uf(cls, value: Optional[str]) -> str:
        if value is None or not value.strip():
            return "PR"
        normalized = value.strip().upper()
        if normalized not in {
            "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
            "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
            "SP", "SE", "TO",
        }:
            raise ValueError("Informe uma sigla de UF válida.")
        return normalized

    @field_validator("cep")
    @classmethod
    def validate_cep(cls, value: str) -> str:
        normalized = re.sub(r"\D", "", value.strip())
        if value.strip() and len(normalized) != 8:
            raise ValueError("CEP deve conter exatamente oito dígitos.")
        return f"{normalized[:5]}-{normalized[5:]}" if normalized else ""

    @field_validator("cnpj")
    @classmethod
    def validate_cnpj(cls, value: str) -> str:
        digits = re.sub(r"\D", "", value.strip())
        if len(digits) != 14:
            raise ValueError("CNPJ deve conter exatamente 14 dígitos.")
        return value.strip()

    @field_validator("cidade", "endereco")
    @classmethod
    def require_nonblank_unit_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Este campo não pode ficar vazio.")
        return normalized


@dataclass(frozen=True)
class UnitRouteServices:
    format_cep: Callable[[Any], str]
    get_details_files: Callable[[], List[Path]]
    endpoint_upload_file: Callable[[], Path]
    modified_aliases_file: Callable[[], Path]
    custom_units_file: Callable[[], Path]
    export_model_file: Callable[[], Path]
    transaction_root: Callable[[], Path]
    get_units_snapshot: Callable[[], List[Dict[str, Any]]]
    coerce_unit_id: Callable[[Any], Optional[int]]
    unit_identity_key: Callable[[Dict[str, Any]], str]
    local_json_corruption_error: Callable[[str], Exception]
    load_database: Callable[..., Any]
    publish_database_state: Callable[[Dict[str, Any]], None]
    save_postgres_unit: Optional[Callable[[UnidadePayload], Optional[Dict[str, Any]]]] = None


def create_units_router(services: UnitRouteServices):
    router = APIRouter()

    def public_unit_list(units: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {key: value for key, value in unit.items() if key != "_source_key"}
            for unit in units
        ]

    @router.post("/api/unidade/salvar")
    def salvar_unidade(payload: UnidadePayload):
        """Salva ou edita uma regional/filial SEBRAE e persiste no catálogo."""
        if services.save_postgres_unit is not None:
            result = services.save_postgres_unit(payload)
            if result is not None:
                return result
        cidade = payload.cidade.strip()
        endereco = payload.endereco.strip()
        uf = (payload.uf.strip() if payload.uf else "PR").upper()
        cep = services.format_cep(payload.cep)
        cnpj = payload.cnpj.strip()
        retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep}"
        detail_files = services.get_details_files()
        transaction_targets = [
            *detail_files,
            services.endpoint_upload_file(),
            services.modified_aliases_file(),
            services.custom_units_file(),
            services.export_model_file(),
        ]

        try:
            with AtomicFileTransaction(services.transaction_root(), transaction_targets) as transaction:
                current_units = services.get_units_snapshot()

                def update_custom_units(saved_units):
                    if not isinstance(saved_units, list) or any(not isinstance(unit, dict) for unit in saved_units):
                        raise services.local_json_corruption_error("O catálogo local de unidades não contém registros válidos.")
                    updated_units = [dict(unit) for unit in saved_units]
                    selected_unit = next((
                        unit for unit in current_units
                        if payload.id and services.coerce_unit_id(unit.get("id")) == payload.id
                    ), None)
                    matched = False

                    if payload.id:
                        for unit in updated_units:
                            if services.coerce_unit_id(unit.get("id")) == payload.id:
                                source_key = unit.get("_source_key") or (
                                    selected_unit.get("_source_key") if selected_unit else None
                                )
                                unit.update({
                                    "cidade": cidade,
                                    "endereco": endereco,
                                    "uf": uf,
                                    "cep": cep,
                                    "cnpj": cnpj,
                                    "endereco_completo": retirada_endereco,
                                    "label": f"{cidade} - {endereco} ({cnpj})",
                                })
                                if source_key:
                                    unit["_source_key"] = source_key
                                matched = True
                                break

                    if not matched:
                        if payload.id and not any(
                            services.coerce_unit_id(unit.get("id")) == payload.id
                            for unit in current_units
                        ):
                            raise HTTPException(
                                status_code=409,
                                detail="A unidade selecionada não está mais no catálogo. Atualize a lista antes de editar.",
                            )
                        if not payload.id:
                            requested_identity = services.unit_identity_key({
                                "cidade": cidade,
                                "endereco": endereco,
                                "cnpj": cnpj,
                                "uf": uf,
                            })
                            existing_unit = next(
                                (
                                    unit for unit in updated_units
                                    if services.unit_identity_key(unit) == requested_identity
                                ),
                                None,
                            )
                            if existing_unit is not None:
                                return updated_units
                        current_ids = [
                            unit_id
                            for unit in current_units
                            if (unit_id := services.coerce_unit_id(unit.get("id"))) is not None
                        ]
                        new_id = (max(current_ids, default=0) + 1) if not payload.id else payload.id
                        new_unit = {
                            "id": new_id,
                            "cidade": cidade,
                            "endereco": endereco,
                            "uf": uf,
                            "cep": cep,
                            "cnpj": cnpj,
                            "is_sede": "sede" in cidade.lower() or "sede" in endereco.lower(),
                            "endereco_completo": retirada_endereco,
                            "label": f"{cidade} - {endereco} ({cnpj})",
                        }
                        if selected_unit and selected_unit.get("_source_key"):
                            new_unit["_source_key"] = selected_unit["_source_key"]
                        updated_units.append(new_unit)
                    return updated_units

                transaction.update_json(services.custom_units_file(), update_custom_units, [])
                transaction.apply()
                prepared_state = services.load_database(transaction_locked=True, publish=False)
                if not isinstance(prepared_state, dict):
                    raise FileTransactionError(
                        "A unidade não foi confirmada porque o estado resultante não pôde ser carregado."
                    )
                transaction.commit()
                services.publish_database_state(prepared_state)
                published_units = list(prepared_state["unidades_cache"])
        except HTTPException:
            raise
        except FileBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except FileTransactionError as error:
            raise HTTPException(status_code=500, detail=f"Falha ao salvar o catálogo de unidades: {error}") from error

        return {
            "sucesso": True,
            "mensagem": f"Unidade '{cidade}' cadastrada/atualizada com sucesso!",
            "unidades": public_unit_list(published_units),
        }

    @router.get("/api/unidades")
    def get_unidades():
        """Retorna o catálogo completo de unidades SEBRAE catalogadas."""
        units = services.get_units_snapshot()
        return public_unit_list(units)

    return router, {
        "_public_unit_list": public_unit_list,
        "UnidadePayload": UnidadePayload,
        "salvar_unidade": salvar_unidade,
        "get_unidades": get_unidades,
    }
