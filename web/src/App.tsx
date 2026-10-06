import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, BookOpenText, Download, LockKeyhole, Scale, ShieldCheck, UserRound } from "lucide-react";

interface Citation {
  id: string;
  title: string;
  number: string | null;
  article: string | null;
  pageStart: number | null;
  sourceUrl: string;
  legalStatus: string;
}

interface ChatResponse {
  answer?: string;
  error?: string;
  citations?: Citation[];
}

interface Registration {
  id: string;
  name: string;
  email: string;
  phone: string;
  accessToken: string;
  createdAt: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const REGISTRATION_KEY = "monjuriste.registration.v1";

function loadRegistration(): Registration | null {
  try {
    const value = localStorage.getItem(REGISTRATION_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<Registration>;
    return parsed.id && parsed.name && parsed.email && parsed.phone && parsed.accessToken
      ? parsed as Registration
      : null;
  } catch {
    return null;
  }
}

function messageText(message: ThreadMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function sourceLink(citation: Citation): string {
  const suffix = citation.pageStart ? `#page=${citation.pageStart}` : "";
  const label = [citation.id, citation.title, citation.article, citation.pageStart ? `p. ${citation.pageStart}` : null]
    .filter(Boolean)
    .join(" — ")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  return `- [${label}](${citation.sourceUrl}${suffix})`;
}

const legalAdapter: ChatModelAdapter = {
  async run({ messages, abortSignal }) {
    const registration = loadRegistration();
    if (!registration) throw new Error("Votre inscription est requise.");
    const turns = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role as "user" | "assistant", content: messageText(message) }))
      .filter((message) => message.content.length > 0);
    let latestUserIndex = -1;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex < 0) throw new Error("La question est vide.");

    const query = turns[latestUserIndex].content;
    const history = turns.slice(Math.max(0, latestUserIndex - 8), latestUserIndex);
    const response = await fetch("/v1/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-monjuris-access": registration.accessToken,
      },
      body: JSON.stringify({ query, history, limit: 12 }),
      signal: abortSignal,
    });
    const data = (await response.json()) as ChatResponse;
    if (!response.ok || !data.answer) {
      if (response.status === 401) localStorage.removeItem(REGISTRATION_KEY);
      throw new Error(data.error || "La réponse juridique n’est pas disponible.");
    }

    const sources = data.citations?.length
      ? `\n\n### Sources consultées\n${data.citations.map(sourceLink).join("\n")}`
      : "";
    return { content: [{ type: "text", text: `${data.answer}${sources}` }] };
  },
};

function RuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useLocalRuntime(legalAdapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function InstallButton() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const complete = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", complete);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);

  if (installed) return null;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const install = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstallPrompt(null);
      return;
    }
    setHelp(true);
  };

  return (
    <div className="install-area">
      <button className="install-button" type="button" onClick={install}>
        <Download size={16} aria-hidden="true" /><span>Installer</span>
      </button>
      {help && (
        <div className="install-help" role="status">
          {isIos ? "Touchez Partager, puis « Sur l’écran d’accueil »." : "Utilisez le menu du navigateur puis « Installer l’application »."}
        </div>
      )}
    </div>
  );
}

function RegistrationScreen({ onRegistered }: { onRegistered: (registration: Registration) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone"),
          consent: form.get("consent") === "on",
        }),
      });
      const data = await response.json() as Registration & { error?: string };
      if (!response.ok || !data.accessToken) throw new Error(data.error || "Inscription impossible.");
      localStorage.setItem(REGISTRATION_KEY, JSON.stringify(data));
      onRegistered(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Inscription impossible.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="registration-page">
      <section className="registration-intro">
        <div className="eyebrow"><Scale size={16} /> Droit malgache, sources citées</div>
        <h1>Votre assistant juridique de première lecture</h1>
        <p>Interrogez les textes collectés auprès de CNLegis et retrouvez les références utilisées dans chaque réponse.</p>
        <div className="trust-points">
          <span><ShieldCheck size={18} /> Réponses fondées sur le corpus</span>
          <span><BookOpenText size={18} /> Articles et sources consultables</span>
        </div>
      </section>
      <section className="registration-card" aria-labelledby="registration-title">
        <div className="registration-icon"><UserRound size={23} /></div>
        <p className="step-label">Accès personnel</p>
        <h2 id="registration-title">Bienvenue sur Mon juriste</h2>
        <p className="registration-copy">Renseignez vos coordonnées une seule fois sur cet appareil pour commencer.</p>
        <form onSubmit={submit} className="registration-form">
          <label>Nom et prénom<input name="name" autoComplete="name" minLength={2} maxLength={100} required placeholder="Votre nom complet" /></label>
          <label>Adresse e-mail<input name="email" type="email" autoComplete="email" maxLength={254} required placeholder="vous@exemple.com" /></label>
          <label>Numéro de téléphone<input name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={30} required placeholder="+261 34 00 000 00" /></label>
          <label className="consent-row">
            <input name="consent" type="checkbox" required />
            <span>J’accepte l’enregistrement de ces informations afin d’accéder au service et d’être recontacté au sujet de Mon juriste.</span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="registration-submit" type="submit" disabled={pending}>
            {pending ? "Enregistrement…" : "Accéder à Mon juriste"}{!pending && <ArrowUp size={18} />}
          </button>
        </form>
        <p className="storage-note"><LockKeyhole size={14} /> Cet appareil mémorisera votre accès pour ne plus vous demander ces informations.</p>
      </section>
    </main>
  );
}

function UserMessage() {
  return <MessagePrimitive.Root className="message message-user"><div className="message-user-bubble"><MessagePrimitive.Parts /></div></MessagePrimitive.Root>;
}

function LegalMarkdown() {
  return <MarkdownTextPrimitive className="legal-markdown" />;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="assistant-seal" aria-hidden="true">MJ</div>
      <div className="message-assistant-body"><p className="message-author">Mon juriste</p><MessagePrimitive.Parts components={{ Text: LegalMarkdown }} /></div>
    </MessagePrimitive.Root>
  );
}

const suggestions = [
  "Quelles sont les obligations de l’employeur en matière de sécurité au travail ?",
  "Quelles règles encadrent la création d’une société à responsabilité limitée ?",
  "Que prévoient les textes sur la rupture du contrat de travail ?",
];

function EmptyState() {
  return (
    <AuiIf condition={(state) => state.thread.isEmpty}>
      <section className="empty-state">
        <div className="empty-symbol" aria-hidden="true"><Scale size={27} strokeWidth={1.6} /></div>
        <h1>Interrogez le droit malgache</h1>
        <p>Posez une question précise. Mon juriste répond à partir des textes collectés et indique les sources utilisées.</p>
        <div className="suggestions" aria-label="Questions suggérées">
          {suggestions.map((prompt) => (
            <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send className="suggestion"><span>{prompt}</span><ArrowUp size={16} aria-hidden="true" /></ThreadPrimitive.Suggestion>
          ))}
        </div>
      </section>
    </AuiIf>
  );
}

function Composer() {
  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input className="composer-input" placeholder="Votre question juridique…" aria-label="Question juridique" rows={1} unstable_insertNewlineOnTouchEnter />
        <ComposerPrimitive.Send className="send-button" aria-label="Envoyer la question"><ArrowUp size={20} /></ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
      <p className="composer-note">Vérifiez les sources citées avant toute décision.</p>
    </div>
  );
}

function LegalThread() {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <EmptyState />
        <ThreadPrimitive.Messages>{({ message }) => message.role === "user" ? <UserMessage /> : <AssistantMessage />}</ThreadPrimitive.Messages>
        <AuiIf condition={(state) => state.thread.isRunning}><div className="working" role="status"><span /><span /><span /> Consultation des textes en cours</div></AuiIf>
        <ThreadPrimitive.ViewportFooter className="thread-footer"><Composer /></ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

export function App() {
  const [registration, setRegistration] = useState<Registration | null>(() => loadRegistration());
  const [corpusCount, setCorpusCount] = useState<number | null>(null);
  const corpusLabel = useMemo(() => corpusCount === null ? "Connexion…" : `${corpusCount.toLocaleString("fr-FR")} passages`, [corpusCount]);

  useEffect(() => {
    fetch("/health").then((response) => response.ok ? response.json() : Promise.reject()).then((data: { chunks?: number }) => setCorpusCount(data.chunks ?? 0)).catch(() => setCorpusCount(0));
  }, []);

  return (
    <div className="app-shell">
      <aside className="archive-band" aria-hidden="true"><span className="band-red" /><span className="band-ivory" /><span className="band-green" /></aside>
      <header className="app-header">
        <div className="brand"><div className="brand-mark"><BookOpenText size={21} strokeWidth={1.7} /></div><div><strong>Mon juriste</strong><span>Assistant juridique malgache</span></div></div>
        <div className="header-actions">
          {registration && <div className={`corpus-status ${corpusCount === 0 ? "is-offline" : ""}`}><ShieldCheck size={16} /><span>{corpusLabel}</span></div>}
          <InstallButton />
        </div>
      </header>
      {registration ? <main className="chat-panel"><RuntimeProvider><LegalThread /></RuntimeProvider></main> : <RegistrationScreen onRegistered={setRegistration} />}
    </div>
  );
}
