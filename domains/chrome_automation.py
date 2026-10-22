"""Runs scripts/automacao_rotinas_chrome.py for the Automação screen (docs/operacao/automacao-chrome.md).

The server depends on the script only through its command line and files (lock,
logs, JSON summaries, cancel signal), never by importing it. Every shared name
lives in ``ScriptContract`` so the merge of the automation branches only has to
adjust that one place. The script's batches are still imported through the local
inbox folders; this module only starts, watches and stops the process.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol
from urllib.parse import quote

from core.errors import DomainBusyError, DomainConflictError, DomainError

logger = logging.getLogger(__name__)

ROUTINES = ("os", "inventarios", "ambas", "login", "usuarios", "sebrae")
ROUTINE_LABELS = {
    "os": "Rotina de OS",
    "inventarios": "Inventários",
    "ambas": "Ambas as rotinas",
    "login": "Abrir Chrome para login",
    "usuarios": "Verificar usuários",
    "sebrae": "Sincronizar chamados Sebrae",
}
MAX_LOG_CHUNK_BYTES = 64 * 1024
LOGIN_SCAN_BYTES = 256 * 1024
SITE_RECORDS_KEPT = 100
# A script summary whose start is this close to a site run describes the same execution.
SAME_RUN_SECONDS = 10
CAPTURE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.() -]{1,200}\.png$")
FINAL_STATUSES = frozenset({"concluido", "falha", "cancelado", "ocupada", "interrompido"})


@dataclass(frozen=True)
class ScriptContract:
    """Names shared with the script; check them when the automation branches are merged."""

    script: Path
    python: Path
    working_dir: Path
    # JSON {pid, rotina, inicio} while a run is active (branch "trava").
    lock_file: Path
    # Created by ``--cancelar`` (branch "cancelar"); the server only calls the flag.
    cancel_signal_file: Path
    # <AAAAMMDD_HHMMSS>_<rotina>.log + .json written by the script (branch "log"), plus error captures (.png).
    log_dir: Path
    routine_flag: str = "--rotina"
    cancel_flag: str = "--cancelar"
    exit_busy: int = 2
    exit_cancelled: int = 130
    login_wait_marker: str = "AÇÃO NECESSÁRIA: faça o login"
    login_done_markers: tuple[str, ...] = ("Login detectado", "Sessão ativa")
    capture_marker: str = "Captura da tela no erro:"
    # Files the server writes for the runs it starts (stdout capture and summary).
    site_log_suffix: str = ".site.log"
    site_record_suffix: str = ".site.json"
    environment: Dict[str, str] = field(default_factory=lambda: {
        # The first two are the ones executar_automacao.bat sets; unbuffered output keeps the live lines live.
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
    })


def project_python(base_dir: Path) -> Path:
    """The project's .venv interpreter (as in executar_automacao.bat), else the server's own."""
    for candidate in (base_dir / ".venv" / "Scripts" / "python.exe", base_dir / ".venv" / "bin" / "python"):
        if candidate.is_file():
            return candidate
    return Path(sys.executable)


def default_contract(base_dir: Path, state_dir: Path, logs_dir: Path) -> ScriptContract:
    return ScriptContract(
        script=base_dir / "scripts" / "automacao_rotinas_chrome.py",
        python=project_python(base_dir),
        working_dir=base_dir,
        lock_file=state_dir / "automacao_chrome.lock",
        cancel_signal_file=state_dir / "automacao_chrome.cancelar",
        log_dir=logs_dir / "automacao_chrome",
    )


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class ProcessHandle(Protocol):
    pid: int

    def poll(self) -> Optional[int]: ...

    def wait(self) -> int: ...

    def terminate(self) -> None: ...


def _now_iso(now: datetime) -> str:
    return now.astimezone().isoformat(timespec="seconds")


def _parse_time(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.astimezone()


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def read_log_chunk(path: Optional[Path], offset: int, max_bytes: int = MAX_LOG_CHUNK_BYTES) -> Dict[str, Any]:
    """Complete lines from ``offset``; restarts from zero when the file shrank."""
    empty = {"arquivo": path.name if path else "", "offset": 0, "linhas": [], "reiniciado": offset > 0}
    if path is None:
        return empty
    try:
        size = path.stat().st_size
        restarted = offset > size
        start = 0 if restarted else offset
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(max_bytes)
    except OSError:
        return empty
    end = data.rfind(b"\n") + 1
    complete = data[:end]
    text = complete.decode("utf-8", errors="replace").replace("\r", "")
    return {
        "arquivo": path.name,
        "offset": start + len(complete),
        "linhas": text.split("\n")[:-1] if text else [],
        "reiniciado": restarted,
    }


def _read_tail(path: Optional[Path], max_bytes: int) -> str:
    if path is None:
        return ""
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - max_bytes))
            return handle.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


@dataclass
class _Run:
    rotina: str
    inicio: str
    pid: int
    log_path: Path
    record_path: Path
    process: Optional[ProcessHandle]
    cancel_requested: bool = False
    finished: bool = False

    def alive(self, is_alive: Callable[[int], bool]) -> bool:
        if self.process is not None:
            return self.process.poll() is None
        return is_alive(self.pid)


class ChromeAutomationRunner:
    """Starts one script run at a time and reports its state, live log and history."""

    def __init__(
        self,
        contract: ScriptContract,
        *,
        popen: Callable[..., ProcessHandle] = subprocess.Popen,
        run: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run,
        is_alive: Callable[[int], bool] = pid_alive,
        now: Callable[[], datetime] = datetime.now,
        watch: bool = True,
    ) -> None:
        self.contract = contract
        self._popen = popen
        self._run_command = run
        self._is_alive = is_alive
        self._now = now
        self._watch = watch
        self._lock = threading.Lock()
        self._current: Optional[_Run] = None
        self._cancel_support: Optional[tuple[float, bool]] = None
        self._recover_site_records()

    # ------------------------------------------------------------------ helpers

    def _command(self, *arguments: str) -> List[str]:
        return [str(self.contract.python), str(self.contract.script), *arguments]

    def _process_options(self) -> Dict[str, Any]:
        options: Dict[str, Any] = {
            "cwd": str(self.contract.working_dir),
            "env": {**os.environ, **self.contract.environment},
            "stdin": subprocess.DEVNULL,
            "close_fds": True,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        return options

    def _site_records(self) -> List[Path]:
        if not self.contract.log_dir.is_dir():
            return []
        return sorted(self.contract.log_dir.glob(f"*{self.contract.site_record_suffix}"))

    def _recover_site_records(self) -> None:
        """A server restart loses the child handle: adopt live runs, close the dead ones."""
        for path in self._site_records():
            record = _read_json(path)
            if not record or record.get("status") != "em_andamento":
                continue
            pid = int(record.get("pid") or 0)
            log_path = self.contract.log_dir / str(record.get("log") or "")
            if self._current is None and self._is_alive(pid):
                self._current = _Run(str(record.get("rotina")), str(record.get("inicio")), pid, log_path, path, None)
                continue
            self._finish_record(path, record, None, log_path)

    def _lock_owner(self) -> Optional[Dict[str, Any]]:
        data = _read_json(self.contract.lock_file)
        if not data:
            return None
        try:
            pid = int(data.get("pid") or 0)
        except (TypeError, ValueError):
            return None
        return data if self._is_alive(pid) else None

    def _finish_run_locked(self, run: _Run, code: Optional[int]) -> None:
        """Writes the final summary once, whether the poll or the waiting thread sees the exit first."""
        if not run.finished:
            run.finished = True
            record = _read_json(run.record_path) or {}
            self._finish_record(run.record_path, record, code, run.log_path, cancelled=run.cancel_requested)
        if self._current is run:
            self._current = None

    def _refresh_locked(self) -> None:
        run = self._current
        if run is None or run.alive(self._is_alive):
            return
        # A run adopted after a restart has no handle, so its exit code is unknown.
        self._finish_run_locked(run, run.process.poll() if run.process is not None else None)

    def _active_locked(self) -> Optional[Dict[str, Any]]:
        self._refresh_locked()
        run = self._current
        if run is not None and run.alive(self._is_alive):
            return {"rotina": run.rotina, "inicio": run.inicio, "pid": run.pid, "origem": "site",
                    "cancelamento_pedido": run.cancel_requested}
        owner = self._lock_owner()
        if owner is not None:
            return {"rotina": str(owner.get("rotina") or ""), "inicio": str(owner.get("inicio") or ""),
                    "pid": int(owner.get("pid") or 0), "origem": "externo",
                    "cancelamento_pedido": self.contract.cancel_signal_file.exists()}
        return None

    @staticmethod
    def busy_message(active: Dict[str, Any]) -> str:
        label = ROUTINE_LABELS.get(active["rotina"], active["rotina"] or "rotina")
        started = _parse_time(active.get("inicio"))
        since = f" desde {started:%H:%M}" if started else ""
        return f"Já há uma rotina em andamento: {label}{since}. Aguarde terminar ou cancele."

    def _new_log_path(self, rotina: str) -> Path:
        self.contract.log_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{self._now():%Y%m%d_%H%M%S}_{rotina}"
        candidate = self.contract.log_dir / f"{stem}{self.contract.site_log_suffix}"
        counter = 2
        while candidate.exists():
            candidate = self.contract.log_dir / f"{stem}_{counter}{self.contract.site_log_suffix}"
            counter += 1
        return candidate

    def _record_path(self, log_path: Path) -> Path:
        stem = log_path.name[: -len(self.contract.site_log_suffix)]
        return log_path.with_name(f"{stem}{self.contract.site_record_suffix}")

    def _parse_log(self, log_path: Path) -> Dict[str, Any]:
        lotes: List[Dict[str, str]] = []
        capturas: List[str] = []
        falha = ""
        for line in _read_tail(log_path, 1024 * 1024).splitlines():
            batch = re.search(r"Lote (\S+) em (\w+)", line)
            if batch:
                lotes.append({"id": batch.group(1), "status": batch.group(2)})
            status = re.search(r"status=(\w+)", line)
            if status and lotes:
                lotes[-1]["status"] = status.group(1)
            if self.contract.capture_marker in line:
                capturas.append(Path(line.split(self.contract.capture_marker, 1)[1].strip()).name)
            if "[FALHA]" in line:
                falha = line.split("[FALHA]", 1)[1].strip()
        return {"lotes": lotes, "capturas": capturas, "mensagem": falha}

    def _status_for(self, code: Optional[int], cancelled: bool) -> str:
        if code is None:
            return "cancelado" if cancelled else "interrompido"
        if code == 0:
            return "concluido"
        if cancelled or code == self.contract.exit_cancelled:
            return "cancelado"
        if code == self.contract.exit_busy:
            return "ocupada"
        return "falha"

    def _finish_record(
        self, path: Path, record: Dict[str, Any], code: Optional[int], log_path: Path, *, cancelled: bool = False,
    ) -> None:
        parsed = self._parse_log(log_path)
        status = self._status_for(code, cancelled)
        mensagem = parsed["mensagem"]
        if status == "interrompido":
            mensagem = mensagem or "O servidor foi reiniciado durante a execução; o resultado final não foi registrado."
        elif status == "ocupada":
            mensagem = mensagem or "Outra execução da automação estava em andamento."
        record.update(fim=_now_iso(self._now()), status=status, codigo=code, mensagem=mensagem,
                      lotes=parsed["lotes"], capturas=parsed["capturas"])
        try:
            _write_json(path, record)
        except OSError:
            logger.warning("Resumo da automação não gravado (%s).", path.name)

    def _prune_site_runs(self) -> None:
        for record in self._site_records()[:-SITE_RECORDS_KEPT]:
            stem = record.name[: -len(self.contract.site_record_suffix)]
            for path in (record, record.with_name(f"{stem}{self.contract.site_log_suffix}")):
                try:
                    path.unlink()
                except OSError:
                    pass

    def _wait_for_exit(self, run: _Run) -> None:
        assert run.process is not None
        code = run.process.wait()
        with self._lock:
            self._finish_run_locked(run, code)

    # ------------------------------------------------------------------ actions

    def start(self, rotina: str) -> Dict[str, Any]:
        if rotina not in ROUTINES:
            raise DomainError("Rotina inválida.", status_code=422)
        with self._lock:
            active = self._active_locked()
            if active is not None:
                raise DomainConflictError(self.busy_message(active))
            if not self.contract.script.is_file():
                raise DomainBusyError("O script da automação não foi encontrado em scripts/automacao_rotinas_chrome.py.")
            log_path = self._new_log_path(rotina)
            try:
                with log_path.open("wb") as output:
                    process = self._popen(
                        self._command(self.contract.routine_flag, rotina),
                        stdout=output,
                        stderr=subprocess.STDOUT,
                        **self._process_options(),
                    )
            except OSError as error:
                logger.warning("A automação não pôde ser iniciada (erro=%s).", type(error).__name__)
                raise DomainBusyError("Não foi possível iniciar a automação. Confira o ambiente Python do projeto.") from None
            run = _Run(rotina, _now_iso(self._now()), process.pid, log_path, self._record_path(log_path), process)
            _write_json(run.record_path, {
                "rotina": rotina, "inicio": run.inicio, "fim": None, "status": "em_andamento", "codigo": None,
                "mensagem": "", "pid": process.pid, "log": log_path.name, "origem": "site", "lotes": [], "capturas": [],
            })
            self._current = run
            self._prune_site_runs()
            if self._watch:
                threading.Thread(target=self._wait_for_exit, args=(run,), name="automacao-chrome", daemon=True).start()
        return self.state()

    def supports_cancel_flag(self) -> bool:
        """Whether the script's --help lists --cancelar; cached until the script changes."""
        try:
            mtime = self.contract.script.stat().st_mtime
        except OSError:
            return False
        if self._cancel_support and self._cancel_support[0] == mtime:
            return self._cancel_support[1]
        try:
            result = self._run_command(self._command("--help"), capture_output=True, text=True, encoding="utf-8",
                                       timeout=20, check=False, **self._process_options())
            supported = result.returncode == 0 and self.contract.cancel_flag in (result.stdout or "")
        except (OSError, subprocess.SubprocessError):
            supported = False
        self._cancel_support = (mtime, supported)
        return supported

    def cancel(self) -> Dict[str, Any]:
        with self._lock:
            active = self._active_locked()
            run = self._current if active and active["origem"] == "site" else None
        if active is None:
            raise DomainConflictError("Nenhuma rotina em andamento para cancelar.")
        if self.supports_cancel_flag():
            try:
                result = self._run_command(self._command(self.contract.cancel_flag), capture_output=True, text=True,
                                           encoding="utf-8", timeout=30, check=False, **self._process_options())
            except (OSError, subprocess.SubprocessError):
                raise DomainBusyError("Não foi possível pedir o cancelamento da automação.") from None
            if result.returncode != 0:
                raise DomainBusyError("O script recusou o pedido de cancelamento.")
            method = "sinal"
            message = "Cancelamento pedido. A rotina para no próximo ponto de espera; o Chrome continua aberto."
        elif run is not None and run.process is not None:
            # Only the Python child: Chrome on port 9333 was started detached and keeps the logins.
            run.process.terminate()
            method = "processo"
            message = "Rotina encerrada. O Chrome de automação continua aberto."
        else:
            raise DomainConflictError("A rotina foi iniciada fora do site; cancele na janela dela (Ctrl+C).")
        if run is not None:
            run.cancel_requested = True
        return {"metodo": method, "mensagem": message, "estado": self.state()}

    # ------------------------------------------------------------------ reading

    def _external_log(self, active: Dict[str, Any]) -> Optional[Path]:
        if not self.contract.log_dir.is_dir():
            return None
        logs = [path for path in self.contract.log_dir.glob(f"*_{active['rotina']}*.log")
                if not path.name.endswith(self.contract.site_log_suffix)]
        return max(logs, key=lambda path: path.name, default=None)

    def _login_wait(self, log_path: Optional[Path]) -> tuple[bool, str]:
        text = _read_tail(log_path, LOGIN_SCAN_BYTES)
        waiting_at = text.rfind(self.contract.login_wait_marker)
        if waiting_at < 0:
            return False, ""
        if any(text.rfind(marker) > waiting_at for marker in self.contract.login_done_markers):
            return False, ""
        line_start = text.rfind("\n", 0, waiting_at) + 1
        source = re.findall(r"\[([^\]]+)\]", text[line_start:waiting_at])
        return True, source[-1] if source else ""

    def state(self, offset: int = 0, arquivo: str = "") -> Dict[str, Any]:
        with self._lock:
            active = self._active_locked()
            run = self._current
        history = self.history(1)
        last = history[0] if history else None
        if active is not None and active["origem"] == "site" and run is not None:
            log_path: Optional[Path] = run.log_path
        elif active is not None:
            log_path = self._external_log(active)
        elif last and last.get("log"):
            log_path = self.contract.log_dir / str(last["log"])
        else:
            log_path = None
        if log_path is not None and arquivo and arquivo != log_path.name:
            offset = 0
        chunk = read_log_chunk(log_path, offset)
        if log_path is not None and arquivo and arquivo != log_path.name:
            chunk["reiniciado"] = True
        waiting, source = self._login_wait(log_path) if active is not None else (False, "")
        return {
            "estado": "em_andamento" if active else "livre",
            "rotina": active["rotina"] if active else "",
            "inicio": active["inicio"] if active else "",
            "origem": active["origem"] if active else "",
            "pid": active["pid"] if active else None,
            "cancelamento_pedido": bool(active and active["cancelamento_pedido"]),
            "aguardando_login": waiting,
            "login_origem": source,
            "log": chunk,
            "ultima": last,
        }

    def capture_path(self, name: str) -> Optional[Path]:
        if not CAPTURE_NAME_PATTERN.fullmatch(name):
            return None
        directory = self.contract.log_dir.resolve(strict=False)
        path = (directory / name).resolve(strict=False)
        if path.parent != directory or not path.is_file():
            return None
        return path

    def _capture_links(self, names: List[Any]) -> List[Dict[str, str]]:
        links = []
        seen = set()
        for value in names:
            name = Path(str(value)).name
            if name in seen or self.capture_path(name) is None:
                continue
            seen.add(name)
            links.append({"nome": name, "url": f"/api/automacao/capturas/{quote(name)}"})
        return links

    @staticmethod
    def _batches(values: Any) -> List[Dict[str, str]]:
        batches = []
        for value in values if isinstance(values, list) else []:
            if isinstance(value, dict):
                identifier = value.get("lote_id") or value.get("id") or ""
                batches.append({"id": str(identifier), "status": str(value.get("status") or value.get("estado") or "")})
            elif value:
                batches.append({"id": str(value), "status": ""})
        return batches

    def history(self, limit: Optional[int] = 15) -> List[Dict[str, Any]]:
        if not self.contract.log_dir.is_dir():
            return []
        site = []
        for path in self._site_records():
            record = _read_json(path)
            if record:
                site.append((path.name[: -len(self.contract.site_record_suffix)], record))
        script = []
        for path in sorted(self.contract.log_dir.glob("*.json")):
            if path.name.endswith(self.contract.site_record_suffix):
                continue
            record = _read_json(path)
            if record and record.get("rotina") in ROUTINES:
                script.append((path.stem, record))

        entries: List[Dict[str, Any]] = []
        for identifier, record in site:
            entries.append({**record, "id": identifier, "origem": "site"})
        for identifier, record in script:
            started = _parse_time(record.get("inicio"))
            twin = next((entry for entry in entries if entry["origem"] == "site"
                         and entry.get("rotina") == record.get("rotina")
                         and started is not None and (other := _parse_time(entry.get("inicio"))) is not None
                         and abs((other - started).total_seconds()) <= SAME_RUN_SECONDS), None)
            if twin is not None:
                # The script's own summary knows the batches and captures better than the stdout scan.
                twin["lotes"] = record.get("lotes") or twin.get("lotes")
                twin["capturas"] = [*(record.get("capturas") or []), *(twin.get("capturas") or [])]
                twin["mensagem"] = record.get("mensagem") or twin.get("mensagem")
                if twin.get("status") not in FINAL_STATUSES and record.get("status") in FINAL_STATUSES:
                    twin.update(status=record["status"], fim=record.get("fim"), codigo=record.get("codigo"))
                continue
            entries.append({**record, "id": identifier, "origem": "externo",
                            "log": Path(str(record.get("log") or "")).name})

        entries.sort(key=lambda entry: str(entry.get("inicio") or ""), reverse=True)
        result = []
        for entry in entries[:limit]:
            result.append({
                "id": entry["id"],
                "rotina": str(entry.get("rotina") or ""),
                "origem": entry["origem"],
                "inicio": entry.get("inicio") or "",
                "fim": entry.get("fim") or "",
                "status": str(entry.get("status") or ""),
                "codigo": entry.get("codigo"),
                "mensagem": str(entry.get("mensagem") or ""),
                "lotes": self._batches(entry.get("lotes")),
                "capturas": self._capture_links(list(entry.get("capturas") or [])),
                "log": str(entry.get("log") or ""),
            })
        return result

    def history_page(
        self, limit: int = 5, page: int = 1, *, start: Optional[date] = None,
        end: Optional[date] = None, routine: Optional[str] = None, status: Optional[str] = None,
    ) -> Dict[str, Any]:
        if start and end and start > end:
            raise DomainError("A data inicial deve ser anterior ou igual à data final.", status_code=422)
        entries = []
        for entry in self.history(None):
            timestamp = _parse_time(entry["inicio"])
            local_day = timestamp.astimezone().date() if timestamp else None
            if (start or end) and local_day is None:
                continue
            if local_day and ((start and local_day < start) or (end and local_day > end)):
                continue
            if routine and entry["rotina"] != routine:
                continue
            if status and entry["status"] != status:
                continue
            entries.append(entry)
        limit = max(1, min(limit, 50))
        pages = max(1, (len(entries) + limit - 1) // limit)
        page = max(1, min(page, pages))
        offset = (page - 1) * limit
        return {"execucoes": entries[offset:offset + limit], "total": len(entries),
                "pagina": page, "paginas": pages, "limite": limit}

    def execution_log(self, identifier: str, lines: int = 200) -> Dict[str, Any]:
        entry = next((item for item in self.history(None) if item["id"] == identifier), None)
        if entry is None:
            raise DomainError("Execução não encontrada.", status_code=404)
        directory = self.contract.log_dir.resolve(strict=False)
        name = str(entry["log"])
        path = (directory / name).resolve(strict=False)
        if Path(name).name != name or path.parent != directory or path.suffix != ".log" or not path.is_file():
            raise DomainError("Log desta execução não está disponível.", status_code=404)
        try:
            with path.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                start = max(0, size - MAX_LOG_CHUNK_BYTES)
                handle.seek(start)
                raw = handle.read(MAX_LOG_CHUNK_BYTES)
                if start:
                    raw = raw.partition(b"\n")[2]
                text = raw.decode("utf-8", errors="replace")
        except OSError:
            raise DomainError("Não foi possível ler o log desta execução.", status_code=503) from None
        content = text.splitlines()
        limit = max(1, min(lines, 500))
        return {"execucao": entry, "arquivo": name, "linhas": content[-limit:],
                "limitado": size > MAX_LOG_CHUNK_BYTES or len(content) > limit}
