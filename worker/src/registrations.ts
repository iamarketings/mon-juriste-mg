import { HttpError } from "./http";
import type { Env } from "./types";

interface RegistrationRequest {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  consent?: unknown;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} est obligatoire.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > maxLength) {
    throw new HttpError(400, `${label} doit contenir entre 2 et ${maxLength} caractères.`);
  }
  return normalized;
}

function normalizeEmail(value: unknown): string {
  const email = requiredText(value, "L’adresse e-mail", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "L’adresse e-mail n’est pas valide.");
  }
  return email;
}

function normalizePhone(value: unknown): string {
  const input = requiredText(value, "Le numéro de téléphone", 30);
  const normalized = input.replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(normalized)) {
    throw new HttpError(400, "Le numéro de téléphone n’est pas valide.");
  }
  return normalized;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function register(env: Env, body: RegistrationRequest): Promise<Record<string, string>> {
  if (body.consent !== true) {
    throw new HttpError(400, "Votre accord est nécessaire pour enregistrer ces informations.");
  }
  const name = requiredText(body.name, "Le nom", 100);
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  const id = crypto.randomUUID();
  const accessToken = createAccessToken();
  const accessTokenHash = await sha256(accessToken);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO registrations (
      id, name, email, phone, access_token_hash, consent_at, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, name, email, phone, accessTokenHash, now, now, now).run();

  return { id, name, email, phone, accessToken, createdAt: now };
}

export async function requireRegistration(request: Request, env: Env): Promise<string> {
  const accessToken = request.headers.get("x-monjuris-access")?.trim();
  if (!accessToken || !/^[a-f0-9]{64}$/i.test(accessToken)) {
    throw new HttpError(401, "Inscription requise pour utiliser Mon juriste.");
  }
  const accessTokenHash = await sha256(accessToken);
  const row = await env.DB.prepare(
    "SELECT id FROM registrations WHERE access_token_hash = ? LIMIT 1",
  ).bind(accessTokenHash).first<{ id: string }>();
  if (!row) throw new HttpError(401, "Votre inscription n’est plus valide.");

  await env.DB.prepare(
    "UPDATE registrations SET last_seen_at = ? WHERE id = ?",
  ).bind(new Date().toISOString(), row.id).run();
  return row.id;
}
