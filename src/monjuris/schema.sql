PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    text_type TEXT,
    number TEXT,
    date TEXT,
    source_url TEXT NOT NULL,
    legal_status TEXT NOT NULL DEFAULT 'unknown',
    notes TEXT,
    metadata_json TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_jobs (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    language TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pdf', 'html')),
    source_url TEXT NOT NULL,
    inline_html TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    active INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    version_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    language TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    raw_key TEXT NOT NULL,
    text_key TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    legal_status TEXT NOT NULL DEFAULT 'unknown',
    extraction_status TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    text_chars INTEGER NOT NULL,
    warnings_json TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS versions_document ON document_versions(document_id, language, is_current);

CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    version_id TEXT NOT NULL REFERENCES document_versions(id),
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_sha256 TEXT NOT NULL,
    article TEXT,
    page_start INTEGER NOT NULL,
    page_end INTEGER NOT NULL,
    UNIQUE(version_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_version ON chunks(version_id);

CREATE TABLE IF NOT EXISTS crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    summary_json TEXT NOT NULL DEFAULT '{}',
    error TEXT
);
