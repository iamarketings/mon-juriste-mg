export interface Env {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  APP_ENV?: string;
  CORS_ORIGIN?: string;
  LLM_MODE?: "mock" | "openai-compatible" | "disabled";
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  FRONT_MODEL?: string;
  JEV_MODEL?: string;
  /** Compatibilité temporaire avec l'ancienne configuration mono-modèle. */
  LLM_MODEL?: string;
  VECTOR_SEARCH_ENABLED?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
}

export interface RetrievalFilters {
  category?: string;
  language?: string;
  legalStatus?: string;
}

export interface RetrieveRequest {
  query: string;
  limit?: number;
  filters?: RetrievalFilters;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  versionId: string;
  ordinal: number;
  text: string;
  title: string;
  number: string | null;
  date: string | null;
  article: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sourceUrl: string;
  language: string;
  legalStatus: string;
  categories: string[];
  score: number;
  scores: {
    lexical?: number;
    vector?: number;
  };
}

export interface RetrievalResponse {
  query: string;
  strategy: "lexical" | "hybrid";
  results: SearchResult[];
  warnings: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest extends RetrieveRequest {
  history?: ChatMessage[];
}
