from __future__ import annotations

import json
import unicodedata
from pathlib import Path

from .store import Store, dumps, now, digest


def abrogated(status: str) -> bool:
    normalized = "".join(c for c in unicodedata.normalize("NFD", status.lower()) if not unicodedata.combining(c))
    return any(term in normalized for term in ("abrog", "annul", "caduc"))


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def export_corpus(store: Store, target: Path, *, include_abrogated=False, d1_sql=False) -> dict:
    target.mkdir(parents=True, exist_ok=True)
    documents = []
    for row in store.db.execute("SELECT * FROM documents ORDER BY id"):
        doc = dict(row)
        doc["categories"] = json.loads(doc.pop("categories_json"))
        doc["metadata"] = json.loads(doc.pop("metadata_json"))
        documents.append(doc)
    versions = []
    for row in store.db.execute("SELECT * FROM document_versions ORDER BY id"):
        version = dict(row)
        version["warnings"] = json.loads(version.pop("warnings_json"))
        version["is_current"] = bool(version["is_current"])
        versions.append(version)
    chunks = []
    for row in store.db.execute("""SELECT c.*,v.language,v.source_url,v.fetched_at,v.source_sha256,
        v.extraction_status,v.legal_status,d.title,d.number,d.date,d.categories_json,
        d.legal_status AS catalog_legal_status FROM chunks c JOIN document_versions v ON c.version_id=v.id
        JOIN documents d ON c.document_id=d.id WHERE v.is_current=1 AND v.extraction_status='ready'
        ORDER BY c.document_id,v.language,c.ordinal"""):
        chunk = dict(row)
        if not include_abrogated and (abrogated(chunk["legal_status"]) or abrogated(chunk["catalog_legal_status"])):
            continue
        chunk["categories"] = json.loads(chunk.pop("categories_json"))
        chunks.append(chunk)
    counts = {}
    files = {}
    for name, records in (("documents", documents), ("versions", versions), ("chunks", chunks)):
        path = target / f"{name}.jsonl"
        with path.open("w", encoding="utf-8", newline="\n") as stream:
            for record in records:
                stream.write(dumps(record) + "\n")
        counts[name] = len(records)
        files[path.name] = {"sha256": digest(path.read_bytes()), "bytes": path.stat().st_size}
    quality = {
        "asset_errors": [dict(r) for r in store.db.execute("SELECT document_id,language,source_url,last_error FROM asset_jobs WHERE status='error'")],
        "not_ready": [v for v in versions if v["is_current"] and v["extraction_status"] != "ready"],
        "reference_only": [dict(r) for r in store.db.execute("SELECT id,title,source_url FROM documents d WHERE NOT EXISTS (SELECT 1 FROM asset_jobs a WHERE a.document_id=d.id)")],
    }
    (target / "quality.json").write_text(dumps(quality) + "\n", encoding="utf-8")
    last_discovery = store.db.execute("SELECT * FROM crawl_runs WHERE command='discover' ORDER BY id DESC LIMIT 1").fetchone()
    manifest = {"schema_version": 1, "generated_at": now(), "source": "https://cnlegis.gov.mg/",
        "counts": counts, "files": files, "catalog_complete": bool(last_discovery and last_discovery["status"] == "complete"),
        "include_abrogated": include_abrogated,
        "eligibility": "current version, extraction ready, non-abrogated unless explicitly included",
        "legal_validity": "Source status only; no legal consolidation or applicability verification",
        "status": store.status()}
    if d1_sql:
        manifest["d1_files"] = export_d1(store, target / "d1", chunk_ids={c["id"] for c in chunks})
    (target / "manifest.json").write_text(dumps(manifest) + "\n", encoding="utf-8")
    return {"counts": counts, "catalog_complete": manifest["catalog_complete"], "target": str(target.resolve())}


def export_d1(store: Store, target: Path, *, chunk_ids: set[str]) -> list[str]:
    """Imports de données séparés du schéma, requêtes <100KB et fichiers <4MiB."""
    target.mkdir(parents=True, exist_ok=True)
    # Retirer seulement les fichiers générés connus pour qu'un ancien lot ne soit pas réimporté.
    import re
    for path in target.iterdir():
        if path.is_file() and re.fullmatch(r"\d{3,}-(?:schema|data)\.sql", path.name):
            path.unlink()
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    (target / "000-schema.sql").write_text(schema, encoding="utf-8")
    names = ["000-schema.sql"]
    statements = []
    batch_bytes = 0
    part = 1

    def flush():
        nonlocal statements, batch_bytes, part
        if not statements:
            return
        name = f"{part:03d}-data.sql"
        (target / name).write_text("\n".join(statements) + "\n", encoding="utf-8")
        names.append(name)
        part += 1
        statements = []
        batch_bytes = 0

    # Pas d'inline HTML dans D1 : originaux et texte complet vont dans R2.
    for table in ("documents", "document_versions", "chunks"):
        for row in store.db.execute(f"SELECT * FROM {table} ORDER BY id"):
            record = dict(row)
            if table == "chunks" and record["id"] not in chunk_ids:
                continue
            keys = list(record)
            statement = f"INSERT OR REPLACE INTO {table} ({','.join(keys)}) VALUES ({','.join(sql_literal(record[k]) for k in keys)});"
            size = len(statement.encode("utf-8"))
            if size > 95_000:
                raise ValueError(f"Enregistrement trop grand pour D1 SQL : {table} {record['id']}. Utiliser JSONL/R2.")
            if batch_bytes + size > 4_000_000:
                flush()
            statements.append(statement)
            batch_bytes += size + 1
    flush()
    return names
