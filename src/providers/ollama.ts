import { requestUrl } from "obsidian";
import type { LLMChatMessage, SendChatOptions } from "../types";
import { AbstractProvider } from "./base";

export class OllamaProvider extends AbstractProvider {
  readonly kind = "ollama" as const;

  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(params: {
    model: string;
    temperature: number;
    baseUrl: string;
    requestTimeoutMs: number;
  }) {
    super();
    this.model = params.model;
    this.temperature = params.temperature;
    this.baseUrl = params.baseUrl || "http://127.0.0.1:11434";
    this.requestTimeoutMs = params.requestTimeoutMs;
  }

  protected async complete(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string> {
    const response = await requestUrl({
      url: `${this.baseUrl.replace(/\/$/, "")}/api/chat`,
      method: "POST",
      throw: false,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.temperature
        }
      })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Ollama request failed with HTTP ${response.status}.`);
    }

    const json = response.json as {
      message?: {
        content?: string;
      };
    };
    return this.sanitizeText(json.message?.content ?? "");
  }
}
