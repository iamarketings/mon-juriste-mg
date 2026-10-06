import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";

let mf;
let accessToken;

before(async () => {
  const script = await readFile(new URL("../../.worker-dist/index.js", import.meta.url), "utf8");
  mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-10-01",
    d1Databases: ["DB"],
    r2Buckets: ["DOCUMENTS"],
    bindings: {
      APP_ENV: "test",
      CORS_ORIGIN: "http://localhost:3000",
      LLM_MODE: "mock",
      VECTOR_SEARCH_ENABLED: "false",
    },
  });

  const db = await mf.getD1Database("DB");
  const statements = [
    `CREATE TABLE documents (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL,
      category TEXT NOT NULL, categories_json TEXT NOT NULL, text_type TEXT,
      number TEXT, date TEXT, source_url TEXT NOT NULL,
      legal_status TEXT NOT NULL, notes TEXT, metadata_json TEXT NOT NULL,
      discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE document_versions (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, language TEXT NOT NULL,
      source_url TEXT NOT NULL, source_sha256 TEXT NOT NULL, raw_key TEXT NOT NULL,
      text_key TEXT NOT NULL, fetched_at TEXT NOT NULL, legal_status TEXT NOT NULL,
      extraction_status TEXT NOT NULL, page_count INTEGER NOT NULL,
      text_chars INTEGER NOT NULL, warnings_json TEXT NOT NULL, is_current INTEGER NOT NULL
    )`,
    `CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, text TEXT NOT NULL, text_sha256 TEXT NOT NULL,
      article TEXT, page_start INTEGER, page_end INTEGER
    )`,
    `CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED, text, title, number, article,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `CREATE TABLE registrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE, consent_at TEXT NOT NULL,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    )`,
    `INSERT INTO documents VALUES (
      'doc-1','1','Code du travail malgache','DROIT DU TRAVAIL','["DROIT DU TRAVAIL"]',
      'Loi','2003-044','28-07-2004','https://example.test/code','En vigueur','', '{}',
      '2026-01-01','2026-01-01'
    )`,
    `INSERT INTO document_versions VALUES (
      'version-1','doc-1','fr','https://example.test/code','hash','raw.pdf','text.json',
      '2026-01-01','En vigueur','ready',1,100,'[]',1
    )`,
    `INSERT INTO chunks VALUES (
      'chunk-1','doc-1','version-1',1,
      'Le contrat de travail est soumis aux dispositions du présent code.',
      'text-hash','Article premier',1,1
    )`,
    `INSERT INTO chunks VALUES (
      'chunk-2','doc-1','version-1',2,
      'L employeur assure la sécurité et la santé des travailleurs.',
      'text-hash-2','Article 2',1,1
    )`,
    `INSERT INTO chunks VALUES (
      'chunk-3','doc-1','version-1',3,
      'Il fournit gratuitement les équipements de protection nécessaires.',
      'text-hash-3','Article 3',1,1
    )`,
    `INSERT INTO chunks_fts VALUES (
      'chunk-1','Le contrat de travail est soumis aux dispositions du présent code.',
      'Code du travail malgache','2003-044','Article premier'
    )`,
    `INSERT INTO chunks_fts VALUES (
      'chunk-2','L employeur assure la sécurité et la santé des travailleurs.',
      'Code du travail malgache','2003-044','Article 2'
    )`,
    `INSERT INTO chunks_fts VALUES (
      'chunk-3','Il fournit gratuitement les équipements de protection nécessaires.',
      'Code du travail malgache','2003-044','Article 3'
    )`,
  ];
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const registration = await mf.dispatchFetch("http://local.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Test Juriste",
      email: "test@example.test",
      phone: "+261340000000",
      consent: true,
    }),
  });
  assert.equal(registration.status, 201);
  accessToken = (await registration.json()).accessToken;
});

after(async () => {
  await mf?.dispose();
});

test("health reste limité aux informations opérationnelles", async () => {
  const response = await mf.dispatchFetch("http://local.test/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.database, "ok");
  assert.equal(body.chunks, 3);
  assert.equal(body.provider, undefined);
  assert.equal(body.model, undefined);
  assert.equal(body.llmMode, undefined);
});

test("retrieve interroge le FTS D1 local et conserve les citations", async () => {
  const response = await mf.dispatchFetch("http://local.test/v1/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-monjuris-access": accessToken },
    body: JSON.stringify({ query: "contrat de travail", limit: 5 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.strategy, "lexical");
  assert.equal(body.results.length, 3);
  assert.equal(body.results[0].article, "Article premier");
  assert.equal(body.results[0].sourceUrl, "https://example.test/code");
  assert.deepEqual(body.results.map((result) => result.article), [
    "Article premier",
    "Article 2",
    "Article 3",
  ]);
});

test("chat couvre le flux RAG sans appel externe en mode mock", async () => {
  const response = await mf.dispatchFetch("http://local.test/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-monjuris-access": accessToken },
    body: JSON.stringify({ query: "Que dit le contrat de travail ?" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, undefined);
  assert.equal(body.model, undefined);
  assert.equal(body.citations[0].id, "S1");
  assert.match(body.answer, /\[S1\]/);
});

test("les requêtes invalides sont refusées", async () => {
  const response = await mf.dispatchFetch("http://local.test/v1/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-monjuris-access": accessToken },
    body: JSON.stringify({ query: " " }),
  });
  assert.equal(response.status, 400);
});

test("une inscription est obligatoire avant l’utilisation", async () => {
  const response = await mf.dispatchFetch("http://local.test/v1/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "contrat de travail" }),
  });
  assert.equal(response.status, 401);
});
