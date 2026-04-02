import { requestUrl } from "obsidian";
import type { LLMProvider, ProviderKind } from "../types";
import type { LingoNestSettings } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openaiCompatible";

const DEFAULT_OPENAI_BASE_URLS: Record<Exclude<ProviderKind, "anthropic" | "ollama">, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  "openai-compatible": ""
};

export interface ProviderModelOption {
  id: string;
  label: string;
}

function readEnv(name: string): string {
  if (typeof process !== "undefined" && process.env && typeof process.env[name] === "string") {
    return process.env[name] ?? "";
  }
  return "";
}

export function resolveProviderApiKey(settings: LingoNestSettings, provider: ProviderKind): string {
  switch (provider) {
    case "openai":
      return readEnv("OPENAI_API_KEY") || settings.provider.openAIApiKey;
    case "anthropic":
      return readEnv("ANTHROPIC_API_KEY") || settings.provider.anthropicApiKey;
    case "groq":
      return readEnv("GROQ_API_KEY") || settings.provider.groqApiKey;
    case "fireworks":
      return readEnv("FIREWORKS_API_KEY") || settings.provider.fireworksApiKey;
    case "openai-compatible":
      return readEnv("OPENAI_COMPATIBLE_API_KEY") || settings.provider.openAICompatibleApiKey;
    case "ollama":
      return "";
  }
}

export function resolveProviderBaseUrl(settings: LingoNestSettings, provider: ProviderKind): string {
  if (provider === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  if (provider === "ollama") {
    return settings.provider.baseUrl || "http://127.0.0.1:11434";
  }
  return settings.provider.baseUrl || DEFAULT_OPENAI_BASE_URLS[provider];
}

export async function listAvailableModels(settings: LingoNestSettings): Promise<ProviderModelOption[]> {
  const provider = settings.provider.activeProvider;

  switch (provider) {
    case "anthropic":
      return listAnthropicModels(settings);
    case "ollama":
      return listOllamaModels(settings);
    case "openai":
    case "groq":
    case "fireworks":
    case "openai-compatible":
      return listOpenAICompatibleModels(settings, provider);
  }
}

async function listAnthropicModels(settings: LingoNestSettings): Promise<ProviderModelOption[]> {
  const apiKey = resolveProviderApiKey(settings, "anthropic").trim();
  if (!apiKey) {
    throw new Error("Add an Anthropic API key to load available models.");
  }

  const response = await requestUrl({
    url: `${resolveProviderBaseUrl(settings, "anthropic").replace(/\/$/, "")}/models`,
    method: "GET",
    throw: false,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not load Anthropic models (HTTP ${response.status}).`);
  }

  const entries = Array.isArray(response.json?.data) ? (response.json.data as Array<Record<string, unknown>>) : [];
  return finalizeModelOptions(
    entries.map((entry) => {
      const id = String(entry?.id ?? "").trim();
      return {
        id,
        label: id
      };
    })
  );
}

async function listOllamaModels(settings: LingoNestSettings): Promise<ProviderModelOption[]> {
  const baseUrl = resolveProviderBaseUrl(settings, "ollama");
  const response = await requestUrl({
    url: `${baseUrl.replace(/\/$/, "")}/api/tags`,
    method: "GET",
    throw: false
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not load Ollama models (HTTP ${response.status}).`);
  }

  const entries = Array.isArray(response.json?.models)
    ? (response.json.models as Array<Record<string, unknown>>)
    : [];
  return finalizeModelOptions(
    entries.map((entry) => {
      const id = String(entry?.name ?? entry?.model ?? "").trim();
      const details = entry?.details as Record<string, unknown> | undefined;
      const size = typeof details?.parameter_size === "string" ? details.parameter_size : "";
      return {
        id,
        label: size ? `${id} (${size})` : id
      };
    })
  );
}

async function listOpenAICompatibleModels(
  settings: LingoNestSettings,
  provider: Exclude<ProviderKind, "anthropic" | "ollama">
): Promise<ProviderModelOption[]> {
  const baseUrl = resolveProviderBaseUrl(settings, provider).trim();
  if (!baseUrl) {
    throw new Error("Set a Base URL first to load models for this provider.");
  }

  const apiKey = resolveProviderApiKey(settings, provider).trim();
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (provider !== "openai-compatible") {
    throw new Error(`Add a ${provider === "openai" ? "OpenAI" : provider.charAt(0).toUpperCase() + provider.slice(1)} API key to load available models.`);
  }

  const response = await requestUrl({
    url: `${baseUrl.replace(/\/$/, "")}/models`,
    method: "GET",
    throw: false,
    headers
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not load ${provider} models (HTTP ${response.status}).`);
  }

  const entries = Array.isArray(response.json?.data) ? (response.json.data as Array<Record<string, unknown>>) : [];
  return finalizeModelOptions(
    entries.map((entry) => {
      const id = String(entry?.id ?? "").trim();
      const owner = String(entry?.owned_by ?? "").trim();
      return {
        id,
        label: owner ? `${id} (${owner})` : id
      };
    })
  );
}

function finalizeModelOptions(entries: Array<ProviderModelOption | null | undefined>): ProviderModelOption[] {
  const seen = new Set<string>();
  const options = entries
    .filter((entry): entry is ProviderModelOption => Boolean(entry?.id))
    .filter((entry) => {
      if (seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return options;
}

export function createProvider(settings: LingoNestSettings): LLMProvider {
  const { provider } = settings;
  const requireApiKey = (providerName: ProviderKind, key: string): string => {
    if (!key.trim()) {
      throw new Error(`Missing API key for ${providerName}. Add it in settings or via environment variables.`);
    }
    return key;
  };

  switch (provider.activeProvider) {
    case "anthropic":
      return new AnthropicProvider({
        model: provider.model,
        temperature: provider.temperature,
        apiKey: requireApiKey("anthropic", resolveProviderApiKey(settings, "anthropic")),
        requestTimeoutMs: provider.requestTimeoutMs
      });
    case "ollama":
      return new OllamaProvider({
        model: provider.model,
        temperature: provider.temperature,
        baseUrl: provider.baseUrl,
        requestTimeoutMs: provider.requestTimeoutMs
      });
    case "openai":
    case "groq":
    case "fireworks":
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        kind: provider.activeProvider,
        model: provider.model,
        temperature: provider.temperature,
        apiKey:
          provider.activeProvider === "openai-compatible"
            ? resolveProviderApiKey(settings, provider.activeProvider)
            : requireApiKey(provider.activeProvider, resolveProviderApiKey(settings, provider.activeProvider)),
        baseUrl: provider.baseUrl,
        requestTimeoutMs: provider.requestTimeoutMs
      });
  }
}
