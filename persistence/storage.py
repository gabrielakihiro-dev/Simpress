"""Private, immutable objects in the checked loopback Supabase stack."""

import hashlib
import re

import httpx

from persistence.config import PersistenceError

BUCKET = "simpress-pilot"
MAX_BYTES = 64 * 1024 * 1024
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class LocalStorage:
    def __init__(self, key, *, transport=None):
        if not key or not key.isascii() or any(c.isspace() for c in key):
            raise PersistenceError(503, "Configure a credencial de Storage somente no servidor local.")
        self.client = httpx.Client(base_url="http://127.0.0.1:54321/storage/v1/",
            headers={"apikey": key, "Authorization": "Bearer " + key},
            trust_env=False, follow_redirects=False, timeout=30, transport=transport)

    def close(self):
        self.client.close()

    @staticmethod
    def not_found(response):
        if response.status_code == 404:
            return True
        try:
            return response.status_code == 400 and str(response.json().get("statusCode")) == "404"
        except (ValueError,AttributeError):
            return False

    def request(self, method, path, **kwargs):
        try:
            response = self.client.request(method, path, **kwargs)
        except httpx.HTTPError:
            raise PersistenceError(503, "Storage local indisponível; a operação permanece recuperável.") from None
        return response

    def ensure_private_bucket(self):
        response = self.request("GET", "bucket/" + BUCKET)
        if self.not_found(response):
            created = self.request("POST", "bucket", json={"id": BUCKET, "name": BUCKET,
                "public": False, "file_size_limit": MAX_BYTES})
            if created.status_code not in (200, 201, 400, 409):
                raise PersistenceError(503, "Não foi possível preparar o bucket privado local.")
            response = self.request("GET", "bucket/" + BUCKET)
        try:
            bucket = response.json()
            valid = response.status_code == 200 and bucket["id"] == BUCKET and bucket["public"] is False
        except (ValueError, KeyError, TypeError):
            valid = False
        if not valid:
            raise PersistenceError(503, "O bucket do piloto está ausente ou não é privado.")

    @staticmethod
    def path(key):
        if not re.fullmatch(r"[0-9a-f-]{36}/[a-z_]+-[0-9a-f]{64}", key):
            raise PersistenceError(409, "Referência de objeto inválida para o piloto local.")
        return "object/" + BUCKET + "/" + key

    def get(self, descriptor, *, missing_ok=False):
        response = self.request("GET", self.path(descriptor["chave"]))
        if self.not_found(response) and missing_ok:
            return None
        if response.status_code != 200:
            raise PersistenceError(503, "O objeto privado não está disponível no Storage local.")
        data = response.content
        if len(data) != descriptor["tamanho_bytes"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
            raise PersistenceError(409, "O conteúdo do objeto não confere com seu hash e tamanho registrados.")
        return data

    def put(self, descriptor, data):
        if len(data) > MAX_BYTES or len(data) != descriptor["tamanho_bytes"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
            raise PersistenceError(409, "O arquivo preparado difere do manifesto da operação.")
        response = self.request("POST", self.path(descriptor["chave"]), content=data,
            headers={"Content-Type": descriptor["mime_type"], "x-upsert": "false"})
        if response.status_code not in (200, 201, 400, 409):
            raise PersistenceError(503, "Upload incompleto; repita o pedido com a mesma Idempotency-Key.")
        # A duplicate response (including Storage's 400 ResourceAlreadyExists)
        # never implies success: verify the actual object byte for byte.
        self.get(descriptor)

    def delete(self, descriptor):
        response = self.request("DELETE", self.path(descriptor["chave"]))
        if response.status_code not in (200, 204) and not self.not_found(response):
            raise PersistenceError(503, "Exclusão pendente no Storage; nenhuma referência foi removida.")
        if self.get(descriptor, missing_ok=True) is not None:
            raise PersistenceError(503, "A exclusão do objeto ainda não foi confirmada.")
