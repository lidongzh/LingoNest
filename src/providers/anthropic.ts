import { requestUrl } from "obsidian";
import type { LLMChatMessage, SendChatOptions } from "../types";
import { AbstractProvider } from "./base";

export class AnthropicProvider extends AbstractProvider {
  readonly kind = "anthropic" as const;

  private readonly model: string;
  private readonly temperature: number;
  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;

  constructor(params: {
    model: string;
    temperature: number;
    apiKey: string;
    requestTimeoutMs: number;
  }) {
    super();
    this.model = params.model;
    this.temperature = params.temperature;
    this.apiKey = params.apiKey;
    this.requestTimeoutMs = params.requestTimeoutMs;
  }

  protected async complete(messages: LLMChatMessage[], options?: SendChatOptions): Promise<string> {
    const systemMessages = messages.filter((message) => message.role === "system").map((message) => message.content);
    const conversation = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: [{ type: "text", text: message.content }]
      }));

    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      throw: false,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: options?.model ?? this.model,
        system: systemMessages.join("\n\n"),
        messages: conversation,
        max_tokens: options?.maxTokens ?? 2400,
        temperature: options?.temperature ?? this.temperature
      })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Anthropic request failed with HTTP ${response.status}.`);
    }

    const json = response.json as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (json.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return this.sanitizeText(text);
  }
}
