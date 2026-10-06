"""Routes for the local unit catalog."""

import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator


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


def create_units_router(ctx):
    router = APIRouter()

    def public_unit_list(units: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {key: value for key, value in unit.items() if key != "_source_key"}
            for unit in units
        ]

    @router.post("/api/unidade/salvar")
    def salvar_unidade(payload: UnidadePayload):
        """Salva ou edita uma regional/filial SEBRAE e persiste no catálogo."""
        cidade = payload.cidade.strip()
        endereco = payload.endereco.strip()
        uf = (payload.uf.strip() if payload.uf else "PR").upper()
        cep = ctx.format_cep(payload.cep)
        cnpj = payload.cnpj.strip()
        retirada_endereco = f"{endereco} - {cidade}/{uf} - CEP {cep}"
        detail_files = ctx.get_details_files()
        transaction_targets = [
            *detail_files,
            ctx.ENDPOINT_UPLOAD_FILE,
            ctx.MODIFIED_APELIDOS_FILE,
            ctx.CUSTOM_UNIDADES_FILE,
            ctx.EXPORT_MODEL_FILE,
        ]

        try:
            with ctx.AtomicFileTransaction(ctx.TRANSACTION_ROOT, transaction_targets) as transaction:
                with ctx.STATE_LOCK:
                    current_units = list(ctx.unidades_cache)

                def update_custom_units(saved_units):
                    if not isinstance(saved_units, list) or any(not isinstance(unit, dict) for unit in saved_units):
                        raise ctx.LocalJsonCorruptionError("O catálogo local de unidades não contém registros válidos.")
                    updated_units = [dict(unit) for unit in saved_units]
                    selected_unit = next((
                        unit for unit in current_units
                        if payload.id and ctx._coerce_unit_id(unit.get("id")) == payload.id
                    ), None)
                    matched = False

                    if payload.id:
                        for unit in updated_units:
                            if ctx._coerce_unit_id(unit.get("id")) == payload.id:
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
                            ctx._coerce_unit_id(unit.get("id")) == payload.id
                            for unit in current_units
                        ):
                            raise HTTPException(
                                status_code=409,
                                detail="A unidade selecionada não está mais no catálogo. Atualize a lista antes de editar.",
                            )
                        if not payload.id:
                            requested_identity = ctx._unit_identity_key({
                                "cidade": cidade,
                                "endereco": endereco,
                                "cnpj": cnpj,
                                "uf": uf,
                            })
                            existing_unit = next(
                                (
                                    unit for unit in updated_units
                                    if ctx._unit_identity_key(unit) == requested_identity
                                ),
                                None,
                            )
                            if existing_unit is not None:
                                return updated_units
                        current_ids = [
                            unit_id
                            for unit in current_units
                            if (unit_id := ctx._coerce_unit_id(unit.get("id"))) is not None
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

                transaction.update_json(ctx.CUSTOM_UNIDADES_FILE, update_custom_units, [])
                transaction.apply()
                prepared_state = ctx.load_database(transaction_locked=True, publish=False)
                if not isinstance(prepared_state, dict):
                    raise ctx.FileTransactionError(
                        "A unidade não foi confirmada porque o estado resultante não pôde ser carregado."
                    )
                transaction.commit()
                ctx.publish_database_state(prepared_state)
                published_units = list(prepared_state["unidades_cache"])
        except HTTPException:
            raise
        except ctx.FileBusyError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ctx.FileTransactionError as error:
            raise HTTPException(status_code=500, detail=f"Falha ao salvar o catálogo de unidades: {error}") from error

        return {
            "sucesso": True,
            "mensagem": f"Unidade '{cidade}' cadastrada/atualizada com sucesso!",
            "unidades": public_unit_list(published_units),
        }

    @router.get("/api/unidades")
    def get_unidades():
        """Retorna o catálogo completo de unidades SEBRAE catalogadas."""
        with ctx.STATE_LOCK:
            units = list(ctx.unidades_cache)
        return public_unit_list(units)

    return router, {
        "_public_unit_list": public_unit_list,
        "UnidadePayload": UnidadePayload,
        "salvar_unidade": salvar_unidade,
        "get_unidades": get_unidades,
    }
