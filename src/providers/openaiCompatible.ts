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

  async sendChat(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string> {
    if (!options?.onChunk) {
      return super.sendChat(messages, options);
    }

    return this.completeStreaming(messages, options);
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
        max_tokens: options?.maxTokens ?? 2400,
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

  private async completeStreaming(messages: LLMChatMessage[], options: SendChatOptions): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model ?? this.model,
          messages,
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens ?? 2400,
          stream: true
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Provider request failed with HTTP ${response.status}.`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Streaming response body was not available.");
      }

      const decoder = new TextDecoder("utf-8");
      let eventBuffer = "";
      let fullText = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        eventBuffer += decoder.decode(value, { stream: true });
        const events = eventBuffer.split(/\n\n/);
        eventBuffer = events.pop() ?? "";

        for (const event of events) {
          const payloads = event
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .filter(Boolean);

          for (const payload of payloads) {
            if (payload === "[DONE]") {
              continue;
            }
            const delta = this.extractStreamingDelta(payload);
            if (!delta) {
              continue;
            }
            fullText += delta;
            await options.onChunk?.(delta, fullText);
          }
        }
      }

      if (eventBuffer.trim()) {
        const payloads = eventBuffer
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter(Boolean);
        for (const payload of payloads) {
          if (payload === "[DONE]") {
            continue;
          }
          const delta = this.extractStreamingDelta(payload);
          if (!delta) {
            continue;
          }
          fullText += delta;
          await options.onChunk?.(delta, fullText);
        }
      }

      return this.sanitizeText(fullText);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Provider request timed out after ${this.requestTimeoutMs} ms.`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  private extractStreamingDelta(payload: string): string {
    const json = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

    const choice = json.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    if (Array.isArray(content)) {
      return content.map((part) => part.text ?? "").join("");
    }
    return content ?? "";
  }
}
