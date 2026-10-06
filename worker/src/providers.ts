import { HttpError } from "./http";
import type { ChatMessage, Env, SearchResult } from "./types";

interface GenerationInput {
  query: string;
  history: ChatMessage[];
  sources: SearchResult[];
  expertAnalysis?: string;
}

interface GenerationResult {
  answer: string;
  model: string;
  provider: string;
}

interface ChatProvider {
  generate(input: GenerationInput): Promise<GenerationResult>;
}

type ProviderRole = "expert" | "presenter";

function sourceContext(sources: SearchResult[]): string {
  return sources
    .map((source, index) => {
      const reference = [source.title, source.number, source.article, source.pageStart ? `page ${source.pageStart}` : null]
        .filter(Boolean)
        .join(" — ");
      return `[S${index + 1}] ${reference}\n${source.text}`;
    })
    .join("\n\n");
}

class MockProvider implements ChatProvider {
  constructor(private readonly role: ProviderRole) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    if (!input.sources.length) {
      return {
        answer: "Aucun passage pertinent n’a été trouvé dans le corpus local.",
        model: "mock-local",
        provider: "mock",
      };
    }
    if (this.role === "presenter" && input.expertAnalysis) {
      return {
        answer: input.expertAnalysis,
        model: "mock-local",
        provider: "mock",
      };
    }
    const source = input.sources[0];
    const excerpt = source.text.replace(/\s+/g, " ").slice(0, 320);
    return {
      answer: `Mode local : le passage le mieux classé indique « ${excerpt}${source.text.length > 320 ? "…" : ""} » [S1]`,
      model: "mock-local",
      provider: "mock",
    };
  }
}

class OpenAiCompatibleProvider implements ChatProvider {
  constructor(
    private readonly env: Env,
    private readonly role: ProviderRole,
    private readonly model: string,
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    if (!this.env.LLM_BASE_URL || !this.env.LLM_API_KEY || !this.model) {
      throw new HttpError(503, "Le fournisseur de génération n'est pas complètement configuré.");
    }
    const baseUrl = this.env.LLM_BASE_URL.replace(/\/$/, "");
    const headers = new Headers({
      authorization: `Bearer ${this.env.LLM_API_KEY}`,
      "content-type": "application/json",
    });
    if (baseUrl.includes("openrouter.ai")) {
      headers.set("X-OpenRouter-Title", "Mon juriste MG");
    }

    const messages = this.role === "expert"
      ? [
          {
            role: "system",
            content:
              "Tu es l'expert juridique interne JEV spécialisé en droit malgache. Analyse uniquement les extraits CNLegis fournis. " +
              "N'invente aucune règle, date, exception, jurisprudence ou référence. Chaque proposition juridique doit porter une citation exacte [S1], [S2], etc. " +
              "Distingue ce que les sources établissent, ce qu'elles ne permettent pas de conclure et les éventuelles incertitudes de statut. " +
              "L'historique sert seulement à comprendre la question : les anciennes réponses et références ne sont pas des preuves. Utilise uniquement les références des extraits actuels. " +
              "Si les extraits sont insuffisants, indique la limite des extraits retrouvés, sans prétendre que la disposition est absente du corpus entier. Sur une relance, réexamine les nouveaux extraits et corrige une réponse antérieure si nécessaire.",
          },
          ...input.history,
          {
            role: "user",
            content: `Question juridique : ${input.query}\n\nExtraits autorisés :\n${sourceContext(input.sources)}`,
          },
        ]
      : [
          {
            role: "system",
            content:
              "Tu es l'interface rédactionnelle d'un assistant juridique malgache. JEV a déjà produit l'analyse juridique ci-dessous. " +
              "Rédige une réponse claire, sobre et directement utile à l'utilisateur. Tu dois reprendre exclusivement les faits, règles, limites et citations présents dans l'analyse JEV. " +
              "N'ajoute aucune connaissance personnelle, aucune nouvelle référence et aucune déduction juridique. Conserve les marqueurs [S1], [S2], etc. " +
              "Si JEV indique que les extraits sont insuffisants, dis-le sans tenter de compléter ni affirmer que le corpus entier ne contient pas cette information. " +
              "Ne mentionne jamais JEV, OpenRouter, un fournisseur, un modèle, une analyse interne ou cette chaîne de traitement dans la réponse publique.",
          },
          {
            role: "user",
            content: `Question : ${input.query}\n\nAnalyse validée par JEV :\n${input.expertAnalysis ?? "Analyse indisponible."}`,
          },
        ];

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: this.role === "expert" ? 0 : 0.1,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      console.error(`Generation ${this.role}: HTTP ${response.status}: ${detail}`);
      throw new HttpError(502, "La réponse juridique est temporairement indisponible. Réessayez dans un instant.");
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
    };
    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new HttpError(502, "Le fournisseur n'a renvoyé aucune réponse exploitable.");

    return {
      answer,
      model: payload.model || this.model,
      provider: baseUrl.includes("openrouter.ai") ? "openrouter" : "openai-compatible",
    };
  }
}

export function createChatProvider(env: Env, role: ProviderRole): ChatProvider {
  const model = role === "expert"
    ? env.JEV_MODEL || env.LLM_MODEL
    : env.FRONT_MODEL || "inclusionai/ling-3.0-flash";
  switch (env.LLM_MODE) {
    case "mock":
    case undefined:
      return new MockProvider(role);
    case "openai-compatible":
      if (!model) throw new HttpError(503, `Le modèle ${role} n'est pas configuré.`);
      return new OpenAiCompatibleProvider(env, role, model);
    case "disabled":
      throw new HttpError(503, "La génération est désactivée ; utilisez /v1/retrieve.");
    default:
      throw new HttpError(500, "LLM_MODE contient une valeur inconnue.");
  }
}
