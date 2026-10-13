"""Failure and isolation checks without Docker, PostgreSQL or real workbooks."""

import hashlib
import importlib.util
import unittest

from persistence.config import PersistenceError,PersistenceSettings
if importlib.util.find_spec("httpx") is not None:
    import httpx
    from persistence.storage import LocalStorage,BUCKET
else:
    httpx = None


@unittest.skipUnless(httpx is not None,"optional Storage dependencies not installed")
class PrivateStorageTests(unittest.TestCase):
    def descriptor(self, content=b"synthetic"):
        sha = hashlib.sha256(content).hexdigest()
        return {"chave":"00000000-0000-0000-0000-000000000001/detalhes-"+sha,
                "sha256":sha,"tamanho_bytes":len(content),"mime_type":"application/octet-stream"}

    def test_private_bucket_refuses_existing_public_bucket(self):
        storage = LocalStorage("test-only",transport=httpx.MockTransport(lambda r:httpx.Response(200,json={"id":BUCKET,"public":True})))
        self.addCleanup(storage.close)
        with self.assertRaises(PersistenceError):
            storage.ensure_private_bucket()

    def test_duplicate_upload_requires_hash_and_size_match(self):
        calls = []
        def request(r):
            calls.append(r)
            return httpx.Response(409) if r.method == "POST" else httpx.Response(200,content=b"synthetic")
        storage = LocalStorage("test-only",transport=httpx.MockTransport(request))
        self.addCleanup(storage.close)
        storage.put(self.descriptor(),b"synthetic")
        self.assertEqual([c.method for c in calls],["POST","GET"])
        self.assertEqual(calls[0].headers["x-upsert"],"false")

    def test_corrupt_download_is_never_accepted(self):
        storage = LocalStorage("test-only",transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b"corruption")))
        self.addCleanup(storage.close)
        with self.assertRaises(PersistenceError):
            storage.get(self.descriptor())

    def test_unknown_object_path_is_rejected_before_network(self):
        storage = LocalStorage("test-only",transport=httpx.MockTransport(lambda r:self.fail("network called")))
        self.addCleanup(storage.close)
        for key in ("../foreign", "https://example.org", "other-project/path"):
            with self.subTest(key=key),self.assertRaises(PersistenceError):
                storage.get({**self.descriptor(),"chave":key})

    def test_network_error_does_not_echo_credentials(self):
        def fail(r):
            raise httpx.ConnectError("synthetic-secret",request=r)
        storage = LocalStorage("synthetic-secret",transport=httpx.MockTransport(fail))
        self.addCleanup(storage.close)
        with self.assertRaises(PersistenceError) as caught:
            storage.get(self.descriptor())
        self.assertNotIn("synthetic-secret",str(caught.exception))

    def test_delete_retry_accepts_already_absent_object(self):
        storage = LocalStorage("test-only",transport=httpx.MockTransport(lambda r:httpx.Response(404)))
        self.addCleanup(storage.close)
        storage.delete(self.descriptor())

    def test_absent_object_with_storage_400_envelope_is_retryable(self):
        storage = LocalStorage("test-only",transport=httpx.MockTransport(lambda r:httpx.Response(400,json={"statusCode":"404"})))
        self.addCleanup(storage.close)
        self.assertIsNone(storage.get(self.descriptor(),missing_ok=True))
        storage.delete(self.descriptor())

    def test_storage_key_stays_out_of_config_repr(self):
        settings = PersistenceSettings("postgres","synthetic-dsn",2,"synthetic-secret")
        self.assertNotIn("synthetic-secret",repr(settings))
        self.assertNotIn("synthetic-dsn",repr(settings))


if __name__ == "__main__":
    unittest.main()
