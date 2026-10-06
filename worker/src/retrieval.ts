import { HttpError } from "./http";
import type {
  Env,
  RetrievalFilters,
  RetrievalResponse,
  SearchResult,
} from "./types";

interface DbSearchRow {
  chunk_id: string;
  document_id: string;
  version_id: string;
  ordinal: number;
  text: string;
  title: string;
  number: string | null;
  date: string | null;
  article: string | null;
  page_start: number | null;
  page_end: number | null;
  source_url: string;
  language: string;
  legal_status: string;
  categories_json: string;
  rank?: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;
const RRF_K = 60;

export function validateQuery(query: unknown): string {
  if (typeof query !== "string") {
    throw new HttpError(400, "Le champ query est obligatoire.");
  }
  const normalized = query.trim();
  if (normalized.length < 2) {
    throw new HttpError(400, "La requête doit contenir au moins 2 caractères.");
  }
  if (normalized.length > 500) {
    throw new HttpError(400, "La requête ne peut pas dépasser 500 caractères.");
  }
  return normalized;
}

export function normalizeLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    throw new HttpError(400, `limit doit être un entier entre 1 et ${MAX_LIMIT}.`);
  }
  return limit as number;
}

const STOP_WORDS = new Set((
  "de du des le la les un une au aux en et ou a à ce ces cet cette que qui quoi quel quels quelle quelles " +
  "est sont etre être pour par sur dans avec sans se son sa ses il ils elle elles on nous vous mon ma mes " +
  "ne pas plus rien tout tous toutes donne donnent dit disent prevoit prévoient corpus source sources " +
  "tu es sur sûr sure sûre suis peux peut faire faut comment pourquoi stp merci seulement bien vraiment " +
  "relatif relative relatives relatifs matiere matière general generale générales generale generales prevoient l d qu n"
).split(" "));

function queryTokens(query: string): string[] {
  return [...new Set(query.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)) ?? [])].slice(0, 24);
}

function searchPlan(query: string): { expression: string; work: boolean } {
  const tokens = queryTokens(query);
  if (!tokens.length) {
    throw new HttpError(400, "La requête ne contient aucun terme recherchable.");
  }
  const work = tokens.some((token) => /^(?:cdd|cdi|travail|employeur|salarie|licenci)/.test(token));
  const fixed = tokens.includes("cdd") || (tokens.includes("duree") && tokens.some((token) => /^determine/.test(token)));
  const indefinite = tokens.includes("cdi") || tokens.some((token) => /^indetermine/.test(token));
  const termination = tokens.some((token) => /^(?:ruptur|resili|licenci)/.test(token));
  const safety = tokens.some((token) => /^(?:securit|sante|protect|risqu)/.test(token));
  // Acronyms and inflections must match the actual provision text. Giving
  // every document titled 'Code du travail' a strong title match hid these hits.
  if (fixed || indefinite) {
    const kind = fixed ? '("cdd" OR ("duree" AND "determin"*))' : '("cdi" OR ("duree" AND "indetermin"*))';
    return { expression: `text:${kind} AND text:"contrat"*`, work };
  }
  if (termination) {
    const anchor = work || tokens.includes("contrat") ? ' AND text:"contrat"*' : "";
    return { expression: 'text:("ruptur"* OR "resili"* OR "licenci"* OR "cessation")' + anchor, work };
  }
  if (safety) {
    return { expression: 'text:("secur"* OR "sant"* OR "protect"* OR "risqu"*)', work };
  }
  const focused = tokens.filter((token) => !["contrat", "travail", "employeur", "regles", "obligations", "code"].includes(token));
  const selected = focused.length ? focused : tokens;
  const stems: Record<string, string> = {
    indemnites: "indemni", indemnite: "indemni", licenciement: "licenci", licenciements: "licenci",
    obligations: "obligation", societes: "societ", societe: "societ", creation: "creat", salaries: "salari",
  };
  return { expression: selected.map((token) => stems[token] ? `"${stems[token]}"*` : `"${token}"`).join(" OR "), work };
}

function parseCategories(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function rowToResult(row: DbSearchRow, scores: SearchResult["scores"]): SearchResult {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    versionId: row.version_id,
    ordinal: row.ordinal,
    text: row.text,
    title: row.title,
    number: row.number,
    date: row.date,
    article: row.article,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    sourceUrl: row.source_url,
    language: row.language,
    legalStatus: row.legal_status,
    categories: parseCategories(row.categories_json),
    score: 0,
    scores,
  };
}

async function lexicalSearch(
  env: Env,
  query: string,
  limit: number,
  filters: RetrievalFilters,
): Promise<SearchResult[]> {
  const plan = searchPlan(query);
  const clauses = ["chunks_fts MATCH ?", "v.is_current = 1"];
  const bindings: unknown[] = [plan.expression];

  if (filters.category || plan.work) {
    clauses.push("d.category = ?");
    bindings.push(filters.category || "DROIT DU TRAVAIL");
  }
  if (filters.language) {
    clauses.push("v.language = ?");
    bindings.push(filters.language);
  }
  if (filters.legalStatus) {
    clauses.push("v.legal_status = ?");
    bindings.push(filters.legalStatus);
  }

  bindings.push(Math.min(limit * 4, 60));
  const statement = env.DB.prepare(`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.version_id,
      c.ordinal,
      c.text,
      d.title,
      d.number,
      d.date,
      c.article,
      c.page_start,
      c.page_end,
      v.source_url,
      v.language,
      v.legal_status,
      d.categories_json,
      bm25(chunks_fts, 0.0, 1.0, 0.15, 2.0, 2.0) AS rank
    FROM chunks_fts
    JOIN chunks AS c ON c.id = chunks_fts.chunk_id
    JOIN documents AS d ON d.id = c.document_id
    JOIN document_versions AS v ON v.id = c.version_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank ASC
    LIMIT ?
  `);

  const response = await statement.bind(...bindings).all<DbSearchRow>();
  return response.results.map((row, index) =>
    rowToResult(row, { lexical: 1 / (RRF_K + index + 1) }),
  );
}

async function embedQuery(env: Env, query: string): Promise<number[]> {
  if (!env.EMBEDDING_BASE_URL || !env.EMBEDDING_MODEL) {
    throw new Error("Le fournisseur d'embeddings n'est pas configuré.");
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (env.EMBEDDING_API_KEY) headers.set("authorization", `Bearer ${env.EMBEDDING_API_KEY}`);

  const response = await fetch(`${env.EMBEDDING_BASE_URL.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: query }),
  });
  if (!response.ok) {
    throw new Error(`Le fournisseur d'embeddings a répondu ${response.status}.`);
  }
  const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!embedding?.length || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Le fournisseur d'embeddings a renvoyé un vecteur invalide.");
  }
  return embedding;
}

async function rowsByIds(env: Env, ids: string[]): Promise<Map<string, DbSearchRow>> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const response = await env.DB.prepare(`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.version_id,
      c.ordinal,
      c.text,
      d.title,
      d.number,
      d.date,
      c.article,
      c.page_start,
      c.page_end,
      v.source_url,
      v.language,
      v.legal_status,
      d.categories_json
    FROM chunks AS c
    JOIN documents AS d ON d.id = c.document_id
    JOIN document_versions AS v ON v.id = c.version_id
    WHERE c.id IN (${placeholders}) AND v.is_current = 1
  `).bind(...ids).all<DbSearchRow>();
  return new Map(response.results.map((row) => [row.chunk_id, row]));
}

async function vectorSearch(
  env: Env,
  query: string,
  limit: number,
  filters: RetrievalFilters,
): Promise<SearchResult[]> {
  if (!env.VECTORIZE) throw new Error("Le binding Vectorize n'est pas disponible.");
  const vector = await embedQuery(env, query);
  const vectorFilter: Record<string, string> = {};
  if (filters.language) vectorFilter.language = filters.language;
  if (filters.legalStatus) vectorFilter.legal_status = filters.legalStatus;

  const matches = await env.VECTORIZE.query(vector, {
    topK: Math.min(limit * 4, 50),
    returnMetadata: "all",
    ...(Object.keys(vectorFilter).length ? { filter: vectorFilter } : {}),
  });
  const ids = matches.matches.map((match) => match.id);
  const rows = await rowsByIds(env, ids);

  return matches.matches.flatMap((match, index) => {
    const row = rows.get(match.id);
    if (!row) return [];
    const categories = parseCategories(row.categories_json);
    if (filters.category && !categories.includes(filters.category)) return [];
    return [rowToResult(row, { vector: match.score ?? 1 / (RRF_K + index + 1) })];
  });
}

function fuseResults(
  lexical: SearchResult[],
  vector: SearchResult[],
  limit: number,
): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const [index, result] of lexical.entries()) {
    merged.set(result.chunkId, {
      ...result,
      score: 1 / (RRF_K + index + 1),
    });
  }
  for (const [index, result] of vector.entries()) {
    const contribution = 1 / (RRF_K + index + 1);
    const existing = merged.get(result.chunkId);
    if (existing) {
      existing.score += contribution;
      existing.scores.vector = result.scores.vector;
    } else {
      merged.set(result.chunkId, { ...result, score: contribution });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

async function expandAdjacentContext(
  env: Env,
  ranked: SearchResult[],
  limit: number,
): Promise<SearchResult[]> {
  if (!ranked.length || limit <= 1) return ranked.slice(0, limit);
  // Preserve direct matches before adding context from several sections.
  // One irrelevant seed must never consume most of the context budget.
  const expanded = new Map(ranked.slice(0, Math.ceil(limit / 2)).map((result) => [result.chunkId, result]));
  const seeds: SearchResult[] = [];
  for (const result of ranked) {
    if (!seeds.some((seed) => seed.versionId === result.versionId && Math.abs(seed.ordinal - result.ordinal) <= 2)) seeds.push(result);
    if (seeds.length === 3) break;
  }
  const responses = await Promise.all(seeds.map((seed) => env.DB.prepare(`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.version_id,
      c.ordinal,
      c.text,
      d.title,
      d.number,
      d.date,
      c.article,
      c.page_start,
      c.page_end,
      v.source_url,
      v.language,
      v.legal_status,
      d.categories_json
    FROM chunks AS c
    JOIN documents AS d ON d.id = c.document_id
    JOIN document_versions AS v ON v.id = c.version_id
    WHERE c.version_id = ?
      AND c.ordinal BETWEEN ? AND ?
      AND v.is_current = 1
    ORDER BY c.ordinal ASC
  `).bind(seed.versionId, Math.max(0, seed.ordinal - 2), seed.ordinal + 2).all<DbSearchRow>()));
  const neighbors = responses.map((response, index) => response.results.sort((a, b) =>
    Math.abs(a.ordinal - seeds[index].ordinal) - Math.abs(b.ordinal - seeds[index].ordinal) || a.ordinal - b.ordinal));
  for (let depth = 0; depth < 5 && expanded.size < limit; depth++) {
    for (const rows of neighbors) {
      const row = rows[depth];
      if (row && !expanded.has(row.chunk_id)) {
        expanded.set(row.chunk_id, ranked.find((result) => result.chunkId === row.chunk_id) ?? rowToResult(row, {}));
      }
      if (expanded.size === limit) break;
    }
  }
  for (const result of ranked) {
    if (expanded.size >= limit) break;
    if (!expanded.has(result.chunkId)) expanded.set(result.chunkId, result);
  }
  const versionOrder = [...new Set([...expanded.values()].map((result) => result.versionId))];
  return [...expanded.values()].sort((a, b) => versionOrder.indexOf(a.versionId) - versionOrder.indexOf(b.versionId) || a.ordinal - b.ordinal).slice(0, limit);
}

export async function retrieve(
  env: Env,
  query: string,
  limit: number,
  filters: RetrievalFilters = {},
): Promise<RetrievalResponse> {
  const lexical = await lexicalSearch(env, query, limit, filters);
  const warnings: string[] = [];
  let vector: SearchResult[] = [];
  let strategy: RetrievalResponse["strategy"] = "lexical";

  if (env.VECTOR_SEARCH_ENABLED === "true") {
    try {
      vector = await vectorSearch(env, query, limit, filters);
      strategy = "hybrid";
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "La recherche vectorielle a échoué.");
    }
  }

  const ranked = fuseResults(lexical, vector, limit);
  const results = await expandAdjacentContext(env, ranked, limit);

  return {
    query,
    strategy,
    results,
    warnings,
  };
}
