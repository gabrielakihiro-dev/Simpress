"""Transactional workflow for replacing and comparing inventory snapshots."""

import asyncio
from typing import Any, Dict


async def read_uploaded_xlsx(upload: Any, role: str, context: Any) -> Dict[str, Any]:
    """Validate one uploaded workbook and retain its safe display name and bytes."""
    ctx = context
    display_role = {
        "endpoint": "Endpoint",
        "detalhes": "EquipamentosDetalhes",
    }.get(role, role)
    original_name = ctx.re.split(r"[/\\]", str(upload.filename or ""))[-1]
    if not original_name or ctx.Path(original_name).suffix.lower() != ".xlsx":
        raise ctx.HTTPException(status_code=400, detail=f"Selecione um arquivo .xlsx válido para {display_role}.")

    file_bytes = await upload.read(ctx.MAX_UPLOAD_BYTES + 1)
    if not file_bytes:
        raise ctx.HTTPException(status_code=400, detail=f"O arquivo de {display_role} está vazio.")
    if len(file_bytes) > ctx.MAX_UPLOAD_BYTES:
        raise ctx.HTTPException(status_code=413, detail=f"O arquivo de {display_role} excede o limite de 30 MB.")

    table = await asyncio.to_thread(ctx.validate_uploaded_workbook, file_bytes, role)
    return {"name": original_name, "bytes": file_bytes, "table": table}

async def update_inventory_files(endpoint_file: Any, details_file: Any, context: Any):
    """Read uploads asynchronously and run workbook and transaction work off-loop."""
    ctx = context
    uploads = [endpoint_file, details_file]

    try:
        staged = {
            "endpoint": await read_uploaded_xlsx(endpoint_file, "endpoint", ctx),
            "detalhes": await read_uploaded_xlsx(details_file, "detalhes", ctx),
        }

        worker = asyncio.create_task(asyncio.to_thread(_commit_inventory_files, staged, ctx))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            # Once the transaction starts, let it finish or roll back before releasing request resources.
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise
    except ctx.HTTPException:
        raise
    except ctx.FileBusyError as error:
        raise ctx.HTTPException(status_code=409, detail=str(error)) from error
    except ctx.TransactionConflictError as error:
        raise ctx.HTTPException(status_code=500, detail=f"A recuperação detectou uma alteração externa em um arquivo e parou sem sobrescrevê-lo: {error}") from error
    except (ctx.FileTransactionError, ctx.WorkbookSafetyError) as error:
        raise ctx.HTTPException(status_code=500, detail=f"Não foi possível concluir a atualização; a transação restaurou os arquivos anteriores. {error}") from error
    except Exception:
        print("[ERRO] Falha ao atualizar o conjunto de planilhas.")
        raise ctx.HTTPException(status_code=500, detail="Falha ao atualizar as planilhas; os arquivos anteriores foram restaurados.") from None
    finally:
        for upload in uploads:
            await upload.close()


def _commit_inventory_files(staged: Dict[str, Any], context: Any):
    """Validate, compare, replace, reload, and journal inventories in a worker thread."""
    ctx = context
    ctx.INPUT_DIR.mkdir(parents=True, exist_ok=True)
    target_files = {
        "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
        "detalhes": ctx.DETAILS_UPLOAD_FILE,
    }
    for role, target_path in target_files.items():
        if not target_path.is_file():
            display_role = "Endpoint" if role == "endpoint" else "EquipamentosDetalhes"
            raise ctx.HTTPException(
                status_code=409,
                detail=f"A base ativa de {display_role} não foi encontrada; a atualização foi cancelada.",
            )

    uploaded_names = {
        "endpoint": staged["endpoint"]["name"],
        "detalhes": staged["detalhes"]["name"],
    }
    comparison = ctx.compare_uploaded_workbooks(
        staged["endpoint"]["table"],
        staged["detalhes"]["table"],
        uploaded_names,
    )

    transaction_targets = [*target_files.values(), ctx.COMPARISON_HISTORY_FILE]
    with ctx.inventory_state_transaction(transaction_targets) as transaction:
        with ctx.STATE_LOCK:
            previous_aliases = ctx.snapshot_equipment_aliases(ctx.deepcopy(ctx.equipamentos_cache))
        manual_overrides = ctx.load_modified_apelidos()
        manual_alias_sources = ctx._manual_alias_source_snapshots(
            manual_overrides,
            staged["endpoint"]["table"],
            staged["detalhes"]["table"],
        )
        manual_divergences = [
            item for item in manual_alias_sources
            if item["diverge_detalhes"] or item["diverge_invall"]
        ]
        backup_dir = ctx.UPLOAD_BACKUPS_DIR / f"{ctx.datetime.now().strftime('%Y%m%d-%H%M%S')}-{ctx.uuid.uuid4().hex[:8]}"
        backup_dir.mkdir(parents=True, exist_ok=False)

        for role, target_path in target_files.items():
            role_dir = backup_dir / role
            role_dir.mkdir(parents=True, exist_ok=True)
            backup_path = role_dir / target_path.name
            ctx.shutil.copy2(target_path, backup_path)
            if not ctx.filecmp.cmp(target_path, backup_path, shallow=False):
                raise RuntimeError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")

        for role, target_path in target_files.items():
            upload_bytes = staged[role]["bytes"]

            def validate_staged_upload(path: ctx.Path, current_role=role, expected_bytes=upload_bytes):
                candidate_bytes = path.read_bytes()
                if candidate_bytes != expected_bytes:
                    raise ctx.WorkbookSafetyError("O arquivo preparado difere do inventário validado.")
                ctx.validate_uploaded_workbook(candidate_bytes, current_role)

            transaction.stage_bytes(target_path, upload_bytes, validate_staged_upload)

        transaction.apply()
        if not ctx.load_database(transaction_locked=True):
            raise RuntimeError("As planilhas enviadas não puderam ser carregadas pelo site.")

        endpoint_index = ctx.read_endpoint_alias_index()
        detail_serial_counts: ctx.Dict[str, int] = {}
        for record in staged["detalhes"]["table"].get("records", []):
            serial_key = ctx.normalize_reference_value(ctx._upload_serial_value(record, "detalhes"))
            if serial_key:
                detail_serial_counts[serial_key] = detail_serial_counts.get(serial_key, 0) + 1
        detail_serials = set(detail_serial_counts)
        detail_duplicates = {
            serial_key for serial_key, count in detail_serial_counts.items() if count > 1
        }
        comparison["horario_comparacao"] = ctx.datetime.now().astimezone().isoformat(timespec="seconds")
        comparison["apelidos_atualizados"] = ctx.compare_equipment_aliases(
            previous_aliases,
            ctx.snapshot_equipment_aliases(ctx.equipamentos_cache),
        )
        for change in comparison["apelidos_atualizados"]:
            change["arquivos_origem"] = dict(uploaded_names)
            change["horario"] = comparison["horario_comparacao"]
        comparison["apelidos_sem_atualizacao"] = ctx.endpoint_alias_review_items(
            endpoint_index, detail_serials, detail_duplicates
        )
        for record in staged["detalhes"]["table"].get("records", []):
            alias_without_serial = ctx._upload_alias_value(record, "detalhes")
            if alias_without_serial and not ctx.normalize_reference_value(
                ctx._upload_serial_value(record, "detalhes")
            ):
                comparison["apelidos_sem_atualizacao"].append({
                    "serie": "",
                    "computador": alias_without_serial,
                    "motivo": "Número de série vazio em EquipamentosDetalhes; nenhum hostname foi associado.",
                })
        comparison["divergencias_apelidos_manuais"] = manual_divergences
        comparison["fontes_apelidos_manuais"] = manual_alias_sources
        comparison["backup_diretorio"] = str(backup_dir.relative_to(ctx.INPUT_DIR))
        comparison["total_equipamentos_carregados"] = ctx.stats_cache.get("total_equipamentos", 0)
        comparison["ultima_atualizacao"] = ctx.stats_cache.get("ultima_atualizacao", "")
        comparison["arquivos_enviados"] = uploaded_names
        comparison["historico_salvo"] = True
        event_id = ctx.uuid.uuid4().hex
        comparison["evento_id"] = event_id
        summary = {
            "total_endpoint": comparison.get("total_endpoint", 0),
            "ausentes_no_endpoint": len(comparison.get("ausentes_no_endpoint", [])),
            "ausentes_em_detalhes": len(comparison.get("ausentes_em_detalhes", [])),
            "divergencias_local": len(comparison.get("divergencias_local", [])),
            "correspondencias_ambiguas": len(comparison.get("correspondencias_ambiguas", [])),
            "series_sem_mapeamento": len(comparison.get("series_sem_mapeamento", [])),
            "apelidos_atualizados": len(comparison.get("apelidos_atualizados", [])),
            "apelidos_sem_atualizacao": len(comparison.get("apelidos_sem_atualizacao", [])),
            "divergencias_apelidos_manuais": len(manual_divergences),
        }
        history_entry = {
            "id": event_id,
            "horario": comparison["horario_comparacao"],
            "arquivos_enviados": uploaded_names,
            "resumo": summary,
            "comparacao": comparison,
        }

        def append_update(history):
            if not isinstance(history, list):
                raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
            updated = ctx.deepcopy(history)
            refreshed_serials = {
                ctx.normalize_reference_value(item.get("serie"))
                for item in manual_alias_sources
                if item.get("detalhes_encontrado") or item.get("invall_encontrado")
            }
            for previous_event in updated:
                if not isinstance(previous_event, dict):
                    continue
                previous_comparison = previous_event.get("comparacao")
                previous_divergences = (
                    previous_comparison.get("divergencias_apelidos_manuais")
                    if isinstance(previous_comparison, dict) else None
                )
                for previous_divergence in previous_divergences or []:
                    if (
                        isinstance(previous_divergence, dict)
                        and previous_divergence.get("resolucao", "pendente") == "pendente"
                        and ctx.normalize_reference_value(previous_divergence.get("serie")) in refreshed_serials
                    ):
                        previous_divergence["resolucao"] = "substituida"
                        previous_divergence["horario_resolucao"] = comparison["horario_comparacao"]
            updated.append(history_entry)
            return updated

        transaction.update_json(ctx.COMPARISON_HISTORY_FILE, append_update, [])
        transaction.commit()

    historical_view = ctx.comparison_history_for_display(history_entry)
    historical_comparison = dict(historical_view.get("comparacao") or {})
    historical_comparison["evento_id"] = event_id
    historical_comparison["historico_salvo"] = True
    return {
        "sucesso": True,
        "comparacao": historical_comparison,
        "stats": ctx.stats_cache,
        "historico_salvo": True,
    }
