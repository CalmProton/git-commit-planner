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
  reasoningFallback?: { status: number; message: string };
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

  const reasoningEffort = String(settings.openRouter.reasoningEffort ?? '').trim().toLowerCase();
  let body = buildRequestBody(settings, messages, reasoningEffort);
  let attempt = await timings.measure('model request', () =>
    sendChatCompletion(url, headers, body, signal)
  );
  let reasoningFallback: OpenRouterResponseLog['reasoningFallback'];

  // Some reasoning models reject `effort: "none"` because reasoning is
  // mandatory. Retry once without the reasoning field so the model can use its
  // own default. The first attempt is kept for diagnostics.
  if (reasoningEffort === 'none' && !attempt.response.ok && isReasoningUnsupportedError(attempt)) {
    reasoningFallback = {
      status: attempt.response.status,
      message: extractErrorMessage(attempt.payload) ?? attempt.text
    };
    body = buildRequestBody(settings, messages, '');
    attempt = await timings.measure('model request without reasoning', () =>
      sendChatCompletion(url, headers, body, signal)
    );
  }

  const { response, text, payload } = attempt;
  const request: OpenRouterRequestLog = {
    url,
    headers: {
      ...headers,
      Authorization: 'Bearer [REDACTED_OPENROUTER_KEY]'
    },
    body
  };
  const choice = payload?.choices?.[0];
  const timingSummary = timings.snapshot();
  const responseLog: OpenRouterResponseLog = {
    status: response.status,
    statusText: response.statusText,
    bodyText: text,
    payload,
    choiceSummary: summarizeChoice(payload, choice),
    ...(reasoningFallback ? { reasoningFallback } : {}),
    timings: timingSummary
  };

  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? text;
    const fallbackNote = reasoningFallback
      ? ` (reasoning fallback first attempt failed with ${reasoningFallback.status}: ${reasoningFallback.message})`
      : '';
    throw new OpenRouterResponseError(`OpenRouter request failed (${response.status}): ${message}${fallbackNote}`, request, responseLog);
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

function buildRequestBody(
  settings: ExtensionSettings,
  messages: ChatMessage[],
  reasoningEffort: string
): Record<string, unknown> {
  return {
    model: settings.openRouter.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxOutputTokens,
    stream: false,
    ...(reasoningEffort
      ? { reasoning: { effort: reasoningEffort, exclude: true } }
      : {})
  };
}

async function sendChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ response: Response; text: string; payload: any }> {
  const modelResponse = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body)
  });
  const bodyText = await modelResponse.text();
  return { response: modelResponse, text: bodyText, payload: parseJson(bodyText) };
}

function isReasoningUnsupportedError(attempt: { response: Response; text: string; payload: any }): boolean {
  if (![400, 404, 422].includes(attempt.response.status)) {
    return false;
  }

  const error = attempt.payload?.error;
  const parameter = typeof error?.param === 'string' ? error.param.toLowerCase() : '';
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';

  if (parameter.includes('reason') || code.includes('reason')) {
    return true;
  }

  const message = `${extractErrorMessage(attempt.payload) ?? ''} ${attempt.text}`.toLowerCase();
  const mentionsReasoning = message.includes('reasoning') || message.includes('effort') || message.includes('thinking');
  const soundsUnsupported = /(not supported|unsupported|unknown|unrecognized|invalid|required|mandatory|does not support|cannot|must be|not enabled|disabled|forbidden)/.test(message);

  return mentionsReasoning && soundsUnsupported;
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
    ? ' The model likely used the output token budget before writing final text. Increase gitCommitPlanner.maxOutputTokens, lower gitCommitPlanner.openRouter.reasoningEffort, or choose a non-reasoning model.'
    : ' Try lowering gitCommitPlanner.openRouter.reasoningEffort, choosing a concrete non-reasoning OpenRouter model, or increasing gitCommitPlanner.maxOutputTokens.';

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
