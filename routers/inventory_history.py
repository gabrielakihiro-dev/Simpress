"""Routes for inventory comparison history and restore operations."""

from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter


def create_inventory_history_router(ctx):
    router = APIRouter()

    def _comparison_event_type(evento: Dict[str, Any]) -> str:
        comparison = evento.get("comparacao")
        if (
            evento.get("tipo") == "restauracao"
            or isinstance(comparison, dict) and comparison.get("tipo_operacao") == "restauracao"
        ):
            return "restauracao"
        return "atualizacao"


    def _comparison_restore_backup_paths(evento: Dict[str, Any]) -> Dict[str, Path]:
        comparison = evento.get("comparacao")
        relative_value = comparison.get("backup_diretorio") if isinstance(comparison, dict) else None
        if not isinstance(relative_value, str) or not relative_value.strip():
            raise ctx.HTTPException(status_code=409, detail="Esta atualização não possui um backup disponível para restauração.")

        relative_path = Path(relative_value)
        if relative_path.is_absolute() or not relative_path.parts or any(part in {".", ".."} for part in relative_path.parts):
            raise ctx.HTTPException(status_code=409, detail="O caminho do backup desta atualização não é válido.")

        try:
            backup_root = ctx.UPLOAD_BACKUPS_DIR.resolve(strict=False)
            backup_directory = (ctx.INPUT_DIR / relative_path).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não está disponível.") from None
        if backup_directory.parent != backup_root or not backup_directory.is_dir():
            raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não está disponível.")

        missing_roles = comparison.get("backup_arquivos_ausentes")
        invalid_roles = comparison.get("backup_arquivos_invalidos")
        target_files = {
            "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
            "detalhes": ctx.DETAILS_UPLOAD_FILE,
        }
        paths: Dict[str, Path] = {}
        for role, target_path in target_files.items():
            if (
                isinstance(missing_roles, dict) and missing_roles.get(role) is True
                or isinstance(invalid_roles, dict) and invalid_roles.get(role) is True
            ):
                raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não contém dois inventários válidos.")
            try:
                role_directory = (backup_directory / role).resolve(strict=True)
                if role_directory.parent != backup_directory or not role_directory.is_dir():
                    raise ValueError("invalid backup role directory")
                backup_path = (role_directory / target_path.name).resolve(strict=True)
                if backup_path.parent != role_directory or not backup_path.is_file():
                    raise ValueError("invalid backup file")
            except (OSError, RuntimeError, ValueError):
                raise ctx.HTTPException(status_code=409, detail="O backup desta atualização não contém os dois inventários.") from None
            paths[role] = backup_path
        return paths


    def _comparison_event_has_restorable_backup(evento: Dict[str, Any]) -> bool:
        try:
            _comparison_restore_backup_paths(evento)
            return True
        except ctx.HTTPException:
            return False


    def _sha256_file(path: Path) -> str:
        digest = ctx.hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()


    def _validated_comparison_backup_files(paths: Dict[str, Path]) -> Dict[str, Dict[str, Any]]:
        labels = {"endpoint": "Endpoint", "detalhes": "EquipamentosDetalhes"}
        files: Dict[str, Dict[str, Any]] = {}
        for role, backup_path in paths.items():
            label = labels[role]
            try:
                size = backup_path.stat().st_size
                if size <= 0 or size > ctx.MAX_UPLOAD_BYTES:
                    raise ctx.HTTPException(status_code=409, detail="O arquivo excede o limite de tamanho ou está vazio.")
                file_bytes = backup_path.read_bytes()
                table = ctx.validate_uploaded_workbook(file_bytes, role)
            except ctx.HTTPException as error:
                raise ctx.HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error.detail}",
                ) from error
            except ctx.WorkbookSafetyError as error:
                raise ctx.HTTPException(
                    status_code=409,
                    detail=f"O backup de {label} não passou na validação: {error}",
                ) from error
            except OSError:
                raise ctx.HTTPException(status_code=409, detail=f"Não foi possível ler o backup de {label}.") from None
            files[role] = {
                "path": backup_path,
                "name": backup_path.name,
                "bytes": file_bytes,
                "sha256": ctx.hashlib.sha256(file_bytes).hexdigest(),
                "records": len(table.get("records", [])),
                "size": size,
                "modified": ctx.datetime.fromtimestamp(backup_path.stat().st_mtime).astimezone().isoformat(timespec="seconds"),
            }
        return files


    def _current_inventory_snapshot() -> tuple[Dict[str, Dict[str, Any]], Dict[str, Optional[str]]]:
        target_files = {
            "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
            "detalhes": ctx.DETAILS_UPLOAD_FILE,
        }
        metadata: Dict[str, Dict[str, Any]] = {}
        hashes: Dict[str, Optional[str]] = {}
        for role, target_path in target_files.items():
            if target_path.is_symlink():
                raise ctx.HTTPException(status_code=409, detail="Um arquivo ativo foi substituído por um atalho; a restauração foi cancelada.")
            if target_path.exists() and not target_path.is_file():
                raise ctx.HTTPException(status_code=409, detail=f"O caminho ativo {target_path.name} não é um arquivo regular.")
            if not target_path.is_file():
                metadata[role] = {"nome": target_path.name, "presente": False}
                hashes[role] = None
                continue
            try:
                stat = target_path.stat()
                if stat.st_size > ctx.MAX_UPLOAD_BYTES:
                    raise ctx.HTTPException(status_code=409, detail=f"O arquivo ativo {target_path.name} excede o limite permitido para backup.")
                file_hash = _sha256_file(target_path)
            except ctx.HTTPException:
                raise
            except OSError:
                raise ctx.HTTPException(status_code=409, detail=f"Não foi possível conferir o arquivo ativo {target_path.name}.") from None
            metadata[role] = {
                "nome": target_path.name,
                "presente": True,
                "tamanho_bytes": stat.st_size,
                "modificado_em": ctx.datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds"),
            }
            hashes[role] = file_hash
        return metadata, hashes


    def _build_comparison_restore_context(evento_id: str) -> Dict[str, Any]:
        evento = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if evento is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico de planilhas.")

        backup_paths = _comparison_restore_backup_paths(evento)
        backup_files = _validated_comparison_backup_files(backup_paths)
        current_files, current_hashes = _current_inventory_snapshot()
        token_material = {
            "evento_id": evento_id,
            "horario": evento.get("horario"),
            "backup_diretorio": evento.get("comparacao", {}).get("backup_diretorio"),
            "backup_hashes": {role: backup_files[role]["sha256"] for role in sorted(backup_files)},
            "ativos_hashes": current_hashes,
        }
        preview_token = ctx.hashlib.sha256(
            ctx.json.dumps(token_material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return {
            "evento": evento,
            "backup_files": backup_files,
            "current_files": current_files,
            "current_hashes": current_hashes,
            "preview_token": preview_token,
        }


    @router.get("/api/historico-comparacoes")
    def get_historico_comparacoes():
        eventos = []
        for evento in ctx.load_comparison_history():
            if not isinstance(evento, dict):
                continue
            event_view = ctx.comparison_history_for_display(evento)
            comparison = event_view.get("comparacao")
            comparison = comparison if isinstance(comparison, dict) else {}
            eventos.append({
                "id": event_view.get("id"),
                "horario": event_view.get("horario"),
                "tipo": _comparison_event_type(event_view),
                "arquivos_enviados": event_view.get("arquivos_enviados", {}),
                "arquivos_restaurados": comparison.get("arquivos_restaurados", {}),
                "restauracao_de": comparison.get("restauracao_de", {}),
                "restauravel": _comparison_event_has_restorable_backup(evento),
                "resumo": event_view.get("resumo", {}),
            })
        def event_timestamp(item: Dict[str, Any]) -> float:
            try:
                return ctx.datetime.fromisoformat(str(item.get("horario") or "").replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError, OverflowError):
                return float("-inf")
        eventos.sort(key=event_timestamp, reverse=True)
        return {"total": len(eventos), "eventos": eventos}


    @router.get("/api/historico-comparacoes/{evento_id}")
    def get_comparacao_historica(evento_id: str):
        evento = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if evento is None:
            raise ctx.HTTPException(status_code=404, detail="O resultado selecionado não existe no histórico de planilhas.")
        return {"evento": ctx.comparison_history_for_display(evento)}


    @router.get("/api/historico-comparacoes/{evento_id}/restauracao")
    def visualizar_restauracao_comparacao(evento_id: str):
        context = _build_comparison_restore_context(evento_id)
        return {
            "evento_id": evento_id,
            "evento_horario": context["evento"].get("horario"),
            "tipo_evento": _comparison_event_type(context["evento"]),
            "arquivos_backup": {
                role: {
                    "nome": item["name"],
                    "registros": item["records"],
                    "tamanho_bytes": item["size"],
                    "modificado_em": item["modified"],
                }
                for role, item in context["backup_files"].items()
            },
            "arquivos_atuais": context["current_files"],
            "preview_token": context["preview_token"],
        }


    @router.post("/api/historico-comparacoes/{evento_id}/restaurar")
    def restaurar_comparacao_historica(evento_id: str, payload: ctx.ComparisonRestorePayload):
        state_before = None
        persistent_backup_dir = None

        try:
            context = _build_comparison_restore_context(evento_id)
            if not ctx.hmac.compare_digest(payload.preview_token, context["preview_token"]):
                raise ctx.HTTPException(
                    status_code=409,
                    detail="Os arquivos ativos ou o backup mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                )
            if all(
                context["backup_files"][role]["sha256"] == context["current_hashes"][role]
                for role in context["backup_files"]
            ):
                raise ctx.HTTPException(status_code=409, detail="Os dois inventários ativos já correspondem ao backup selecionado.")

            state_before = (
                ctx.deepcopy(ctx.equipamentos_cache),
                ctx.deepcopy(ctx.unidades_cache),
                ctx.deepcopy(ctx.stats_cache),
            )
            restoration_time = ctx.datetime.now().astimezone().isoformat(timespec="seconds")
            restoration_id = ctx.uuid.uuid4().hex
            persistent_backup_dir = ctx.UPLOAD_BACKUPS_DIR / f"{ctx.datetime.now().strftime('%Y%m%d-%H%M%S')}-{ctx.uuid.uuid4().hex[:8]}"
            target_files = {
                "endpoint": ctx.ENDPOINT_UPLOAD_FILE,
                "detalhes": ctx.DETAILS_UPLOAD_FILE,
            }
            source_event = context["evento"]
            source_comparison = source_event.get("comparacao") or {}
            source_backup_relative = source_comparison.get("backup_diretorio")
            transaction_targets = [*target_files.values(), ctx.COMPARISON_HISTORY_FILE]

            with ctx.AtomicFileTransaction(ctx.TRANSACTION_ROOT, transaction_targets) as transaction:
                _, locked_current_hashes = _current_inventory_snapshot()
                if locked_current_hashes != context["current_hashes"]:
                    raise ctx.HTTPException(
                        status_code=409,
                        detail="Os inventários ativos mudaram desde a prévia. Atualize a prévia antes de restaurar.",
                    )
                persistent_backup_dir.mkdir(parents=True, exist_ok=False)
                missing_current_files: Dict[str, bool] = {}
                invalid_current_files: Dict[str, bool] = {}
                for role, target_path in target_files.items():
                    role_backup_dir = persistent_backup_dir / role
                    role_backup_dir.mkdir(parents=True, exist_ok=True)
                    expected_current_hash = context["current_hashes"][role]
                    if not target_path.is_file():
                        if expected_current_hash is not None:
                            raise ctx.TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                        missing_current_files[role] = True
                        invalid_current_files[role] = False
                        continue
                    if expected_current_hash is None:
                        raise ctx.TransactionConflictError(f"'{target_path.name}' mudou durante a restauração.")
                    backup_path = role_backup_dir / target_path.name
                    ctx.shutil.copy2(target_path, backup_path)
                    with backup_path.open("r+b") as backup_file:
                        backup_file.flush()
                        ctx.os.fsync(backup_file.fileno())
                    if (
                        not ctx.filecmp.cmp(target_path, backup_path, shallow=False)
                        or _sha256_file(backup_path) != expected_current_hash
                    ):
                        raise ctx.TransactionConflictError(f"A cópia de segurança de '{target_path.name}' não passou na validação.")
                    missing_current_files[role] = False
                    try:
                        ctx.validate_uploaded_workbook(backup_path.read_bytes(), role)
                        invalid_current_files[role] = False
                    except Exception:
                        invalid_current_files[role] = True

                _, backed_up_current_hashes = _current_inventory_snapshot()
                if backed_up_current_hashes != context["current_hashes"]:
                    raise ctx.TransactionConflictError("Um inventário ativo mudou durante a cópia de segurança.")

                for role, target_path in target_files.items():
                    backup_bytes = context["backup_files"][role]["bytes"]

                    def validate_staged_backup(path: Path, current_role=role, expected_bytes=backup_bytes):
                        candidate_bytes = path.read_bytes()
                        if candidate_bytes != expected_bytes:
                            raise ctx.WorkbookSafetyError("O arquivo preparado difere do backup validado.")
                        ctx.validate_uploaded_workbook(candidate_bytes, current_role)

                    transaction.stage_bytes(target_path, backup_bytes, validate_staged_backup)

                transaction.apply()
                if not ctx.load_database(transaction_locked=True):
                    raise RuntimeError("O conjunto restaurado não pôde ser carregado pelo site.")

                restored_files = {role: path.name for role, path in target_files.items()}
                restoration_comparison = {
                    "evento_id": restoration_id,
                    "tipo_operacao": "restauracao",
                    "horario_comparacao": restoration_time,
                    "restauracao_de": {
                        "evento_id": evento_id,
                        "horario": source_event.get("horario"),
                        "tipo": _comparison_event_type(source_event),
                    },
                    "arquivos_restaurados": restored_files,
                    "total_endpoint_restaurado": context["backup_files"]["endpoint"]["records"],
                    "total_detalhes_restaurado": context["backup_files"]["detalhes"]["records"],
                    "total_equipamentos_carregados": ctx.stats_cache.get("total_equipamentos", 0),
                    "backup_diretorio": str(persistent_backup_dir.relative_to(ctx.INPUT_DIR)),
                    "backup_arquivos_ausentes": missing_current_files,
                    "backup_arquivos_invalidos": invalid_current_files,
                    "historico_salvo": True,
                }
                restoration_event = {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "arquivos_restaurados": restored_files,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "resumo": {
                        "restauracao": True,
                        "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                        "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    },
                    "comparacao": restoration_comparison,
                }

                def append_restoration(history):
                    if not isinstance(history, list):
                        raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                    current_source_event = next(
                        (item for item in history if isinstance(item, dict) and item.get("id") == evento_id),
                        None,
                    )
                    current_source_comparison = (
                        current_source_event.get("comparacao")
                        if isinstance(current_source_event, dict) else None
                    )
                    if (
                        not isinstance(current_source_comparison, dict)
                        or current_source_comparison.get("backup_diretorio") != source_backup_relative
                        or current_source_event.get("horario") != source_event.get("horario")
                    ):
                        raise ctx.HTTPException(
                            status_code=409,
                            detail="A atualização selecionada mudou ou foi removida do histórico. A restauração foi cancelada.",
                        )
                    updated = ctx.deepcopy(history)
                    updated.append(restoration_event)
                    return updated

                transaction.update_json(ctx.COMPARISON_HISTORY_FILE, append_restoration, [])
                transaction.commit()

            return {
                "sucesso": True,
                "evento": {
                    "id": restoration_id,
                    "tipo": "restauracao",
                    "horario": restoration_time,
                    "restauracao_de": restoration_comparison["restauracao_de"],
                    "arquivos_restaurados": restored_files,
                    "desfazer_disponivel": not any(missing_current_files.values()) and not any(invalid_current_files.values()),
                    "total_endpoint_restaurado": restoration_comparison["total_endpoint_restaurado"],
                    "total_detalhes_restaurado": restoration_comparison["total_detalhes_restaurado"],
                    "total_equipamentos_carregados": restoration_comparison["total_equipamentos_carregados"],
                },
            }
        except ctx.HTTPException:
            if state_before:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            raise
        except ctx.FileBusyError as error:
            if state_before:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            raise ctx.HTTPException(status_code=409, detail=str(error)) from error
        except ctx.TransactionConflictError as error:
            if state_before:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            raise ctx.HTTPException(status_code=409, detail=f"Um arquivo mudou durante a restauração e nada foi sobrescrito: {error}") from error
        except (ctx.FileTransactionError, ctx.WorkbookSafetyError) as error:
            if state_before:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            raise ctx.HTTPException(status_code=500, detail=f"Não foi possível concluir a restauração; os arquivos anteriores foram recuperados. {error}") from error
        except Exception:
            if state_before:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            print("[ERRO] Falha ao restaurar o conjunto de planilhas.")
            raise ctx.HTTPException(status_code=500, detail="Falha ao restaurar o conjunto; os arquivos anteriores foram recuperados.") from None


    @router.post("/api/historico-comparacoes/{evento_id}/apelido-manual/{serial}")
    def resolver_divergencia_apelido_manual(
        evento_id: str,
        serial: str,
        payload: ctx.ManualAliasConflictResolutionPayload,
    ):
        acao = str(payload.acao or "").strip().lower()
        if acao not in {"manter", "excluir"}:
            raise ctx.HTTPException(status_code=400, detail="Escolha manter ou excluir a alteração manual.")

        serial_key = ctx.normalize_reference_value(serial)
        if not serial_key:
            raise ctx.HTTPException(status_code=400, detail="A série informada é inválida.")

        event = next(
            (item for item in ctx.load_comparison_history() if isinstance(item, dict) and item.get("id") == evento_id),
            None,
        )
        if event is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe no histórico.")
        comparison = event.get("comparacao")
        divergences = comparison.get("divergencias_apelidos_manuais") if isinstance(comparison, dict) else None
        divergence = next(
            (
                item for item in divergences or []
                if isinstance(item, dict) and ctx.normalize_reference_value(item.get("serie")) == serial_key
            ),
            None,
        )
        if divergence is None:
            raise ctx.HTTPException(status_code=404, detail="A divergência de apelido não existe neste registro.")
        if divergence.get("resolucao") != "pendente":
            raise ctx.HTTPException(status_code=409, detail="Esta divergência já foi resolvida no histórico.")

        expected_manual_alias = str(divergence.get("apelido_manual") or "").strip()
        state_before = (
            ctx.deepcopy(ctx.equipamentos_cache),
            ctx.deepcopy(ctx.unidades_cache),
            ctx.deepcopy(ctx.stats_cache),
        ) if acao == "excluir" else None
        target_serial = next(
            (
                str(item.get("serial") or key).strip().upper()
                for key, item in ctx.equipamentos_cache.items()
                if ctx.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            str(serial).strip().upper(),
        )
        targets = [ctx.COMPARISON_HISTORY_FILE, ctx.MODIFIED_APELIDOS_FILE]
        if acao == "excluir":
            details_file = ctx.get_equipamentos_template_file()
            if details_file is None or not details_file.is_file():
                raise ctx.HTTPException(status_code=404, detail="A planilha EquipamentosDetalhes atual não foi encontrada.")
            targets.append(details_file)

        try:
            with ctx.AtomicFileTransaction(ctx.TRANSACTION_ROOT, targets) as transaction:
                current_aliases = ctx._manual_aliases_by_serial(ctx.load_modified_apelidos())
                if serial_key not in current_aliases or current_aliases[serial_key] != expected_manual_alias:
                    raise ctx.HTTPException(
                        status_code=409,
                        detail="O apelido manual mudou desde esta comparação. Atualize o histórico antes de decidir.",
                    )

                if acao == "excluir":
                    source_alias = (
                        str(divergence.get("apelido_invall") or "").strip()
                        if divergence.get("invall_encontrado") and divergence.get("apelido_invall")
                        else str(divergence.get("apelido_equipamentos_detalhes") or "").strip()
                    )
                    if not ctx.atualizar_apelido_na_planilha(
                        target_serial,
                        source_alias,
                        obrigatorio=True,
                        transaction=transaction,
                        expected_current_alias=expected_manual_alias,
                    ):
                        raise ctx.HTTPException(status_code=409, detail="A série não pôde ser atualizada na planilha EquipamentosDetalhes.")

                    def remove_manual_override(data):
                        if not isinstance(data, dict):
                            raise RuntimeError("O arquivo de apelidos manuais não contém um objeto válido.")
                        keys = [key for key in data if ctx.normalize_reference_value(key) == serial_key]
                        if len(keys) != 1 or str(data.get(keys[0]) or "").strip() != expected_manual_alias:
                            raise ctx.HTTPException(status_code=409, detail="O override manual mudou desde esta comparação.")
                        updated = dict(data)
                        for key in keys:
                            updated.pop(key, None)
                        return updated

                    transaction.update_json(ctx.MODIFIED_APELIDOS_FILE, remove_manual_override, {})

                def mark_divergence_resolved(history):
                    if not isinstance(history, list):
                        raise RuntimeError("O histórico de planilhas não contém uma lista válida.")
                    updated = list(history)
                    stored_event = next((item for item in updated if item.get("id") == evento_id), None)
                    if stored_event is None:
                        raise ctx.HTTPException(status_code=409, detail="A atualização foi removida do histórico.")
                    stored_comparison = stored_event.get("comparacao")
                    stored_divergences = stored_comparison.get("divergencias_apelidos_manuais") if isinstance(stored_comparison, dict) else None
                    stored_divergence = next(
                        (
                            item for item in stored_divergences or []
                            if isinstance(item, dict) and ctx.normalize_reference_value(item.get("serie")) == serial_key
                        ),
                        None,
                    )
                    if stored_divergence is None or stored_divergence.get("resolucao") != "pendente":
                        raise ctx.HTTPException(status_code=409, detail="A divergência já foi alterada no histórico.")
                    stored_divergence["resolucao"] = acao
                    stored_divergence["horario_resolucao"] = ctx.datetime.now().astimezone().isoformat(timespec="seconds")
                    return updated

                transaction.update_json(ctx.COMPARISON_HISTORY_FILE, mark_divergence_resolved, [])
                transaction.apply()
                if acao == "excluir" and not ctx.load_database(transaction_locked=True):
                    raise RuntimeError("A base não pôde ser recarregada após excluir o override manual.")
                transaction.commit()
        except Exception:
            if state_before is not None:
                with ctx.STATE_LOCK:
                    ctx.equipamentos_cache, ctx.unidades_cache, ctx.stats_cache = state_before
            raise

        equipment = next(
            (
                item for key, item in ctx.equipamentos_cache.items()
                if ctx.normalize_reference_value(item.get("serial") or key) == serial_key
            ),
            None,
        )
        return {
            "sucesso": True,
            "resolucao": acao,
            "mensagem": (
                "Apelido manual mantido para esta série."
                if acao == "manter"
                else "Alteração manual removida; o apelido voltou a seguir as planilhas de origem."
            ),
            "equipamento": {
                key: value for key, value in equipment.items() if not key.startswith("_")
            } if equipment else None,
            "total_modificados": len(ctx.load_modified_apelidos()),
        }


    @router.delete("/api/historico-comparacoes/{evento_id}")
    def excluir_comparacao_historica(evento_id: str):
        total = ctx.delete_comparison_history_entry(evento_id)
        if total is None:
            raise ctx.HTTPException(status_code=404, detail="A atualização selecionada não existe mais no histórico.")
        return {"sucesso": True, "total": total}

    return router, {
        '_build_comparison_restore_context': _build_comparison_restore_context,
        '_comparison_event_has_restorable_backup': _comparison_event_has_restorable_backup,
        '_comparison_event_type': _comparison_event_type,
        '_comparison_restore_backup_paths': _comparison_restore_backup_paths,
        '_current_inventory_snapshot': _current_inventory_snapshot,
        '_sha256_file': _sha256_file,
        '_validated_comparison_backup_files': _validated_comparison_backup_files,
        'excluir_comparacao_historica': excluir_comparacao_historica,
        'get_comparacao_historica': get_comparacao_historica,
        'get_historico_comparacoes': get_historico_comparacoes,
        'resolver_divergencia_apelido_manual': resolver_divergencia_apelido_manual,
        'restaurar_comparacao_historica': restaurar_comparacao_historica,
        'visualizar_restauracao_comparacao': visualizar_restauracao_comparacao,
    }
