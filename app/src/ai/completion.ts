/**
 * Chat completions against the user's configured OpenAI-compatible provider.
 *
 * The request shape is the one every OpenAI-compatible service shares, so one client covers
 * DeepInfra, Mistral and self-hosted gateways. Error messages name the endpoint, because "HTTP
 * 404" is almost always a base URL that includes one path segment too many.
 */

import { ChatConfig } from './config';
import { AIProviderError, normalizeBaseUrl } from './provider-catalog';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = { role: ChatRole; content: string };

export type ChatRequest = {
  config: ChatConfig;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

/** How much of a message body reaches the model. Long threads would otherwise cost money. */
export const MAX_EMAIL_CHARS = 12000;

export function chatCompletionsEndpoint(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new AIProviderError('Enter a base URL first.');
  return `${base}/chat/completions`;
}

function explainChatStatus(status: number, endpoint: string): string {
  if (status === 401 || status === 403) {
    return 'The provider rejected the API key. Check the key in Preferences › AI.';
  }
  if (status === 404) {
    return `No chat endpoint at ${endpoint}. The base URL should stop at /v1 (or DeepInfra's /v1/openai), without /chat/completions.`;
  }
  if (status === 400 || status === 422) {
    return 'The provider rejected the request. The selected model may not accept chat messages.';
  }
  if (status === 429) {
    return 'The provider is rate limiting this key. Try again in a moment.';
  }
  if (status >= 500) {
    return `The provider returned a server error (HTTP ${status}). Try again later.`;
  }
  return `The provider returned HTTP ${status}.`;
}

/** Providers return either a string or a list of content parts; flatten both. */
function contentOf(payload: unknown): string | null {
  const choices = (payload as any)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = choices[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'string' ? part : part?.text))
      .filter((part) => typeof part === 'string')
      .join('');
    return text || null;
  }
  return null;
}

export async function completeChat({
  config,
  messages,
  maxTokens = 400,
  temperature = 0.2,
  signal,
}: ChatRequest): Promise<string> {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new AIProviderError('No AI provider is configured. Add one in Preferences › AI.');
  }
  const endpoint = chatCompletionsEndpoint(config.baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AIProviderError(
      `Could not reach ${endpoint}. Check the base URL and your network connection.`
    );
  }

  if (!response.ok) {
    throw new AIProviderError(explainChatStatus(response.status, endpoint), response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AIProviderError('The provider returned a response that is not JSON.');
  }

  const text = contentOf(payload)?.trim();
  if (!text) {
    throw new AIProviderError('The provider returned an empty reply.');
  }
  return text;
}

/** Strip markup so the model sees readable text instead of tags and inline styles. */
export function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Email bodies carry <style> blocks whose CSS text would otherwise land in the prompt.
    doc.querySelectorAll('style, script').forEach((node) => node.remove());
    const text = doc.body ? doc.body.textContent || '' : '';
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SummarizeEmailInput = {
  config: ChatConfig;
  subject?: string;
  from?: string;
  body?: string;
  /** When true the body is already plain text, so it is not parsed as HTML. */
  plaintext?: boolean;
  snippet?: string;
  signal?: AbortSignal;
};

export function summarizePrompt(input: SummarizeEmailInput): ChatMessage[] {
  const raw = input.body || input.snippet || '';
  const text = (input.plaintext ? raw : htmlToText(raw)).slice(0, MAX_EMAIL_CHARS);
  if (!text.trim()) {
    throw new AIProviderError('This message has no text to summarize.');
  }

  return [
    {
      role: 'system',
      content:
        'You summarize emails for a busy reader. Reply in the language of the email itself. ' +
        'Say who wants what, any deadline, and the single action the reader has to take. ' +
        'Use at most four sentences, plain prose, no headings and no preamble.',
    },
    {
      role: 'user',
      content: `Subject: ${input.subject || '(none)'}\nFrom: ${input.from || '(unknown)'}\n\n${text}`,
    },
  ];
}

export async function summarizeEmail(input: SummarizeEmailInput): Promise<string> {
  return completeChat({
    config: input.config,
    messages: summarizePrompt(input),
    maxTokens: 300,
    temperature: 0.1,
    signal: input.signal,
  });
}

export type ProviderTestResult = { reply: string; elapsedMs: number };

/** Smallest possible round trip, so the settings tab can prove the key and model work. */
export async function testChatProvider(
  config: ChatConfig,
  signal?: AbortSignal
): Promise<ProviderTestResult> {
  const started = Date.now();
  const reply = await completeChat({
    config,
    messages: [
      { role: 'system', content: 'You are a connection test. Answer with one short word.' },
      { role: 'user', content: 'Reply with the word: ready' },
    ],
    maxTokens: 16,
    temperature: 0,
    signal,
  });
  return { reply, elapsedMs: Date.now() - started };
}
