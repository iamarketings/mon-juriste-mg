import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from monjuris.export import abrogated, export_corpus
from monjuris.pipeline import fetch_assets
from monjuris.store import Store


def doc(identifier="1", state="unknown", category="DROIT CIVIL"):
    return {"id": f"cnlegis:{identifier}", "source_id": identifier, "title": "Texte de test",
        "type": "Loi", "number": "2024-001", "date": "01-01-2024", "legal_status": state,
        "categories": [category], "source_url": "https://cnlegis.gov.mg/page_data_liste_docs_filter/1/",
        "metadata": {}, "assets": [{"language": "fr", "kind": "html", "html": "<p>texte</p>"}]}


class StoreExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def save(self, job, sha="a" * 64, status="ready"):
        return self.store.save_version(job, sha=sha, raw_key=f"raw/{sha}.html",
            extraction={"status": status, "pages": [{"page": 1, "text": "Article 1 - Texte"}],
                "page_count": 1, "text_chars": 16, "warnings": []},
            chunks=[{"ordinal": 1, "text": "Article 1 - Texte", "article": "Article 1", "page_start": 1, "page_end": 1}])

    def test_duplicate_categories_and_unchanged_discovery_keep_completed_jobs(self):
        self.store.upsert_document(doc())
        self.save(self.store.jobs()[0])
        self.store.upsert_document(doc(category="DROIT COMMERCIAL"))
        self.assertEqual(self.store.jobs(), [])
        row = self.store.db.execute("SELECT * FROM documents").fetchone()
        self.assertEqual(set(json.loads(row["categories_json"])), {"DROIT CIVIL", "DROIT COMMERCIAL"})

    def test_versions_and_chunks_are_idempotent_and_keep_history(self):
        self.store.upsert_document(doc())
        job = self.store.jobs()[0]
        first = self.save(job)
        self.assertEqual(first, self.save(job))
        second = self.save(job, sha="b" * 64)
        self.assertNotEqual(first, second)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], 2)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM document_versions WHERE is_current=1").fetchone()[0], 1)

    def test_export_excludes_partial_and_abrogated_but_keeps_catalog(self):
        for identifier, state, status in (("1", "unknown", "ready"), ("2", "Abrogé", "ready"), ("3", "En vigueur", "partial")):
            self.store.upsert_document(doc(identifier, state))
            job = next(r for r in self.store.jobs() if r["document_id"] == f"cnlegis:{identifier}")
            self.save(job, status=status)
        target = Path(self.temp.name) / "out"
        counts = export_corpus(self.store, target)["counts"]
        self.assertEqual(counts, {"documents": 3, "versions": 3, "chunks": 1})
        chunk = json.loads((target / "chunks.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(chunk["legal_status"], "unknown")
        self.assertEqual(len(chunk["id"]), 64)
        self.assertEqual(export_corpus(self.store, target, include_abrogated=True)["counts"]["chunks"], 2)

    def test_d1_sql_import_and_repeat(self):
        self.store.upsert_document(doc())
        self.save(self.store.jobs()[0])
        target = Path(self.temp.name) / "out"
        export_corpus(self.store, target, d1_sql=True)
        db = sqlite3.connect(":memory:")
        try:
            for _ in range(2):
                for sql in sorted((target / "d1").glob("*.sql")):
                    db.executescript(sql.read_text(encoding="utf-8"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0], 1)
        finally:
            db.close()

    def test_failed_job_is_resumable(self):
        self.store.upsert_document(doc())
        self.store.record_error(self.store.jobs()[0], "Temporary timeout")
        self.assertEqual(len(self.store.jobs()), 1)
        self.save(self.store.jobs()[0])
        self.assertEqual(self.store.jobs(), [])

    def test_jobs_can_be_filtered_by_language(self):
        value = doc()
        value["assets"].append({"language": "mg", "kind": "html", "html": "<p>lahatsoratra</p>"})
        self.store.upsert_document(value)
        self.assertEqual([row["language"] for row in self.store.jobs(language="fr")], ["fr"])
        self.assertEqual([row["language"] for row in self.store.jobs(language="mg")], ["mg"])

    def test_updated_inline_text_requires_fetch(self):
        value = doc()
        self.store.upsert_document(value)
        self.save(self.store.jobs()[0])
        value["assets"][0]["html"] = "<p>nouveau texte</p>"
        self.store.upsert_document(value)
        self.assertEqual(len(self.store.jobs()), 1)

    def test_metadata_only_duplicate_does_not_retire_a_real_asset(self):
        value = doc()
        self.store.upsert_document(value)
        self.save(self.store.jobs()[0])
        value["assets"] = []
        value["categories"] = ["DROIT COMMERCIAL"]
        self.store.upsert_document(value)
        self.assertEqual(self.store.db.execute("SELECT active FROM asset_jobs").fetchone()[0], 1)
        self.assertEqual(self.store.db.execute("SELECT is_current FROM document_versions").fetchone()[0], 1)

    def test_updated_inline_text_creates_a_new_current_version(self):
        class NoNetwork:
            def get_bytes(self, _url):
                raise AssertionError("inline HTML must not use the network")

        config = {"chunk_max_chars": 1800, "chunk_overlap_chars": 200}
        value = doc()
        value["assets"][0]["html"] = "<article><h1>Loi</h1><p>Article 1 - " + ("ancien texte juridique " * 40) + "</p></article>"
        self.store.upsert_document(value)
        first = fetch_assets(self.store, NoNetwork(), config)
        self.assertEqual(first["ready"], 1)
        first_id = self.store.db.execute("SELECT id FROM document_versions WHERE is_current=1").fetchone()[0]

        value["assets"][0]["html"] = "<article><h1>Loi</h1><p>Article 1 - " + ("nouveau texte juridique " * 40) + "</p></article>"
        self.store.upsert_document(value)
        second = fetch_assets(self.store, NoNetwork(), config)
        self.assertEqual(second["ready"], 1)
        current = self.store.db.execute("SELECT id,text_key FROM document_versions WHERE is_current=1").fetchone()
        self.assertNotEqual(first_id, current["id"])
        self.assertIn("nouveau texte", (self.store.root / current["text_key"]).read_text(encoding="utf-8"))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM document_versions WHERE is_current=1").fetchone()[0], 1)

    def test_extraction_error_stays_resumable(self):
        self.store.upsert_document(doc())
        job = self.store.jobs()[0]
        self.store.save_version(job, sha="c" * 64, raw_key="raw/missing.html",
            extraction={"status": "error", "pages": [], "page_count": 0, "text_chars": 0,
                "warnings": ["invalid"]}, chunks=[])
        self.assertEqual(len(self.store.jobs()), 1)

    def test_abrogated_is_accent_independent(self):
        self.assertTrue(abrogated("ABROGÉ"))
        self.assertFalse(abrogated("En vigueur"))


if __name__ == "__main__":
    unittest.main()
