import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import type { ChatMessage } from './openrouter';
import type { ExtensionSettings } from './settings';
import { PhaseTimer, TimingSummary } from './timing';
import {
  COMMIT_MESSAGE_OUTPUT_SCHEMA,
  extractAgentMessageTexts,
  getBooleanProperty,
  getStringProperty,
  isRecord,
  JsonRpcId,
  JsonRpcMessage,
  parseJsonLine
} from './codexProtocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STDERR_CHARS = 8_000;

export interface CodexAccountStatus {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  isDefault: boolean;
}

export interface CodexRequestLog {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexResponseLog {
  status: 'success' | 'error';
  resultSummary?: Record<string, unknown>;
  error?: Record<string, unknown>;
  stderr?: string;
  timings?: TimingSummary;
}

export interface CodexGenerationResult {
  text: string;
  request: CodexRequestLog;
  response: CodexResponseLog;
  timings: TimingSummary;
}

export interface CodexLoginStart {
  loginId: string;
  authUrl: string;
}

interface PendingRequest {
  method: string;
  request: CodexRequestLog;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface CompletedTurn {
  threadId: string;
  turn: unknown;
}

interface LoginCompletion {
  loginId: string;
  success: boolean;
  error: string | null;
}

type NotificationListener = (notification: { method: string; params?: unknown }) => void;

export class CodexResponseError extends Error {
  constructor(
    message: string,
    readonly request: CodexRequestLog,
    readonly response: CodexResponseLog
  ) {
    super(message);
    this.name = 'CodexResponseError';
  }
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private disposed = false;
  private nextRequestId = 1;
  private receiveBuffer = '';
  private stderrBuffer = '';
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly completedTurns = new Map<string, CompletedTurn>();
  private readonly turnAgentMessages = new Map<string, Map<string, string>>();
  private readonly loginCompletions = new Map<string, LoginCompletion>();

  constructor(
    private readonly command: string,
    private readonly clientVersion = '2.0.0',
    private readonly fastMode = false
  ) {}

  async accountRead(signal?: AbortSignal): Promise<CodexAccountStatus> {
    await this.start();
    const result = await this.request<unknown>('account/read', { refreshToken: false }, signal);
    const account = normalizeAccount(isRecord(result) ? result.account : undefined);

    return {
      account,
      requiresOpenaiAuth: getBooleanProperty(result, 'requiresOpenaiAuth') ?? false
    };
  }

  async startChatGPTLogin(signal?: AbortSignal): Promise<CodexLoginStart> {
    await this.start();
    const result = await this.request<unknown>(
      'account/login/start',
      {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'codex'
      },
      signal
    );

    const loginId = getStringProperty(result, 'loginId');
    const authUrl = getStringProperty(result, 'authUrl');

    if (!loginId || !authUrl) {
      throw this.invalidResponse('account/login/start', result, 'Codex did not return a ChatGPT login URL.');
    }

    return { loginId, authUrl };
  }

  async waitForLoginCompletion(
    loginId: string,
    signal?: AbortSignal,
    timeoutMs = LOGIN_TIMEOUT_MS
  ): Promise<{ success: boolean; error: string | null }> {
    const existing = this.loginCompletions.get(loginId);
    if (existing) {
      this.loginCompletions.delete(loginId);
      return { success: existing.success, error: existing.error };
    }

    const result = await this.waitForNotification(
      'account/login/completed',
      params => getStringProperty(params, 'loginId') === loginId,
      signal,
      timeoutMs
    );
    const success = getBooleanProperty(result, 'success') ?? false;
    const error = getStringProperty(result, 'error') ?? null;
    this.loginCompletions.delete(loginId);
    return { success, error };
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.start();
    await this.request('account/login/cancel', { loginId }, undefined, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async logout(signal?: AbortSignal): Promise<void> {
    await this.start();
    await this.request('account/logout', undefined, signal);
  }

  async listModels(signal?: AbortSignal): Promise<CodexModel[]> {
    await this.start();
    const models: CodexModel[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const result = await this.request<unknown>(
        'model/list',
        {
          ...(cursor ? { cursor } : {}),
          limit: 200,
          includeHidden: false
        },
        signal
      );

      const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        const model = normalizeModel(value);
        if (model && !model.hidden) {
          models.push(model);
        }
      }

      const nextCursor = getStringProperty(result, 'nextCursor');
      if (!nextCursor || nextCursor === cursor) {
        break;
      }

      cursor = nextCursor;
    }

    return uniqueModels(models);
  }

  async generate(
    messages: readonly ChatMessage[],
    cwd: string,
    settings: ExtensionSettings,
    outputSchema: unknown = COMMIT_MESSAGE_OUTPUT_SCHEMA,
    signal?: AbortSignal
  ): Promise<CodexGenerationResult> {
    const timings = new PhaseTimer();

    try {
      await timings.measure('app server readiness', () => this.start());

      const model = settings.codex.model.trim();
      const developerInstructions = messages
        .filter(message => message.role === 'system')
        .map(message => message.content.trim())
        .filter(Boolean)
        .join('\n\n');
      const userPrompt = messages
        .filter(message => message.role === 'user')
        .map(message => message.content)
        .join('\n\n');

      const threadParams: Record<string, unknown> = {
        ...(model ? { model } : {}),
        cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        ...(developerInstructions ? { developerInstructions } : {})
      };
      const threadResult = await timings.measure('thread startup', () =>
        this.request<unknown>('thread/start', threadParams, undefined, DEFAULT_REQUEST_TIMEOUT_MS)
      );
      const thread = isRecord(threadResult) ? threadResult.thread : undefined;
      const threadId = getStringProperty(thread, 'id');

      if (!threadId) {
        throw this.invalidResponse('thread/start', threadResult, 'Codex did not return a thread id.');
      }

      const effort = settings.codex.reasoningEffort.trim();
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: userPrompt, text_elements: [] }],
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        outputSchema
      };
      const turnResult = await timings.measure('turn startup', () =>
        this.request<unknown>('turn/start', turnParams, undefined, DEFAULT_REQUEST_TIMEOUT_MS)
      );
      const initialTurn = isRecord(turnResult) ? turnResult.turn : undefined;
      const turnId = getStringProperty(initialTurn, 'id');

      if (!turnId) {
        throw this.invalidResponse('turn/start', turnResult, 'Codex did not return a turn id.');
      }

      const request: CodexRequestLog = {
        method: 'turn/start',
        params: {
          threadId,
          model: model || '(Codex default)',
          cwd,
          inputCount: 1,
          outputSchema
        }
      };

      let finalTurn: unknown;
      const initialStatus = getStringProperty(initialTurn, 'status');
      if (initialStatus === 'completed' || initialStatus === 'failed' || initialStatus === 'interrupted') {
        finalTurn = timings.measureSync('model turn', () => initialTurn);
      } else {
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          void this.request('turn/interrupt', { threadId, turnId }, undefined, 10_000).catch(() => undefined);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
          finalTurn = (await timings.measure('model turn', () =>
            this.waitForTurn(threadId, turnId, request, signal)
          )).turn;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }

        if (aborted || signal?.aborted) {
          throw createAbortError();
        }
      }

      const timingSummary = timings.snapshot();
      const response: CodexResponseLog = {
        status: 'success',
        resultSummary: summarizeTurn(finalTurn),
        stderr: this.stderrBuffer || undefined,
        timings: timingSummary
      };
      const text = this.extractFinalTurnText(threadId, turnId, finalTurn, request, response);

      return { text, request, response, timings: timingSummary };
    } catch (error) {
      if (error instanceof CodexResponseError) {
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
    this.initialized = false;
    const child = this.child;
    this.child = undefined;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error('Codex App Server was stopped.'));
    }
    this.pending.clear();
    child?.kill();
  }

  private async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('Codex App Server client is disposed.');
    }

    if (this.initialized && this.child) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    const child = spawn(this.command, buildCodexAppServerArgs(this.fastMode), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    this.initialized = false;
    this.receiveBuffer = '';
    this.stderrBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(String(chunk)));
    child.stderr.on('data', chunk => this.handleStderr(String(chunk)));
    child.on('error', error => this.handleProcessFailure(error));
    child.on('close', (code, signal) => {
      if (this.child !== child) {
        return;
      }

      this.child = undefined;
      this.initialized = false;
      if (!this.disposed) {
        this.handleProcessFailure(new Error(`Codex App Server exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''}).`));
      }
    });

    await this.requestInternal(
      'initialize',
      {
        clientInfo: {
          name: 'git-commit-planner',
          title: 'Git Commit Planner',
          version: this.clientVersion
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      },
      undefined,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.sendMessage({ method: 'initialized', params: {} });
    this.initialized = true;
  }

  private request<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    return this.requestInternal<T>(method, params, signal, timeoutMs);
  }

  private requestInternal<T>(
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('Codex App Server is not running.'));
    }

    const id = this.nextRequestId++;
    const request = summarizeRequest(method, params);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbortListener();
        reject(new CodexResponseError(`Codex App Server request timed out: ${method}.`, request, {
          status: 'error',
          error: { message: 'Request timed out.' },
          stderr: this.stderrBuffer || undefined
        }));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(createAbortError());
      };
      const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);

      this.pending.set(id, {
        method,
        request,
        resolve: value => resolve(value as T),
        reject,
        timer,
        removeAbortListener
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.sendMessage({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        removeAbortListener();
        reject(error);
      }
    });
  }

  private sendMessage(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error('Codex App Server is not running.');
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.receiveBuffer += chunk;
    let newlineIndex = this.receiveBuffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = this.receiveBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        const message = parseJsonLine(line);
        if (message) {
          this.handleMessage(message);
        }
      }
      newlineIndex = this.receiveBuffer.indexOf('\n');
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_CHARS);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();

      if (message.error) {
        const response: CodexResponseLog = {
          status: 'error',
          error: {
            code: message.error.code,
            message: message.error.message,
            data: message.error.data
          },
          stderr: this.stderrBuffer || undefined
        };
        pending.reject(new CodexResponseError(
          `Codex App Server request failed (${message.error.code}): ${message.error.message}`,
          pending.request,
          response
        ));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (isRequest(message)) {
      try {
        this.sendMessage({
          id: message.id,
          error: {
            code: -32601,
            message: `Git Commit Planner does not support the Codex server request: ${message.method}.`
          }
        });
      } catch {
        // The process close handler reports the transport failure.
      }
      return;
    }

    if (isNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleNotification(message: { method: string; params?: unknown }): void {
    const params = message.params;

    if (message.method === 'turn/completed') {
      const threadId = getStringProperty(params, 'threadId');
      const turn = isRecord(params) ? params.turn : undefined;
      const turnId = getStringProperty(turn, 'id');
      if (threadId && turnId) {
        this.completedTurns.set(turnKey(threadId, turnId), { threadId, turn });
      }
    } else if (message.method === 'agentMessage/delta') {
      const threadId = getStringProperty(params, 'threadId');
      const turnId = getStringProperty(params, 'turnId');
      const itemId = getStringProperty(params, 'itemId');
      const delta = getStringProperty(params, 'delta');
      if (threadId && turnId && itemId && delta) {
        this.appendAgentMessage(threadId, turnId, itemId, delta);
      }
    } else if (message.method === 'item/completed') {
      const threadId = getStringProperty(params, 'threadId');
      const turnId = getStringProperty(params, 'turnId');
      const item = isRecord(params) ? params.item : undefined;
      const itemId = getStringProperty(item, 'id');
      const text = getStringProperty(item, 'text');
      if (threadId && turnId && itemId && getStringProperty(item, 'type') === 'agentMessage' && text) {
        this.setAgentMessage(threadId, turnId, itemId, text);
      }
    } else if (message.method === 'account/login/completed') {
      const loginId = getStringProperty(params, 'loginId');
      if (loginId) {
        this.loginCompletions.set(loginId, {
          loginId,
          success: getBooleanProperty(params, 'success') ?? false,
          error: getStringProperty(params, 'error') ?? null
        });
      }
    }

    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }

  private appendAgentMessage(threadId: string, turnId: string, itemId: string, text: string): void {
    const key = turnKey(threadId, turnId);
    let messages = this.turnAgentMessages.get(key);
    if (!messages) {
      messages = new Map<string, string>();
      this.turnAgentMessages.set(key, messages);
    }

    messages.set(itemId, `${messages.get(itemId) ?? ''}${text}`);
  }

  private setAgentMessage(threadId: string, turnId: string, itemId: string, text: string): void {
    const key = turnKey(threadId, turnId);
    let messages = this.turnAgentMessages.get(key);
    if (!messages) {
      messages = new Map<string, string>();
      this.turnAgentMessages.set(key, messages);
    }

    messages.set(itemId, text);
  }

  private async waitForTurn(
    threadId: string,
    turnId: string,
    request: CodexRequestLog,
    signal?: AbortSignal
  ): Promise<{ turn: unknown }> {
    const key = turnKey(threadId, turnId);
    const existing = this.completedTurns.get(key);
    if (existing) {
      this.completedTurns.delete(key);
      return { turn: existing.turn };
    }

    const result = await this.waitForNotification(
      'turn/completed',
      params => {
        const completedThreadId = getStringProperty(params, 'threadId');
        const turn = isRecord(params) ? params.turn : undefined;
        return completedThreadId === threadId && getStringProperty(turn, 'id') === turnId;
      },
      signal,
      TURN_TIMEOUT_MS
    );
    this.completedTurns.delete(key);
    if (!isRecord(result) || !isRecord(result.turn)) {
      throw new CodexResponseError('Codex returned an invalid turn completion.', request, {
        status: 'error',
        error: { message: 'Missing turn completion payload.' },
        stderr: this.stderrBuffer || undefined
      });
    }

    return { turn: result.turn };
  }

  private waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex notification: ${method}.`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(createAbortError());
      };
      const listener: NotificationListener = notification => {
        if (notification.method !== method || !predicate(notification.params)) {
          return;
        }

        cleanup();
        resolve(notification.params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.notificationListeners.delete(listener);
        signal?.removeEventListener('abort', onAbort);
      };

      this.notificationListeners.add(listener);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private extractFinalTurnText(
    threadId: string,
    turnId: string,
    turn: unknown,
    request: CodexRequestLog,
    response: CodexResponseLog
  ): string {
    const key = turnKey(threadId, turnId);
    const recordedMessages = this.turnAgentMessages.get(key);
    this.turnAgentMessages.delete(key);

    const turnMessages = extractAgentMessageTexts(turn);
    const recordedText = recordedMessages ? [...recordedMessages.values()].join('') : '';
    const text = [...turnMessages].reverse().find(message => message.trim()) ?? recordedText;
    const status = getStringProperty(turn, 'status');

    if (status !== 'completed') {
      const error = isRecord(turn) && isRecord(turn.error) ? getStringProperty(turn.error, 'message') : undefined;
      response.status = 'error';
      response.error = { status, message: error ?? 'Turn did not complete.' };
      throw new CodexResponseError(
        `Codex turn ${status ?? 'failed'}${error ? `: ${error}` : '.'}`,
        request,
        response
      );
    }

    if (!text?.trim()) {
      response.status = 'error';
      response.error = { message: 'Turn completed without an agent message.' };
      throw new CodexResponseError('Codex returned no final agent message.', request, response);
    }

    return text;
  }

  private invalidResponse(method: string, result: unknown, message: string): CodexResponseError {
    return new CodexResponseError(message, summarizeRequest(method, undefined), {
      status: 'error',
      error: { message: 'Invalid response payload.', resultSummary: summarizeResult(method, result) },
      stderr: this.stderrBuffer || undefined
    });
  }

  private handleProcessFailure(error: Error): void {
    if (this.disposed) {
      return;
    }

    const message = this.stderrBuffer ? `${error.message} ${this.stderrBuffer.trim()}` : error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

export function buildCodexAppServerArgs(fastMode = false): string[] {
  return fastMode
    ? ['app-server', '--stdio', '-c', 'service_tier="fast"', '-c', 'features.fast_mode=true']
    : ['app-server', '--stdio'];
}

function isResponse(message: JsonRpcMessage): message is { id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } } {
  return isRecord(message) && 'id' in message && !('method' in message) && ('result' in message || 'error' in message);
}

function isRequest(message: JsonRpcMessage): message is { id: JsonRpcId; method: string; params?: unknown } {
  return isRecord(message) && 'id' in message && typeof message.method === 'string';
}

function isNotification(message: JsonRpcMessage): message is { method: string; params?: unknown } {
  return isRecord(message) && typeof message.method === 'string' && !('id' in message);
}

function normalizeAccount(value: unknown): CodexAccount | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }

  if (value.type === 'chatgpt') {
    return {
      type: 'chatgpt',
      email: typeof value.email === 'string' ? value.email : null,
      planType: typeof value.planType === 'string' ? value.planType : 'unknown'
    };
  }

  if (value.type === 'apiKey') {
    return { type: 'apiKey' };
  }

  if (value.type === 'amazonBedrock') {
    return {
      type: 'amazonBedrock',
      usesCodexManagedCredentials: getBooleanProperty(value, 'usesCodexManagedCredentials') ?? false
    };
  }

  return null;
}

function normalizeModel(value: unknown): CodexModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = getStringProperty(value, 'id') ?? getStringProperty(value, 'model');
  const model = getStringProperty(value, 'model') ?? id;
  if (!id || !model) {
    return undefined;
  }

  const supportedReasoningEfforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.flatMap(option => {
      if (!isRecord(option)) {
        return [];
      }

      const reasoningEffort = getStringProperty(option, 'reasoningEffort');
      return reasoningEffort
        ? [{ reasoningEffort, description: getStringProperty(option, 'description') ?? '' }]
        : [];
    })
    : [];

  return {
    id,
    model,
    displayName: getStringProperty(value, 'displayName') ?? model,
    description: getStringProperty(value, 'description') ?? '',
    hidden: getBooleanProperty(value, 'hidden') ?? false,
    defaultReasoningEffort: getStringProperty(value, 'defaultReasoningEffort') ?? '',
    supportedReasoningEfforts,
    isDefault: getBooleanProperty(value, 'isDefault') ?? false
  };
}

function uniqueModels(models: readonly CodexModel[]): CodexModel[] {
  const seen = new Set<string>();
  return models.filter(model => {
    if (seen.has(model.model)) {
      return false;
    }

    seen.add(model.model);
    return true;
  });
}

function summarizeRequest(method: string, params: unknown): CodexRequestLog {
  if (method === 'thread/start' && isRecord(params)) {
    return {
      method,
      params: {
        model: getStringProperty(params, 'model') ?? '(Codex default)',
        cwd: getStringProperty(params, 'cwd'),
        approvalPolicy: getStringProperty(params, 'approvalPolicy'),
        sandbox: getStringProperty(params, 'sandbox'),
        ephemeral: getBooleanProperty(params, 'ephemeral')
      }
    };
  }

  if (method === 'turn/start' && isRecord(params)) {
    return {
      method,
      params: {
        threadId: getStringProperty(params, 'threadId'),
        model: getStringProperty(params, 'model') ?? '(Codex default)',
        cwd: getStringProperty(params, 'cwd'),
        inputCount: Array.isArray(params.input) ? params.input.length : 0,
        outputSchema: params.outputSchema
      }
    };
  }

  if (method === 'account/login/start' && isRecord(params)) {
    return { method, params: { type: getStringProperty(params, 'type') } };
  }

  return {
    method,
    ...(isRecord(params) ? { params: redactSecrets(params) as Record<string, unknown> } : {})
  };
}

function summarizeResult(method: string, result: unknown): Record<string, unknown> {
  if (method === 'account/read') {
    const account = isRecord(result) ? result.account : undefined;
    return { accountType: getStringProperty(account, 'type') ?? 'none' };
  }

  if (method === 'model/list') {
    return {
      modelCount: isRecord(result) && Array.isArray(result.data) ? result.data.length : 0,
      nextCursor: getStringProperty(result, 'nextCursor') ?? null
    };
  }

  if (method === 'thread/start') {
    const thread = isRecord(result) ? result.thread : undefined;
    return {
      threadId: getStringProperty(thread, 'id'),
      model: getStringProperty(result, 'model')
    };
  }

  if (method === 'turn/start') {
    const turn = isRecord(result) ? result.turn : undefined;
    return summarizeTurn(turn);
  }

  return { resultType: typeof result };
}

function summarizeTurn(turn: unknown): Record<string, unknown> {
  return {
    turnId: getStringProperty(turn, 'id'),
    status: getStringProperty(turn, 'status'),
    itemCount: isRecord(turn) && Array.isArray(turn.items) ? turn.items.length : 0,
    durationMs: isRecord(turn) && typeof turn.durationMs === 'number' ? turn.durationMs : undefined
  };
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactSecrets(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/authorization|apiKey|accessToken|token|secret|password/i.test(key)) {
      return [key, '[REDACTED]'];
    }

    return [key, redactSecrets(item)];
  }));
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function createAbortError(): Error {
  const error = new Error('Codex generation was cancelled.');
  error.name = 'AbortError';
  return error;
}
