import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Check, AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export type OnboardingPhase =
  | "providers"
  | "api-key"
  | "api-key-validating"
  | "oauth-waiting"
  | "oauth-paste"
  | "details"
  | "registering"
  | "done";

export interface OnboardingData {
  providers?: Array<{ value: string; label: string; hint: string }>;
  keyLabel?: string;
  keyPlaceholder?: string;
  keyError?: string;
  oauthUrl?: string;
  oauthError?: string;
  nameSuggestions?: string[];
  descriptionSuggestions?: string[];
  registerError?: string;
  nameConflict?: boolean;
  registeredAgent?: string;
  verificationCode?: string;
}

interface OnboardingProps {
  phase: OnboardingPhase;
  data: OnboardingData;
}

function sendToSidecar(msg: object): void {
  invoke("send_to_sidecar", { message: JSON.stringify(msg) }).catch(console.error);
}

export function Onboarding({ phase, data }: OnboardingProps) {
  return (
    <div className="flex flex-col h-full items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="text-center mb-8">
          <span className="text-4xl text-primary">✦</span>
          <h1 className="text-2xl font-semibold tracking-tight mt-2">Astra</h1>
          <p className="text-sm text-muted-foreground mt-1">Set up your trading agent</p>
        </div>

        {phase === "providers" && <ProviderStep providers={data.providers ?? []} />}
        {phase === "api-key" && <ApiKeyStep label={data.keyLabel ?? "API key"} placeholder={data.keyPlaceholder ?? ""} error={data.keyError} />}
        {phase === "api-key-validating" && <ValidatingStep />}
        {phase === "oauth-waiting" && <OAuthWaitingStep url={data.oauthUrl ?? ""} />}
        {phase === "oauth-paste" && <OAuthPasteStep error={data.oauthError} />}
        {phase === "details" && (
          <DetailsStep
            nameSuggestions={data.nameSuggestions ?? []}
            descriptionSuggestions={data.descriptionSuggestions ?? []}
            error={data.registerError}
          />
        )}
        {phase === "registering" && <RegisteringStep />}
        {phase === "done" && <DoneStep agentName={data.registeredAgent ?? ""} verificationCode={data.verificationCode ?? ""} />}
      </div>
    </div>
  );
}

// ── Provider Selection ──

function ProviderStep({ providers }: { providers: Array<{ value: string; label: string; hint: string }> }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground text-center">Choose your LLM provider</p>
      {providers.map((p) => (
        <button
          key={p.value}
          onClick={() => sendToSidecar({ type: "onboard:set-provider", provider: p.value })}
          className="w-full flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-left hover:bg-muted transition-colors"
        >
          <span className="text-sm font-medium">{p.label}</span>
          <span className="text-xs text-muted-foreground">{p.hint}</span>
        </button>
      ))}
    </div>
  );
}

// ── API Key Input ──

function ApiKeyStep({ label, placeholder, error }: { label: string; placeholder: string; error?: string }) {
  const [key, setKey] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!key.trim()) return;
    sendToSidecar({ type: "onboard:validate-key", provider: inferProvider(label), apiKey: key.trim() });
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium mb-1">Enter your {label}</p>
        <p className="text-xs text-muted-foreground">
          Your key is stored locally and never shared with the AI model.
        </p>
      </div>
      {error && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-md p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <span className="text-destructive">{error}</span>
        </div>
      )}
      <input
        ref={inputRef}
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder={placeholder || "Paste your API key"}
        className="w-full rounded-lg bg-muted border-none px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <Button onClick={handleSubmit} disabled={!key.trim()} className="w-full">
        Validate & Continue
      </Button>
    </div>
  );
}

function inferProvider(label: string): string {
  if (label.includes("Anthropic")) return "claude";
  if (label.includes("OpenAI")) return "openai";
  if (label.includes("Google")) return "google";
  return "openai";
}

// ── Validating ──

function ValidatingStep() {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Validating API key...</p>
    </div>
  );
}

// ── OAuth Waiting ──

function OAuthWaitingStep({ url }: { url: string }) {
  return (
    <div className="space-y-4 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-primary mx-auto" />
      <p className="text-sm">Complete login in your browser...</p>
      <p className="text-xs text-muted-foreground">
        A browser window should have opened. Complete the ChatGPT login to continue.
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        Open login page manually <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

// ── OAuth Paste Fallback ──

function OAuthPasteStep({ error }: { error?: string }) {
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!url.trim()) return;
    sendToSidecar({ type: "onboard:oauth-paste", url: url.trim() });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">Paste the redirect URL</p>
      <p className="text-xs text-muted-foreground">
        After logging in, copy the URL from your browser and paste it here.
      </p>
      {error && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-md p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <span className="text-destructive">{error}</span>
        </div>
      )}
      <input
        ref={inputRef}
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="http://localhost:1455/auth/callback?code=..."
        className="w-full rounded-lg bg-muted border-none px-4 py-2.5 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <Button onClick={handleSubmit} disabled={!url.trim()} className="w-full">
        Continue
      </Button>
    </div>
  );
}

// ── Agent Details (Name + Description) ──

function DetailsStep({
  nameSuggestions,
  descriptionSuggestions,
  error,
}: {
  nameSuggestions: string[];
  descriptionSuggestions: string[];
  error?: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!name.trim() || !description.trim()) return;
    sendToSidecar({
      type: "onboard:register",
      agentName: name.trim().toLowerCase(),
      description: description.trim(),
    });
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-md p-3 text-sm">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <span className="text-destructive">{error}</span>
        </div>
      )}

      {/* Agent Name */}
      <div>
        <p className="text-sm font-medium mb-2">Agent name</p>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="lowercase-with-hyphens"
          className="w-full rounded-lg bg-muted border-none px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex gap-2 mt-2 flex-wrap">
          {nameSuggestions.map((s) => (
            <button
              key={s}
              onClick={() => setName(s)}
              className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-muted transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div>
        <p className="text-sm font-medium mb-2">Personality</p>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. reckless degen trader"
          className="w-full rounded-lg bg-muted border-none px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex gap-2 mt-2 flex-wrap">
          {descriptionSuggestions.map((s) => (
            <button
              key={s}
              onClick={() => setDescription(s)}
              className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-muted transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <Button onClick={handleSubmit} disabled={!name.trim() || !description.trim()} className="w-full">
        Register Agent
      </Button>
    </div>
  );
}

// ── Registering ──

function RegisteringStep() {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">Registering your agent...</p>
    </div>
  );
}

// ── Done ──

function DoneStep({ agentName, verificationCode }: { agentName: string; verificationCode: string }) {
  return (
    <div className="space-y-4 text-center">
      <div className="w-12 h-12 rounded-full bg-primary/15 text-primary flex items-center justify-center mx-auto">
        <Check className="h-6 w-6" />
      </div>
      <div>
        <p className="text-sm font-medium">Agent **"{agentName}"** registered!</p>
        {verificationCode && (
          <p className="text-xs text-muted-foreground mt-2">
            Verification code: <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{verificationCode}</code>
          </p>
        )}
      </div>
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
      <p className="text-xs text-muted-foreground">Loading your agent...</p>
    </div>
  );
}
