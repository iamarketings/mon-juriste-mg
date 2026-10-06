import { corsHeaders, HttpError, json, readJson } from "./http";
import { createChatProvider } from "./providers";
import { normalizeLimit, retrieve, validateQuery } from "./retrieval";
import { register, requireRegistration } from "./registrations";
import type { ChatRequest, Env, RetrieveRequest } from "./types";

function validateFilters(filters: RetrieveRequest["filters"]): RetrieveRequest["filters"] {
  if (filters === undefined) return {};
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new HttpError(400, "filters doit être un objet.");
  }
  const allowed = ["category", "language", "legalStatus"];
  for (const [key, value] of Object.entries(filters)) {
    if (!allowed.includes(key) || (value !== undefined && typeof value !== "string")) {
      throw new HttpError(400, `Filtre invalide : ${key}.`);
    }
  }
  return filters;
}

function validateHistory(history: ChatRequest["history"]): NonNullable<ChatRequest["history"]> {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 12) {
    throw new HttpError(400, "history doit contenir au maximum 12 messages.");
  }
  for (const message of history) {
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.length > 4000
    ) {
      throw new HttpError(400, "history contient un message invalide.");
    }
  }
  return history;
}

async function handleRetrieve(request: Request, env: Env): Promise<Response> {
  await requireRegistration(request, env);
  const body = await readJson<RetrieveRequest>(request);
  const query = validateQuery(body.query);
  const limit = normalizeLimit(body.limit);
  const filters = validateFilters(body.filters);
  return json(await retrieve(env, query, limit, filters));
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  await requireRegistration(request, env);
  const body = await readJson<ChatRequest>(request);
  const query = validateQuery(body.query);
  const limit = normalizeLimit(body.limit);
  const filters = validateFilters(body.filters);
  const history = validateHistory(body.history);
  const retrieval = await retrieve(env, query, limit, filters);
  if (!retrieval.results.length) {
    return json({
      query,
      answer: "Les sources disponibles dans le corpus ne permettent pas d’établir une réponse fiable à cette question.",
      citations: [],
      retrieval: {
        strategy: retrieval.strategy,
        warnings: retrieval.warnings,
        resultCount: 0,
      },
    });
  }

  const expert = await createChatProvider(env, "expert").generate({
    query,
    history,
    sources: retrieval.results,
  });
  const presentation = await createChatProvider(env, "presenter").generate({
    query,
    history: [],
    sources: retrieval.results,
    expertAnalysis: expert.answer,
  });
  const publicAnswer = presentation.answer
    .replace(/selon l['’]analyse(?: juridique)?(?: validée)?(?: produite)? par JEV[,]?\s*/gi, "")
    .replace(/selon l['’]analyse JEV[,]?\s*/gi, "")
    .replace(/\bJEV\b/gi, "l’analyse juridique")
    .trim();

  return json({
    query,
    answer: publicAnswer,
    citations: retrieval.results.map((result, index) => ({
      id: `S${index + 1}`,
      chunkId: result.chunkId,
      title: result.title,
      number: result.number,
      article: result.article,
      pageStart: result.pageStart,
      pageEnd: result.pageEnd,
      sourceUrl: result.sourceUrl,
      legalStatus: result.legalStatus,
    })),
    retrieval: {
      strategy: retrieval.strategy,
      warnings: retrieval.warnings,
      resultCount: retrieval.results.length,
    },
  });
}

async function handleHealth(env: Env): Promise<Response> {
  let database = "ok";
  let chunks = 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM chunks").first<{ count: number }>();
    chunks = Number(row?.count ?? 0);
  } catch {
    database = "not_initialized";
  }
  return json({
    status: database === "ok" ? "ok" : "degraded",
    database,
    chunks,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env.CORS_ORIGIN);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const { pathname } = new URL(request.url);
      let response: Response;
      if (request.method === "GET" && pathname === "/health") {
        response = await handleHealth(env);
      } else if (request.method === "POST" && pathname === "/v1/register") {
        const body = await readJson<Record<string, unknown>>(request);
        response = json(await register(env, body), 201);
      } else if (request.method === "POST" && pathname === "/v1/retrieve") {
        response = await handleRetrieve(request, env);
      } else if (request.method === "POST" && pathname === "/v1/chat") {
        response = await handleChat(request, env);
      } else {
        response = json({ error: "Route introuvable." }, 404);
      }
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Erreur interne.";
      const response = json({ error: message }, status, cors);
      if (status === 500) console.error(error);
      return response;
    }
  },
};
