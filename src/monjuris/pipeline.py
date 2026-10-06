from __future__ import annotations

import logging
from pathlib import Path

from .extract import chunk_pages, extract_document
from .http import PoliteClient
from .store import Store, digest

LOG = logging.getLogger(__name__)


def fetch_assets(store: Store, client: PoliteClient, config: dict, *, limit: int | None = None,
                 refresh: bool = False, ocr: str = "none", ocr_languages: str = "fra",
                 language: str | None = None) -> dict:
    result = {"attempted": 0, "ready": 0, "needs_ocr": 0, "partial": 0, "empty": 0, "error": 0}
    for job in store.jobs(limit, refresh=refresh, ocr=ocr != "none", language=language):
        result["attempted"] += 1
        try:
            # Une reprise OCR réutilise le binaire déjà conservé, sans téléchargement.
            previous = store.db.execute("SELECT * FROM document_versions WHERE id=?", (job["version_id"],)).fetchone()
            reuse_raw = (previous and not refresh and (store.root / previous["raw_key"]).exists()
                and (job["inline_html"] is None or digest(job["inline_html"]) == previous["source_sha256"]))
            if reuse_raw:
                raw_key = previous["raw_key"]
                raw_path = store.root / raw_key
                body = raw_path.read_bytes()
            else:
                body = job["inline_html"].encode("utf-8") if job["inline_html"] is not None else client.get_bytes(job["source_url"])
                if job["kind"] == "pdf" and b"%PDF-" not in body[:1024]:
                    raise ValueError("La source annoncée comme PDF ne renvoie pas un fichier PDF")
                raw_key = f"raw/{digest(body)}.{job['kind']}"
                raw_path = store.root / raw_key
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                if not raw_path.exists():
                    temporary = raw_path.with_suffix(raw_path.suffix + ".part")
                    temporary.write_bytes(body)
                    temporary.replace(raw_path)
            extraction = extract_document(raw_path, job["kind"])
            if ocr == "tesseract" and job["kind"] == "pdf" and extraction["status"] in ("needs_ocr", "partial", "error"):
                from .extract import ocr_document
                # Le malgache dépend des langues Tesseract disponibles ; choix explicite par CLI.
                extraction = ocr_document(raw_path, languages=ocr_languages)
            chunks = chunk_pages(extraction["pages"], max_chars=config["chunk_max_chars"],
                                 overlap_chars=config["chunk_overlap_chars"]) if extraction["status"] in ("ready", "partial") else []
            store.save_version(job, sha=digest(body), raw_key=raw_key, extraction=extraction, chunks=chunks)
            result[extraction["status"]] += 1
            LOG.info("%s %s %s (%s caractères)", job["document_id"], job["language"], extraction["status"], extraction["text_chars"])
        except Exception as exc:
            store.record_error(job, f"{type(exc).__name__}: {exc}")
            result["error"] += 1
            LOG.warning("%s %s : %s", job["document_id"], job["language"], exc)
    return result
