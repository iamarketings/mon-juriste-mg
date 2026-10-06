import { corsHeaders, HttpError, json, readJson } from "./http";
import { createChatProvider } from "./providers";
import { normalizeLimit, retrieve, validateQuery } from "./retrieval";
import { register, requireRegistration } from "./registrations";
import { contextualQuery, normalizeHistory } from "./conversation";
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

function citationIds(answer: string): string[] {
  const groups = answer.match(/\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]/g) ?? [];
  return [...new Set(groups.flatMap((group) => (group.match(/S\d+/g) ?? []).map((id) => `[${id}]`)))];
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
  // A punctuation-only nudge is valid in a conversation, but not in retrieval.
  if (typeof body.query !== "string" || !body.query.trim() || body.query.trim().length > 500) {
    validateQuery(body.query);
  }
  const query = body.query.trim();
  const limit = normalizeLimit(body.limit);
  const filters = validateFilters(body.filters);
  const history = normalizeHistory(body.history);
  const searchQuery = contextualQuery(query, history);
  if (!/[\p{L}\p{N}]{2}/u.test(searchQuery)) {
    return json({ query, answer: "Précisez votre question juridique pour que je puisse rechercher les textes pertinents.", citations: [],
      retrieval: { strategy: "lexical", warnings: [], resultCount: 0 } });
  }
  const retrieval = await retrieve(env, searchQuery, limit, filters);
  if (!retrieval.results.length) {
    return json({
      query,
      answer: "La recherche n’a pas trouvé d’extrait suffisamment pertinent pour répondre de façon fiable. Cela ne signifie pas que le corpus ne contient aucune disposition sur ce sujet. Précisez le type de contrat, la situation ou l’article recherché.",
      citations: [],
      retrieval: {
        strategy: retrieval.strategy,
        warnings: retrieval.warnings,
        resultCount: 0,
      },
    });
  }

  const expert = await createChatProvider(env, "expert").generate({
    query: searchQuery === query ? query : `${query}\nSujet de la conversation : ${searchQuery}`,
    history,
    sources: retrieval.results,
  });
  const allowedReferences = new Set(retrieval.results.map((_, index) => `[S${index + 1}]`));
  const expertReferences = citationIds(expert.answer);
  if (expertReferences.some((reference) => !allowedReferences.has(reference))) {
    throw new HttpError(502, "La réponse contient une référence non vérifiable. Réessayez pour consulter les textes.");
  }
  const presentation = await createChatProvider(env, "presenter").generate({
    query,
    history: [],
    sources: retrieval.results,
    expertAnalysis: expert.answer,
  });
  const presentationReferences = citationIds(presentation.answer);
  // A formatting model must neither introduce references nor lose the expert's
  // citations. Fall back to the sourced analysis if it changes that contract.
  const preservesReferences = presentationReferences.length === expertReferences.length &&
    presentationReferences.every((reference) => expertReferences.includes(reference));
  const publicAnswer = (preservesReferences ? presentation.answer : expert.answer)
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
