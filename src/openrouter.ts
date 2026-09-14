import type { ExtensionSettings } from './settings';
import { PhaseTimer, TimingSummary } from './timing';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface OpenRouterRequestLog {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface OpenRouterResponseLog {
  status: number;
  statusText: string;
  bodyText: string;
  payload: unknown;
  choiceSummary: Record<string, unknown>;
  timings?: TimingSummary;
}

export interface OpenRouterResult {
  text: string;
  request: OpenRouterRequestLog;
  response: OpenRouterResponseLog;
  timings: TimingSummary;
}

export class OpenRouterResponseError extends Error {
  constructor(
    message: string,
    readonly request: OpenRouterRequestLog,
    readonly response: OpenRouterResponseLog
  ) {
    super(message);
    this.name = 'OpenRouterResponseError';
  }
}

export async function createOpenRouterCommitMessage(
  apiKey: string,
  messages: ChatMessage[],
  settings: ExtensionSettings,
  signal?: AbortSignal
): Promise<OpenRouterResult> {
  const timings = new PhaseTimer();
  const baseUrl = settings.openRouter.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  if (settings.openRouter.siteUrl.trim()) {
    headers['HTTP-Referer'] = settings.openRouter.siteUrl.trim();
  }

  if (settings.openRouter.appTitle.trim()) {
    headers['X-Title'] = settings.openRouter.appTitle.trim();
  }

  const body = {
    model: settings.openRouter.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxOutputTokens,
    stream: false,
    reasoning: {
      effort: 'none',
      exclude: true
    }
  };
  const request: OpenRouterRequestLog = {
    url,
    headers: {
      ...headers,
      Authorization: 'Bearer [REDACTED_OPENROUTER_KEY]'
    },
    body
  };

  const { response, text, payload } = await timings.measure('model request', async () => {
    const modelResponse = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(body)
    });
    const bodyText = await modelResponse.text();
    return { response: modelResponse, text: bodyText, payload: parseJson(bodyText) };
  });
  const choice = payload?.choices?.[0];
  const timingSummary = timings.snapshot();
  const responseLog: OpenRouterResponseLog = {
    status: response.status,
    statusText: response.statusText,
    bodyText: text,
    payload,
    choiceSummary: summarizeChoice(payload, choice),
    timings: timingSummary
  };

  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? text;
    throw new OpenRouterResponseError(`OpenRouter request failed (${response.status}): ${message}`, request, responseLog);
  }

  const result = extractCompletionText(payload, choice);

  if (!result.trim()) {
    throw new OpenRouterResponseError(buildEmptyResponseMessage(payload, choice), request, responseLog);
  }

  return {
    text: result,
    request,
    response: responseLog,
    timings: timingSummary
  };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractErrorMessage(payload: any): string | undefined {
  if (typeof payload?.error?.message === 'string') {
    return payload.error.message;
  }

  if (typeof payload?.message === 'string') {
    return payload.message;
  }

  return undefined;
}

function extractCompletionText(payload: any, choice: any): string {
  const content = choice?.message?.content;
  const normalizedContent = normalizeContent(content);

  if (normalizedContent.trim()) {
    return normalizedContent;
  }

  if (typeof choice?.text === 'string') {
    return choice.text;
  }

  if (typeof payload?.output_text === 'string') {
    return payload.output_text;
  }

  return '';
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') {
          return part;
        }

        if (typeof part?.text === 'string') {
          return part.text;
        }

        return '';
      })
      .join('');
  }

  return '';
}

function buildEmptyResponseMessage(payload: any, choice: any): string {
  const details = [
    `model=${stringOrUnknown(payload?.model)}`,
    `finish_reason=${stringOrUnknown(choice?.finish_reason)}`,
    `native_finish_reason=${stringOrUnknown(choice?.native_finish_reason)}`,
    `message_keys=${choice?.message ? Object.keys(choice.message).join(',') || 'none' : 'none'}`,
    `completion_tokens=${numberOrUnknown(payload?.usage?.completion_tokens)}`,
    `reasoning_tokens=${numberOrUnknown(payload?.usage?.completion_tokens_details?.reasoning_tokens)}`
  ];

  const finishReason = choice?.finish_reason;
  const hint = finishReason === 'length'
    ? ' The model likely used the output token budget before writing final text. Increase gitCommitPlanner.maxOutputTokens or choose a non-reasoning model.'
    : ' Try a concrete non-reasoning OpenRouter model or increase gitCommitPlanner.maxOutputTokens.';

  return `OpenRouter returned no message content (${details.join('; ')}).${hint}`;
}

function summarizeChoice(payload: any, choice: any): Record<string, unknown> {
  return {
    id: payload?.id,
    model: payload?.model,
    finish_reason: choice?.finish_reason,
    native_finish_reason: choice?.native_finish_reason,
    message_keys: choice?.message ? Object.keys(choice.message) : [],
    content_length: normalizeContent(choice?.message?.content).length,
    completion_tokens: payload?.usage?.completion_tokens,
    reasoning_tokens: payload?.usage?.completion_tokens_details?.reasoning_tokens,
    prompt_tokens: payload?.usage?.prompt_tokens,
    total_tokens: payload?.usage?.total_tokens
  };
}

function stringOrUnknown(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'unknown';
}

function numberOrUnknown(value: unknown): string {
  return typeof value === 'number' ? String(value) : 'unknown';
}
