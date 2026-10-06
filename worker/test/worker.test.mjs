import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { createFetchMock, Miniflare } from "miniflare";

let mf;
let accessToken;
let options;

before(async () => {
  const script = await readFile(new URL("../../.worker-dist/index.js", import.meta.url), "utf8");
  options = {
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
  };
  mf = new Miniflare(options);

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

const request = (path, body) => mf.dispatchFetch(`http://local.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-monjuris-access": accessToken },
  body: JSON.stringify(body),
});

test("une réponse longue avec ses liens de sources ne bloque plus la relance", async () => {
  const response = await request("/v1/chat", { query: "contrat de travail", history: [
    { role: "user", content: "contrat de travail" },
    { role: "assistant", content: "Une réponse détaillée. ".repeat(300) + "\n\n### Sources consultées\n" + "- [Source](https://example.test/code)\n".repeat(200) },
  ] });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).answer);
});

test("une ponctuation seule demande une précision ou reprend le sujet précédent", async () => {
  const fresh = await request("/v1/chat", { query: "?" });
  assert.equal(fresh.status, 200);
  assert.match((await fresh.json()).answer, /Précisez/);
  const followup = await request("/v1/chat", { query: "?", history: [{ role: "user", content: "contrat de travail" }] });
  assert.equal(followup.status, 200);
  assert.ok((await followup.json()).citations.length);
});

test("les types et la taille de l’historique restent contrôlés", async () => {
  for (const history of [ [{ role: "system", content: "test" }], [{ role: "assistant", content: "x".repeat(100001) }], Array(13).fill({ role: "user", content: "test" }) ]) {
    assert.equal((await request("/v1/chat", { query: "contrat de travail", history })).status, 400);
  }
});

test("les CDD et leur rupture sont retrouvés dans le texte malgré les titres génériques", async (t) => {
  const db = await mf.getD1Database("DB");
  const chunks = [
    [20, "Article 23", "Le contrat à durée déterminée est écrit et comporte un terme."],
    [21, "Article 24", "Les circonstances permettent un contrat à durée déterminée."],
    [22, "Article 25", "Le contrat à durée déterminée peut être renouvelé."],
    [35, "Article 36", "La rupture du contrat de travail à durée déterminée intervient à son terme ou selon les cas prévus."],
    [36, "Article 37", "La rupture du contrat de travail à durée indéterminée est soumise à préavis."],
    [390, "Article 392", "Les dispositions du code du travail s appliquent aux contrats existants."],
  ];
  await db.batch(chunks.flatMap(([ordinal, article, text]) => [
    db.prepare("INSERT INTO chunks VALUES (?, 'doc-1', 'version-1', ?, ?, ?, ?, 1, 1)")
      .bind(`regression-${ordinal}`, ordinal, text, `hash-${ordinal}`, article),
    db.prepare("INSERT INTO chunks_fts VALUES (?, ?, 'Code du travail malgache', '2003-044', ?)")
      .bind(`regression-${ordinal}`, text, article),
  ]));
  await t.test("CDD développe le sigle vers contrat à durée déterminée", async () => {
    const response = await request("/v1/retrieve", { query: "tu es sur que le corpus ne donne rien sur les CDD", limit: 12 });
    assert.equal(response.status, 200);
    const articles = (await response.json()).results.map((result) => result.article);
    assert.ok(articles.includes("Article 23"));
    assert.ok(articles.includes("Article 36"));
    assert.ok(!articles.includes("Article 392"));
  });
  await t.test("la rupture retrouve les dispositions de fond et non la transition", async () => {
    const response = await request("/v1/retrieve", { query: "Que prévoient les textes sur la rupture du contrat de travail ?", limit: 12 });
    assert.equal(response.status, 200);
    const articles = (await response.json()).results.map((result) => result.article);
    assert.ok(articles.includes("Article 36"));
    assert.ok(articles.includes("Article 37"));
    assert.ok(!articles.includes("Article 392"));
  });
  await t.test("une relance courte conserve le type de contrat", async () => {
    const response = await request("/v1/chat", { query: "et la rupture ?", history: [{ role: "user", content: "Quelles sont les règles sur le CDD ?" }] });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).citations.some((citation) => citation.article === "Article 36"));
  });
});

test("la présentation conserve les preuves et les références inventées sont refusées", async (t) => {
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  const pool = fetchMock.get("https://generation.example.test");
  await mf.setOptions({ ...options, fetchMock, bindings: { ...options.bindings,
    LLM_MODE: "openai-compatible", LLM_BASE_URL: "https://generation.example.test", LLM_API_KEY: "test-only",
    JEV_MODEL: "expert-test", FRONT_MODEL: "presenter-test",
  } });
  const observed = [];
  const reply = (answer) => pool.intercept({ path: "/chat/completions", method: "POST" })
    .reply(200, (request) => {
      observed.push(new Response(request.body).json());
      return JSON.stringify({ choices: [{ message: { content: answer } }] });
    });
  await t.test("une présentation sans citations revient à l’analyse sourcée", async () => {
    reply("Les règles figurent dans les extraits [S1].");
    reply("User Safety: safe");
    const response = await request("/v1/chat", { query: "CDD", history: [
      { role: "assistant", content: "Historique [S999] et [S999, S1].\n\n### Sources consultées\n" + "Lien inutile. ".repeat(500) },
    ] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, "Les règles figurent dans les extraits [S1].");
    const payload = await observed[0];
    const history = payload.messages.find((message) => message.role === "assistant");
    assert.ok(history);
    assert.ok(!history.content.includes("Sources consultées"));
    assert.ok(!history.content.includes("[S999]"));
    assert.ok(!history.content.includes("S999"));
    assert.ok(history.content.length <= 4000);
  });
  await t.test("une référence absente des extraits ne peut pas devenir publique", async () => {
    reply("Une règle sans preuve [S999].");
    const response = await request("/v1/chat", { query: "CDD" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /référence non vérifiable/);
  });
  await t.test("une citation regroupée ne peut pas dissimuler une référence inventée", async () => {
    reply("Une règle sans preuve [S1, S999].");
    const response = await request("/v1/chat", { query: "CDD" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /référence non vérifiable/);
  });
  await t.test("le regroupement de citations valides préserve la reformulation", async () => {
    reply("Analyse sourcée [S1] et [S2].");
    reply("Présentation sourcée [S1, S2].");
    const response = await request("/v1/chat", { query: "CDD" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, "Présentation sourcée [S1, S2].");
  });
  fetchMock.assertNoPendingInterceptors();
  await Promise.all(observed);
});
