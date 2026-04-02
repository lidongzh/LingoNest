import { requestUrl } from "obsidian";
import type { LLMChatMessage, ProviderKind, SendChatOptions } from "../types";
import { AbstractProvider } from "./base";

const DEFAULT_BASE_URLS: Record<Exclude<ProviderKind, "anthropic" | "ollama">, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  "openai-compatible": ""
};

export class OpenAICompatibleProvider extends AbstractProvider {
  readonly kind: ProviderKind;

  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(params: {
    kind: Exclude<ProviderKind, "anthropic" | "ollama">;
    model: string;
    temperature: number;
    apiKey: string;
    baseUrl: string;
    requestTimeoutMs: number;
  }) {
    super();
    this.kind = params.kind;
    this.model = params.model;
    this.temperature = params.temperature;
    this.apiKey = params.apiKey;
    this.baseUrl = params.baseUrl || DEFAULT_BASE_URLS[params.kind];
    this.requestTimeoutMs = params.requestTimeoutMs;
  }

  protected async complete(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      throw: false,
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages,
        temperature: options?.temperature ?? this.temperature,
        max_tokens: options?.maxTokens ?? 1400,
        stream: false
      })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Provider request failed with HTTP ${response.status}.`);
    }

    const json = response.json as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (Array.isArray(content)) {
      return this.sanitizeText(content.map((part) => part.text ?? "").join("\n"));
    }
    return this.sanitizeText(content ?? "");
  }
}
