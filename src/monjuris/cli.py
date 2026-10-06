from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from .export import export_corpus
from .http import PoliteClient
from .pipeline import fetch_assets
from .store import Store


def positive_int(value):
    value = int(value)
    if value <= 0:
        raise argparse.ArgumentTypeError("La limite doit être strictement positive")
    return value


def load_config(path: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    if not config.get("themes") or not config.get("languages"):
        raise ValueError("Le périmètre doit préciser themes et languages")
    if not set(config["languages"]) <= {"fr", "mg"}:
        raise ValueError("Langues prises en charge : fr, mg")
    if not 1 <= config["page_size"] <= 100:
        raise ValueError("page_size doit être entre 1 et 100")
    if config["chunk_max_chars"] <= config["chunk_overlap_chars"] or config["chunk_overlap_chars"] < 0:
        raise ValueError("chunk_overlap_chars doit être positif et inférieur à chunk_max_chars")
    return config


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Collecte CNLEGIS locale : catalogue, originaux, texte, exports RAG.")
    parser.add_argument("--config", type=Path, default=Path("config/scope.json"))
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("discover", "fetch", "run"):
        action = sub.add_parser(command)
        action.add_argument("--refresh", action="store_true", help="Réobserver les sources et vérifier les changements de fichiers")
        if command in ("discover", "run"):
            action.add_argument("--limit-documents", type=positive_int, help="Essai borné ; le catalogue sera marqué incomplet")
        if command in ("fetch", "run"):
            action.add_argument("--limit-assets", type=positive_int, help="Nombre maximal de fichiers/versions linguistiques traités")
            action.add_argument("--ocr", choices=("none", "tesseract"), default="none")
            action.add_argument("--ocr-languages", default="fra", help="Langues Tesseract installées, ex. fra ou fra+eng")
            action.add_argument("--language", choices=("fr", "mg"), help="Limiter les versions traitées à une langue")
    action = sub.add_parser("export")
    action.add_argument("--output", type=Path)
    action.add_argument("--include-abrogated", action="store_true")
    action.add_argument("--d1-sql", action="store_true")
    sub.add_parser("status")
    action = sub.add_parser("search", help="Inspection locale du texte, sans modèle ni embeddings")
    action.add_argument("query")
    action.add_argument("--limit", type=positive_int, default=10)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    store = None
    client = None
    run_id = None
    result = {}
    try:
        config = load_config(args.config)
        store = Store(args.data)
        if args.command in ("discover", "fetch", "run"):
            client = PoliteClient(delay=config["delay_seconds"], timeout=config["timeout_seconds"],
                                  max_download_mb=config["max_download_mb"])
        if args.command in ("discover", "run"):
            from .source import CNLegisSource
            run_id = store.start_run("discover")
            source = CNLegisSource(client)
            seen = set()
            for doc in source.discover(config, limit=args.limit_documents):
                store.upsert_document(doc, refresh=args.refresh)
                seen.add(doc["id"])
                logging.info("Catalogue : %s (%s documents uniques)", doc["id"], len(seen))
            # Une limite demandée reste un essai borné, même si elle dépasse le volume actuel.
            result["discovery"] = {"documents_seen": len(seen), "bounded": args.limit_documents is not None}
            store.finish_run(run_id, "bounded" if args.limit_documents else "complete", result["discovery"])
            run_id = None
        if args.command in ("fetch", "run"):
            run_id = store.start_run("fetch")
            result["fetch"] = fetch_assets(store, client, config, limit=args.limit_assets,
                refresh=args.refresh, ocr=args.ocr, ocr_languages=args.ocr_languages,
                language=args.language)
            store.finish_run(run_id, "errors" if result["fetch"]["error"] else "complete", result["fetch"])
            run_id = None
        if args.command in ("export", "run"):
            result["export"] = export_corpus(store, getattr(args, "output", None) or store.root / "exports",
                include_abrogated=getattr(args, "include_abrogated", False), d1_sql=getattr(args, "d1_sql", False))
        if args.command == "search":
            from .export import abrogated
            rows = store.db.execute("""SELECT c.document_id,c.article,c.page_start,c.page_end,c.text,
                d.title,d.legal_status,v.source_url FROM chunks c JOIN document_versions v ON c.version_id=v.id
                JOIN documents d ON d.id=c.document_id WHERE v.is_current=1 AND v.extraction_status='ready'
                AND instr(lower(c.text),lower(?)) > 0 ORDER BY c.document_id,c.ordinal""", (args.query,))
            result["matches"] = []
            for row in rows:
                if abrogated(row["legal_status"]):
                    continue
                match = dict(row)
                match["text"] = match["text"][:700]
                result["matches"].append(match)
                if len(result["matches"]) == args.limit:
                    break
        result["status"] = store.status()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if result.get("fetch", {}).get("error") else 0
    except (Exception, KeyboardInterrupt) as exc:
        if store and run_id:
            store.finish_run(run_id, "interrupted" if isinstance(exc, KeyboardInterrupt) else "error", result,
                             f"{type(exc).__name__}: {exc}")
        logging.error("%s: %s", type(exc).__name__, exc)
        return 130 if isinstance(exc, KeyboardInterrupt) else 1
    finally:
        if client:
            client.close()
        if store:
            store.close()
