import { HttpError } from "./http";
import type { ChatMessage } from "./types";

export function normalizeHistory(history: unknown): ChatMessage[] {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > 12) {
    throw new HttpError(400, "history doit contenir au maximum 12 messages.");
  }
  return history.map((message) => {
    if (!message || (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" || message.content.length > 100_000) {
      throw new HttpError(400, "history contient un message invalide.");
    }
    // The UI's source appendix is presentation, not conversation or evidence.
    const content = message.role === "assistant"
      ? message.content.split(/\n#{1,6}\s+Sources consultées\s*\n/i)[0].replace(/\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]/g, "")
      : message.content;
    return { role: message.role, content: content.trim().slice(0, 4000) };
  });
}

export function contextualQuery(query: string, history: ChatMessage[]): string {
  const previous = [...history].reverse().find((message) => message.role === "user" &&
    /\p{L}{3}/u.test(message.content) && !/^(?:tu es s[uû]r|pourquoi|et alors)\s*[?!.]*$/i.test(message.content));
  if (!previous) return query;
  if (!/\p{L}|\p{N}/u.test(query) || /^(?:tu es s[uû]r|pourquoi|et alors)\s*[?!.]*$/i.test(query)) {
    return previous.content.slice(0, 500);
  }
  // Carry the subject into short follow-ups, without recycling the old answer.
  if (/^(?:et\b|mais\b|cela\b|ça\b|ce cas\b|tu es s[uû]r\b)/i.test(query)) {
    const subject = (previous.content.match(/\b(?:CDD|CDI|travail|employeur|salari[ée]s?|soci[ée]t[ée]s?|SARL)\b/gi) ?? [])
      .filter((term) => !/\b(?:CDD|CDI)\b/i.test(query) || !/^(?:CDD|CDI)$/i.test(term));
    return `${query} ${[...new Set(subject)].join(" ")}`.trim().slice(0, 500);
  }
  return query;
}
