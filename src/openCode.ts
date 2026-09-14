import { ChildProcess, spawn } from 'child_process';
import { createServer } from 'net';
import type { ChatMessage } from './openrouter';
import type { ExtensionSettings } from './settings';
import { isRecord } from './codexProtocol';
import { PhaseTimer, TimingSummary } from './timing';

const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const HEALTH_POLL_INTERVAL_MS = 200;
const MAX_STDERR_CHARS = 8_000;

const FALLBACK_TOOL_IDS = [
  'bash',
  'edit',
  'write',
  'patch',
  'read',
  'glob',
  'grep',
  'list',
  'task',
  'webfetch',
  'websearch',
  'codesearch',
  'todowrite',
  'todoread',
  'question',
  'lsp'
];

export interface OpenCodeModel {
  providerID: string;
  modelID: string;
  reference: string;
  displayName: string;
  description: string;
  variants: string[];
  connected: boolean;
  isDefault: boolean;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  connected: boolean;
  models: OpenCodeModel[];
}

export interface OpenCodeRequestLog {
  method: string;
  url: string;
  body?: unknown;
}

export interface OpenCodeResponseLog {
  status: number;
  statusText: string;
  bodyText: string;
  payload: unknown;
  summary: Record<string, unknown>;
  stderr?: string;
  timings?: TimingSummary;
}

export interface OpenCodeGenerationResult {
  text: string;
  request: OpenCodeRequestLog;
  response: OpenCodeResponseLog;
  timings: TimingSummary;
}

export class OpenCodeResponseError extends Error {
  constructor(
    message: string,
    readonly request: OpenCodeRequestLog,
    readonly response: OpenCodeResponseLog
  ) {
    super(message);
    this.name = 'OpenCodeResponseError';
  }
}

export class OpenCodeClient {
  private child: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private startPromise: Promise<void> | undefined;
  private disposed = false;
  private stderrBuffer = '';
  private readonly deniedToolsByDirectory = new Map<string, Record<string, boolean>>();

  constructor(
    private readonly command: string,
    private readonly configuredServerUrl = '',
    private readonly clientVersion = '2.1.0'
  ) {}

  async listProviders(cwd: string, signal?: AbortSignal): Promise<OpenCodeProvider[]> {
    await this.start(cwd, signal);
    const payload = await this.request<unknown>('GET', '/provider', cwd, undefined, signal);
    return normalizeProviders(payload);
  }

  async listModels(cwd: string, signal?: AbortSignal): Promise<OpenCodeModel[]> {
    const providers = await this.listProviders(cwd, signal);
    const connectedModels = providers
      .filter(provider => provider.connected)
      .flatMap(provider => provider.models);

    return (connectedModels.length > 0 ? connectedModels : providers.flatMap(provider => provider.models))
      .sort((left, right) => left.reference.localeCompare(right.reference));
  }

  async generate(
    messages: readonly ChatMessage[],
    cwd: string,
    settings: ExtensionSettings,
    outputSchema?: unknown,
    signal?: AbortSignal
  ): Promise<OpenCodeGenerationResult> {
    const timings = new PhaseTimer();

    try {
      await timings.measure('server readiness', () => this.start(cwd, signal));

      const sessionPayload = await timings.measure('session startup', () => this.request<unknown>(
        'POST',
        '/session',
        cwd,
        { title: 'Git Commit Planner' },
        signal
      ));
      const sessionId = getStringProperty(sessionPayload, 'id');

      if (!sessionId) {
        throw this.invalidResponse(
          'POST',
          '/session',
          cwd,
          { title: 'Git Commit Planner' },
          sessionPayload,
          'OpenCode did not return a session id.'
        );
      }

      const onAbort = () => {
        void this.abortSession(sessionId, cwd);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let generationResult: Omit<OpenCodeGenerationResult, 'timings'>;

      try {
        const model = parseModelReference(settings.opencode.model);
        const variant = settings.opencode.variant.trim() || model?.variant;
        const system = messages
          .filter(message => message.role === 'system')
          .map(message => message.content.trim())
          .filter(Boolean)
          .join('\n\n');
        const userPrompt = messages
          .filter(message => message.role === 'user')
          .map(message => message.content)
          .join('\n\n');
        const tools = await timings.measure('tool policy', () => this.getDeniedTools(cwd, signal));
        const format = outputSchema && isRecord(outputSchema)
          ? { type: 'json_schema', schema: outputSchema, retryCount: 2 }
          : undefined;
        const body: Record<string, unknown> = {
          ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          ...(variant ? { variant } : {}),
          ...(system ? { system } : {}),
          tools,
          ...(format ? { format } : {}),
          parts: [{ type: 'text', text: userPrompt }]
        };

        const result = await timings.measure('model turn', () => this.prompt(sessionId, cwd, body, signal));
        generationResult = this.toGenerationResult(result.payload, result.request, result.response);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await timings.measure('session cleanup', () => this.deleteSession(sessionId, cwd));
      }

      const timingSummary = timings.snapshot();
      generationResult.response.timings = timingSummary;
      return { ...generationResult, timings: timingSummary };
    } catch (error) {
      if (error instanceof OpenCodeResponseError) {
        error.response.timings = timings.snapshot();
      }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.baseUrl = undefined;
    this.deniedToolsByDirectory.clear();
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private async prompt(
    sessionId: string,
    cwd: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: unknown; request: OpenCodeRequestLog; response: OpenCodeResponseLog }> {
    const request = this.createRequest('POST', `/session/${encodeURIComponent(sessionId)}/message`, cwd, body);

    const response = await this.requestWithLog(request, signal);
    if (response.status >= 200 && response.status < 300) {
      if (hasUnsupportedThinkingToolChoiceError(response) && 'format' in body) {
        return this.retryWithoutFormat(request, body, signal);
      }
      return { payload: response.payload, request, response };
    }

    const error = this.responseError(request, response);
    if (!hasUnsupportedFormatError(error) || !('format' in body)) {
      throw error;
    }

    return this.retryWithoutFormat(request, body, signal);
  }

  private async retryWithoutFormat(
    request: OpenCodeRequestLog,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ payload: unknown; request: OpenCodeRequestLog; response: OpenCodeResponseLog }> {
    const fallbackBody = { ...body };
    delete fallbackBody.format;
    const fallbackRequest = this.createRequest(request.method, request.url, undefined, fallbackBody);
    const fallbackResponse = await this.requestWithLog(fallbackRequest, signal);
    if (fallbackResponse.status < 200 || fallbackResponse.status >= 300) {
      throw this.responseError(fallbackRequest, fallbackResponse);
    }
    return { payload: fallbackResponse.payload, request: fallbackRequest, response: fallbackResponse };
  }

  private async deleteSession(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.request('DELETE', `/session/${encodeURIComponent(sessionId)}`, cwd);
    } catch {
      // Session cleanup must not replace the provider result.
    }
  }

  private async abortSession(sessionId: string, cwd: string): Promise<void> {
    try {
      await this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, cwd, undefined);
    } catch {
      // The caller's abort signal remains the source of truth.
    }
  }

  private async getDeniedTools(cwd: string, signal?: AbortSignal): Promise<Record<string, boolean>> {
    const cached = this.deniedToolsByDirectory.get(cwd);
    if (cached) {
      return cached;
    }

    let toolIds = FALLBACK_TOOL_IDS;
    try {
      const payload = await this.request<unknown>('GET', '/experimental/tool/ids', cwd, undefined, signal);
      const discovered = extractToolIds(payload);
      if (discovered.length > 0) {
        toolIds = discovered;
      }
    } catch (error) {
      if (!(error instanceof OpenCodeResponseError) || ![404, 405].includes(error.response.status)) {
        throw error;
      }
    }

    const deniedTools = Object.fromEntries(
      [...new Set([...toolIds, ...FALLBACK_TOOL_IDS])]
        .filter(toolId => toolId !== 'StructuredOutput')
        .map(toolId => [toolId, false])
    );
    this.deniedToolsByDirectory.set(cwd, deniedTools);
    return deniedTools;
  }

  private async start(cwd: string, signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw new Error('OpenCode client is disposed.');
    }

    if (this.configuredServerUrl.trim()) {
      const url = normalizeServerUrl(this.configuredServerUrl);
      this.baseUrl = url;
      await waitForHealth(url, signal, undefined, this.getAuthorizationHeader());
      return;
    }

    if (this.baseUrl && this.child) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.spawnServer(cwd, signal);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async spawnServer(cwd: string, signal?: AbortSignal): Promise<void> {
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const command = stripOuterQuotes(this.command.trim() || 'opencode');
    const child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.child = child;
    this.baseUrl = baseUrl;
    this.stderrBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', error => {
      if (this.child === child && !this.disposed) {
        this.baseUrl = undefined;
      }
      void error;
    });
    child.on('close', () => {
      if (this.child !== child) {
        return;
      }

      this.child = undefined;
      this.baseUrl = undefined;
      this.deniedToolsByDirectory.clear();
    });

    try {
      await waitForHealth(baseUrl, signal, child, this.getAuthorizationHeader());
    } catch (error) {
      child.kill();
      this.child = undefined;
      this.baseUrl = undefined;
      const message = this.stderrBuffer.trim();
      if (message && error instanceof Error && !error.message.includes(message)) {
        throw new Error(`${error.message} ${message}`);
      }
      throw error;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    cwd: string | undefined,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const request = this.createRequest(method, path, cwd, body);
    const response = await this.requestWithLog(request, signal);

    if (response.status < 200 || response.status >= 300) {
      throw this.responseError(request, response);
    }

    return response.payload as T;
  }

  private responseError(request: OpenCodeRequestLog, response: OpenCodeResponseLog): OpenCodeResponseError {
    return new OpenCodeResponseError(
      `OpenCode request failed (${response.status}): ${extractErrorMessage(response.payload) ?? (response.bodyText || response.statusText || 'Unknown error')}`,
      request,
      response
    );
  }

  private async requestWithLog(request: OpenCodeRequestLog, signal?: AbortSignal): Promise<OpenCodeResponseLog> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...this.getAuthorizationHeader()
    };
    let response: Response;
    let bodyText = '';

    try {
      response = await fetchWithTimeout(
        request.url,
        {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
        },
        signal,
        REQUEST_TIMEOUT_MS
      );
      bodyText = await response.text();
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const responseLog: OpenCodeResponseLog = {
        status: 0,
        statusText: '',
        bodyText: '',
        payload: undefined,
        summary: { error: error instanceof Error ? error.message : String(error) },
        stderr: this.stderrBuffer || undefined
      };
      throw new OpenCodeResponseError(
        `Could not reach the OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
        request,
        responseLog
      );
    }

    const payload = parseJson(bodyText);
    return {
      status: response.status,
      statusText: response.statusText,
      bodyText,
      payload,
      summary: summarizeResponse(payload),
      stderr: this.stderrBuffer || undefined
    };
  }

  private createRequest(method: string, path: string, cwd?: string, body?: unknown): OpenCodeRequestLog {
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new Error('OpenCode server is not running.');
    }

    const url = path.startsWith('http://') || path.startsWith('https://')
      ? new URL(path)
      : new URL(path, `${baseUrl}/`);
    if (cwd) {
      url.searchParams.set('directory', cwd);
    }

    return {
      method,
      url: url.toString(),
      ...(body === undefined ? {} : { body })
    };
  }

  private getAuthorizationHeader(): Record<string, string> {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) {
      return {};
    }

    const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  }

  private invalidResponse(
    method: string,
    path: string,
    cwd: string,
    body: unknown,
    payload: unknown,
    message: string
  ): OpenCodeResponseError {
    const request = this.createRequest(method, path, cwd, body);
    return new OpenCodeResponseError(message, request, {
      status: 200,
      statusText: 'OK',
      bodyText: JSON.stringify(payload),
      payload,
      summary: summarizeResponse(payload),
      stderr: this.stderrBuffer || undefined
    });
  }

  private toGenerationResult(
    payload: unknown,
    request: OpenCodeRequestLog,
    response: OpenCodeResponseLog
  ): Omit<OpenCodeGenerationResult, 'timings'> {
    const errorMessage = extractAssistantError(payload);
    if (errorMessage) {
      response.summary.error = errorMessage;
      throw new OpenCodeResponseError(`OpenCode generation failed: ${errorMessage}`, request, response);
    }

    const text = extractOpenCodeText(payload);
    if (!text.trim()) {
      response.summary.error = 'No assistant text returned.';
      throw new OpenCodeResponseError('OpenCode returned no assistant text.', request, response);
    }

    return { text, request, response };
  }
}

export interface OpenCodeModelReference {
  providerID: string;
  modelID: string;
  variant?: string;
}

export function parseModelReference(value: string): OpenCodeModelReference | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const hashIndex = trimmed.indexOf('#');
  const modelReference = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const variant = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : undefined;
  const slashIndex = modelReference.indexOf('/');

  if (slashIndex <= 0 || slashIndex === modelReference.length - 1) {
    throw new Error('OpenCode model must use the provider/model format. Use Select OpenCode Model to choose one.');
  }

  const providerID = modelReference.slice(0, slashIndex).trim();
  const modelID = modelReference.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) {
    throw new Error('OpenCode model must use the provider/model format. Use Select OpenCode Model to choose one.');
  }

  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

export function extractOpenCodeText(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }

  const info = isRecord(payload.info) ? payload.info : undefined;
  if (info && 'structured' in info && info.structured !== undefined) {
    const structured = JSON.stringify(info.structured);
    return structured ?? '';
  }

  if (Array.isArray(payload.parts)) {
    const parts = payload.parts
      .filter(isRecord)
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => String(part.text));
    if (parts.join('').trim()) {
      return parts.join('');
    }
  }

  for (const key of ['text', 'output_text', 'content']) {
    if (typeof payload[key] === 'string') {
      return payload[key] as string;
    }
  }

  return '';
}

function normalizeProviders(payload: unknown): OpenCodeProvider[] {
  if (!isRecord(payload)) {
    return [];
  }

  const connected = new Set(
    Array.isArray(payload.connected)
      ? payload.connected.filter((value): value is string => typeof value === 'string')
      : []
  );
  const defaults = isRecord(payload.default) ? payload.default : {};
  const rawProviders = Array.isArray(payload.all)
    ? payload.all
    : isRecord(payload.providers)
      ? Object.entries(payload.providers).map(([id, value]) => ({ id, ...(isRecord(value) ? value : {}) }))
      : [];

  return rawProviders.flatMap(value => {
    if (!isRecord(value)) {
      return [];
    }

    const id = getStringProperty(value, 'id');
    if (!id) {
      return [];
    }

    const providerConnected = connected.size === 0 || connected.has(id);
    const rawModels = isRecord(value.models) ? Object.entries(value.models) : [];
    const models = rawModels.flatMap(([modelID, rawModel]) => {
      if (!isRecord(rawModel)) {
        return [];
      }

      const modelName = getStringProperty(rawModel, 'name') ?? modelID;
      const variants = normalizeVariants(rawModel.variants);
      const defaultModel = defaults[id];
      const isDefault = defaultModel === modelID || defaultModel === `${id}/${modelID}`;
      return [{
        providerID: id,
        modelID,
        reference: `${id}/${modelID}`,
        displayName: `${getStringProperty(value, 'name') ?? id}: ${modelName}`,
        description: getStringProperty(rawModel, 'description') ?? '',
        variants,
        connected: providerConnected,
        isDefault
      }];
    });

    return [{
      id,
      name: getStringProperty(value, 'name') ?? id,
      connected: providerConnected,
      models
    }];
  });
}

function normalizeVariants(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => typeof item === 'string' ? [item] : isRecord(item) && typeof item.id === 'string' ? [item.id] : []);
  }

  return isRecord(value) ? Object.keys(value) : [];
}

function extractToolIds(payload: unknown): string[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.ids)
      ? payload.ids
      : isRecord(payload) && Array.isArray(payload.tools)
        ? payload.tools
        : [];

  return values.flatMap(value => {
    if (typeof value === 'string') {
      return [value];
    }
    return isRecord(value) && typeof value.id === 'string' ? [value.id] : [];
  });
}

function extractAssistantError(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const info = isRecord(payload.info) ? payload.info : undefined;
  const error = info && 'error' in info ? info.error : 'error' in payload ? payload.error : undefined;
  return error === undefined ? undefined : extractErrorMessage(error);
}

function extractErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ['message', 'error', 'detail']) {
    const message = value[key];
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  const data = value.data;
  if (data !== value) {
    const nested = extractErrorMessage(data);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function summarizeResponse(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return { payloadType: typeof payload };
  }

  const info = isRecord(payload.info) ? payload.info : undefined;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return {
    sessionId: getStringProperty(info, 'sessionID'),
    messageId: getStringProperty(info, 'id'),
    provider: getStringProperty(info, 'providerID'),
    model: getStringProperty(info, 'modelID'),
    finish: getStringProperty(info, 'finish'),
    partCount: parts.length,
    textLength: extractOpenCodeText(payload).length
  };
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function getStringProperty(value: unknown, property: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value[property] === 'string' ? value[property] as string : undefined;
}

function parseJson(value: string): unknown {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hasUnsupportedFormatError(error: unknown): boolean {
  if (!(error instanceof OpenCodeResponseError) || error.response.status !== 400) {
    return false;
  }

  const message = `${error.message} ${error.response.bodyText}`.toLowerCase();
  return message.includes('format') || message.includes('unknown key') || message.includes('unrecognized');
}

function hasUnsupportedThinkingToolChoiceError(response: OpenCodeResponseLog): boolean {
  const message = `${extractAssistantError(response.payload) ?? ''} ${response.bodyText}`.toLowerCase();
  return message.includes('thinking mode') && message.includes('tool_choice');
}

async function waitForHealth(
  baseUrl: string,
  signal: AbortSignal | undefined,
  child: ChildProcess | undefined,
  headers: Record<string, string>
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'The server did not respond.';
  let childError: Error | undefined;
  const onChildError = (error: Error) => {
    childError = error;
  };
  child?.once('error', onChildError);

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      if (childError) {
        throw childError;
      }
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        throw new Error(`OpenCode server exited with code ${child.exitCode}.`);
      }

      try {
        const response = await fetchWithTimeout(
          `${baseUrl}/global/health`,
          { headers },
          signal,
          HEALTH_REQUEST_TIMEOUT_MS
        );
        if (response.ok) {
          return;
        }
        lastError = `HTTP ${response.status}.`;
      } catch (error) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        lastError = error instanceof Error ? error.message : String(error);
      }

      await delay(HEALTH_POLL_INTERVAL_MS, signal);
    }
  } finally {
    child?.removeListener('error', onChildError);
  }

  throw new Error(`OpenCode server did not become ready within ${START_TIMEOUT_MS / 1000} seconds. ${lastError}`);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    setTimeout(() => signal?.removeEventListener('abort', onAbort), milliseconds);
  });
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Could not find a free local port for OpenCode.'));
          return;
        }
        resolve(port);
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function createAbortError(): Error {
  const error = new Error('OpenCode generation was cancelled.');
  error.name = 'AbortError';
  return error;
}
