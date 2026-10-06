from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "catalog.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(Path(__file__).with_name("schema.sql").read_text(encoding="utf-8"))
        if "active" not in {row[1] for row in self.db.execute("PRAGMA table_info(asset_jobs)")}:
            self.db.execute("ALTER TABLE asset_jobs ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
            self.db.commit()

    def close(self):
        self.db.close()

    def start_run(self, command: str) -> int:
        cursor = self.db.execute("INSERT INTO crawl_runs(command,started_at) VALUES (?,?)", (command, now()))
        self.db.commit()
        return cursor.lastrowid

    def finish_run(self, run_id: int, status: str, summary: dict, error: str | None = None):
        self.db.execute("UPDATE crawl_runs SET finished_at=?,status=?,summary_json=?,error=? WHERE id=?",
                        (now(), status, dumps(summary), error, run_id))
        self.db.commit()

    def upsert_document(self, doc: dict, *, refresh: bool = False):
        existing = self.db.execute("SELECT * FROM documents WHERE id=?", (doc["id"],)).fetchone()
        categories = sorted(set(doc["categories"]) | (set(json.loads(existing["categories_json"])) if existing else set()))
        metadata = dict(json.loads(existing["metadata_json"])) if existing else {}
        topics = {str(item.get("topic_id")): item for item in metadata.get("topics", []) if item.get("topic_id")}
        incoming_metadata = doc.get("metadata", {})
        if incoming_metadata.get("topic_id"):
            topics[str(incoming_metadata["topic_id"])] = {
                "topic_id": str(incoming_metadata["topic_id"]),
                "label": incoming_metadata.get("sous_theme", ""),
                "source_url": doc["source_url"],
            }
        metadata.update(incoming_metadata)
        metadata["topics"] = sorted(topics.values(), key=lambda item: (item["topic_id"], item["label"]))
        listings = set(metadata.get("source_listings", []))
        listings.add(doc["source_url"])
        metadata["source_listings"] = sorted(listings)
        stamp = now()
        self.db.execute("""INSERT INTO documents
            (id,source_id,title,category,categories_json,text_type,number,date,source_url,legal_status,
             notes,metadata_json,discovered_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,categories_json=excluded.categories_json,
             category=excluded.category,text_type=excluded.text_type,number=excluded.number,date=excluded.date,
             legal_status=excluded.legal_status,notes=excluded.notes,metadata_json=excluded.metadata_json,
             updated_at=excluded.updated_at""",
            (doc["id"], str(doc["source_id"]), doc["title"], categories[0], dumps(categories),
             doc.get("type"), doc.get("number"), doc.get("date"), doc["source_url"],
             doc.get("legal_status") or "unknown", doc.get("notes"), dumps(metadata), stamp, stamp))
        active_jobs = set()
        for asset in doc.get("assets", []):
            url = asset.get("url") or doc["source_url"]
            # Le fragment inline est identifié par document/langue, pas par la page de catalogue.
            job_id = digest(dumps([doc["id"], asset["language"], asset["kind"], asset.get("url") or "inline"]))
            active_jobs.add(job_id)
            previous = self.db.execute("SELECT * FROM asset_jobs WHERE id=?", (job_id,)).fetchone()
            changed = previous is not None and previous["inline_html"] != asset.get("html")
            status = "pending" if refresh or changed or previous is None or not previous["active"] else previous["status"]
            if changed and previous["version_id"]:
                self.db.execute("UPDATE document_versions SET is_current=0 WHERE id=?", (previous["version_id"],))
            self.db.execute("""INSERT INTO asset_jobs
                (id,document_id,language,kind,source_url,inline_html,status,updated_at) VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET inline_html=excluded.inline_html,
                  source_url=excluded.source_url,status=excluded.status,active=1,updated_at=excluded.updated_at""",
                (job_id, doc["id"], asset["language"], asset["kind"], url, asset.get("html"), status, stamp))
        # Un fichier retiré du catalogue reste conservé comme historique, sans export courant.
        if active_jobs:
            for prior in self.db.execute("SELECT id,version_id FROM asset_jobs WHERE document_id=?", (doc["id"],)).fetchall():
                if prior["id"] not in active_jobs:
                    self.db.execute("UPDATE asset_jobs SET active=0 WHERE id=?", (prior["id"],))
                    if prior["version_id"]:
                        self.db.execute("UPDATE document_versions SET is_current=0 WHERE id=?", (prior["version_id"],))
        self.db.commit()

    def jobs(self, limit: int | None = None, *, refresh=False, ocr=False,
             language: str | None = None) -> list[sqlite3.Row]:
        where = "1=1" if refresh else "a.status IN ('pending','error')"
        if ocr and not refresh:
            where += " OR v.extraction_status IN ('needs_ocr','partial')"
        params = ()
        language_filter = ""
        if language is not None:
            language_filter = " AND a.language=?"
            params = (language,)
        query = f"""SELECT a.*,d.legal_status FROM asset_jobs a
            JOIN documents d ON a.document_id=d.id LEFT JOIN document_versions v ON a.version_id=v.id
            WHERE a.active=1 AND ({where}){language_filter}
            ORDER BY CASE WHEN d.text_type='Loi' THEN 0 ELSE 1 END,
            substr(d.date,7,4)||substr(d.date,4,2)||substr(d.date,1,2) DESC,a.document_id,a.language"""
        if limit is not None:
            query += " LIMIT ?"
            params += (limit,)
        return self.db.execute(query, params).fetchall()

    def record_error(self, job: sqlite3.Row, error: str):
        self.db.execute("UPDATE asset_jobs SET status='error',attempts=attempts+1,last_error=?,updated_at=? WHERE id=?",
                        (error[:2000], now(), job["id"]))
        self.db.commit()

    def save_version(self, job: sqlite3.Row, *, sha: str, raw_key: str, extraction: dict,
                     chunks: list[dict]) -> str:
        version_id = digest(dumps([job["document_id"], job["language"], job["source_url"], sha]))
        text_key = f"text/{version_id}.json"
        text_path = self.root / text_key
        text_path.parent.mkdir(parents=True, exist_ok=True)
        text_path.write_text(dumps(extraction) + "\n", encoding="utf-8")
        stamp = now()
        with self.db:
            self.db.execute("UPDATE document_versions SET is_current=0 WHERE document_id=? AND language=? AND source_url=?",
                            (job["document_id"], job["language"], job["source_url"]))
            self.db.execute("""INSERT INTO document_versions
                (id,document_id,language,source_url,source_sha256,raw_key,text_key,fetched_at,legal_status,
                 extraction_status,page_count,text_chars,warnings_json,is_current)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
                 extraction_status=excluded.extraction_status,page_count=excluded.page_count,
                 text_chars=excluded.text_chars,warnings_json=excluded.warnings_json,
                 fetched_at=excluded.fetched_at,legal_status=excluded.legal_status,is_current=1""",
                (version_id, job["document_id"], job["language"], job["source_url"], sha, raw_key, text_key,
                 stamp, job["legal_status"], extraction["status"], extraction["page_count"],
                 extraction["text_chars"], dumps(extraction["warnings"])))
            self.db.execute("DELETE FROM chunks WHERE version_id=?", (version_id,))
            for chunk in chunks:
                text_sha = digest(chunk["text"])
                chunk_id = digest(dumps([version_id, chunk["ordinal"], text_sha]))
                self.db.execute("""INSERT INTO chunks
                    (id,document_id,version_id,ordinal,text,text_sha256,article,page_start,page_end)
                    VALUES (?,?,?,?,?,?,?,?,?)""", (chunk_id, job["document_id"], version_id,
                    chunk["ordinal"], chunk["text"], text_sha, chunk["article"], chunk["page_start"], chunk["page_end"]))
            job_status = "error" if extraction["status"] == "error" else "complete"
            last_error = dumps(extraction["warnings"]) if extraction["status"] == "error" else None
            self.db.execute("""UPDATE asset_jobs SET status=?,attempts=attempts+1,
                last_error=?,version_id=?,updated_at=? WHERE id=?""",
                (job_status, last_error, version_id, stamp, job["id"]))
        return version_id

    def status(self) -> dict:
        def groups(table, field, where=""):
            return {r[0]: r[1] for r in self.db.execute(f"SELECT {field},COUNT(*) FROM {table} {where} GROUP BY {field}")}
        return {
            "documents": self.db.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
            "reference_only": self.db.execute("SELECT COUNT(*) FROM documents d WHERE NOT EXISTS (SELECT 1 FROM asset_jobs a WHERE a.document_id=d.id)").fetchone()[0],
            "jobs": groups("asset_jobs", "status"),
            "current_extractions": groups("document_versions", "extraction_status", "WHERE is_current=1"),
            "chunks_stored": self.db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0],
            "last_runs": [dict(r) for r in self.db.execute("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 5")],
        }
