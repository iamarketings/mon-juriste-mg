CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS registrations_email ON registrations(email);
CREATE INDEX IF NOT EXISTS registrations_phone ON registrations(phone);
