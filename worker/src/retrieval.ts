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

function ftsExpression(query: string): string {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)
    ?.map((token) => token.replaceAll('"', '""'))
    .filter((token) => token.length >= 2)
    .slice(0, 16);

  if (!tokens?.length) {
    throw new HttpError(400, "La requête ne contient aucun terme recherchable.");
  }
  return [...new Set(tokens)].map((token) => `"${token}"`).join(" OR ");
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
  const clauses = ["chunks_fts MATCH ?", "v.is_current = 1"];
  const bindings: unknown[] = [ftsExpression(query)];

  if (filters.category) {
    clauses.push("d.category = ?");
    bindings.push(filters.category);
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
      bm25(chunks_fts, 0.0, 1.0, 3.0, 2.0, 2.0) AS rank
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
  const seed = ranked[0];
  if (!seed || limit <= 1) return ranked.slice(0, limit);

  // Legal provisions are normally split article by article. Keep most of the
  // context budget for the continuous section around the strongest match,
  // while preserving a few slots for other directly relevant results.
  const contextBudget = Math.min(limit, Math.max(3, Math.ceil(limit * 0.75)));
  const firstOrdinal = Math.max(0, seed.ordinal - 1);
  const lastOrdinal = seed.ordinal + contextBudget - 2;

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
    WHERE c.version_id = ?
      AND c.ordinal BETWEEN ? AND ?
      AND v.is_current = 1
    ORDER BY c.ordinal ASC
    LIMIT ?
  `).bind(seed.versionId, firstOrdinal, lastOrdinal, contextBudget).all<DbSearchRow>();

  const expanded = new Map<string, SearchResult>();
  for (const row of response.results) {
    const original = ranked.find((result) => result.chunkId === row.chunk_id);
    expanded.set(
      row.chunk_id,
      original ?? rowToResult(row, {}),
    );
  }
  for (const result of ranked) {
    if (expanded.size >= limit) break;
    if (!expanded.has(result.chunkId)) expanded.set(result.chunkId, result);
  }
  return [...expanded.values()].slice(0, limit);
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
