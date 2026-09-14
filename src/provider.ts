import * as vscode from 'vscode';
import {
  CodexAccountStatus,
  CodexAppServerClient,
  CodexGenerationResult
} from './codexAppServer';
import type { ChatMessage, OpenRouterResult } from './openrouter';
import { createOpenRouterCommitMessage } from './openrouter';
import {
  OpenCodeClient,
  OpenCodeResponseError,
  parseModelReference
} from './openCode';
import { getOpenRouterApiKey, promptForOpenRouterApiKey } from './secrets';
import { ExtensionSettings, getSettings } from './settings';
import type { TimingSummary } from './timing';

export interface ProviderGenerationResult {
  text: string;
  request: unknown;
  response: unknown;
  timings: TimingSummary;
}

export class ProviderService implements vscode.Disposable {
  private codexClient: CodexAppServerClient | undefined;
  private codexCommand: string | undefined;
  private codexFastMode: boolean | undefined;
  private openCodeClient: OpenCodeClient | undefined;
  private openCodeCommand: string | undefined;
  private openCodeServerUrl: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensureAccess(settings: ExtensionSettings, cwd?: string): Promise<boolean> {
    if (settings.provider === 'openrouter') {
      return this.ensureOpenRouterAccess();
    }

    if (settings.provider === 'opencode') {
      return this.ensureOpenCodeAccess(settings, cwd);
    }

    const status = await this.readCodexAccount(settings);
    if (status.account) {
      return true;
    }

    const action = await vscode.window.showWarningMessage(
      'Codex is not signed in. Sign in with ChatGPT to use your Codex subscription.',
      { modal: false },
      'Sign in with ChatGPT'
    );

    return action === 'Sign in with ChatGPT' ? this.signIn(settings) : false;
  }

  async generate(
    settings: ExtensionSettings,
    messages: readonly ChatMessage[],
    cwd: string,
    outputSchema?: unknown,
    signal?: AbortSignal
  ): Promise<ProviderGenerationResult> {
    if (settings.provider === 'openrouter') {
      const apiKey = await getOpenRouterApiKey(this.context.secrets);
      if (!apiKey) {
        throw new Error('OpenRouter API key is not configured.');
      }

      const result: OpenRouterResult = await createOpenRouterCommitMessage(apiKey, [...messages], settings, signal);
      return result;
    }

    if (settings.provider === 'opencode') {
      return this.getOpenCodeClient(settings).generate(messages, cwd, settings, outputSchema, signal);
    }

    const result: CodexGenerationResult = await this.getCodexClient(settings).generate(
      messages,
      cwd,
      settings,
      outputSchema,
      signal
    );
    return result;
  }

  async signIn(settings = this.getCurrentSettings()): Promise<boolean> {
    const client = this.getCodexClient(settings);
    const login = await client.startChatGPTLogin();
    let completed = false;

    try {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(login.authUrl));

      if (!opened) {
        vscode.window.showErrorMessage('Git Commit Planner could not open the ChatGPT sign-in page.');
        return false;
      }

      const completion = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Waiting for ChatGPT sign-in',
          cancellable: false
        },
        () => client.waitForLoginCompletion(login.loginId)
      );

      if (!completion.success) {
        throw new Error(completion.error ?? 'ChatGPT sign-in did not complete.');
      }

      const status = await client.accountRead();
      if (!status.account) {
        throw new Error('ChatGPT sign-in completed, but Codex did not return an account.');
      }

      completed = true;
      vscode.window.showInformationMessage('Signed in to Codex with ChatGPT.');
      return true;
    } finally {
      if (!completed) {
        await client.cancelLogin(login.loginId).catch(() => undefined);
      }
    }
  }

  async signOut(settings = this.getCurrentSettings()): Promise<void> {
    await this.getCodexClient(settings).logout();
    vscode.window.showInformationMessage('Signed out of Codex.');
  }

  async showStatus(settings = this.getCurrentSettings()): Promise<void> {
    const status = await this.readCodexAccount(settings);
    const account = status.account;

    if (!account) {
      const action = await vscode.window.showWarningMessage(
        'Codex is not signed in.',
        { modal: false },
        'Sign in with ChatGPT'
      );
      if (action === 'Sign in with ChatGPT') {
        await this.signIn(settings);
      }
      return;
    }

    if (account.type === 'chatgpt') {
      const email = account.email ? ` (${account.email})` : '';
      vscode.window.showInformationMessage(`Codex is signed in with ChatGPT${email}. Plan: ${account.planType}.`);
      return;
    }

    if (account.type === 'apiKey') {
      vscode.window.showInformationMessage('Codex is authenticated with an API key. API billing applies.');
      return;
    }

    vscode.window.showInformationMessage('Codex is authenticated with Amazon Bedrock credentials.');
  }

  async selectModel(settings = this.getCurrentSettings()): Promise<void> {
    if (!(await this.ensureAccess(settings))) {
      return;
    }

    const models = await this.getCodexClient(settings).listModels();
    if (models.length === 0) {
      throw new Error('Codex did not return any available models.');
    }

    const picked = await vscode.window.showQuickPick(
      models.map(model => ({
        label: model.displayName,
        description: model.model === settings.codex.model ? `${model.model} - selected` : model.model,
        detail: model.description || undefined,
        model
      })),
      {
        title: 'Select Codex Model',
        matchOnDescription: true,
        matchOnDetail: true
      }
    );

    if (!picked) {
      return;
    }

    const { config, target } = this.getProviderConfiguration();
    await config.update('codex.model', picked.model.model, target);
    vscode.window.showInformationMessage(`Codex model set to ${picked.model.displayName}.`);
  }

  async selectReasoningEffort(settings = this.getCurrentSettings()): Promise<void> {
    if (!(await this.ensureAccess(settings))) {
      return;
    }

    const models = await this.getCodexClient(settings).listModels();
    const selectedModelId = settings.codex.model.trim();
    const selectedModel = selectedModelId
      ? models.find(model => model.model === selectedModelId)
      : models.find(model => model.isDefault) ?? models[0];

    if (!selectedModel) {
      throw new Error('Codex did not return a model for reasoning-effort selection.');
    }

    const currentEffort = settings.codex.reasoningEffort.trim();
    const choices = [
      {
        label: `Use model default${currentEffort ? '' : ' (current)'}`,
        description: selectedModel.defaultReasoningEffort
          ? `Default: ${selectedModel.defaultReasoningEffort}`
          : 'Let Codex choose the model default.',
        value: ''
      },
      ...selectedModel.supportedReasoningEfforts.map(option => ({
        label: `${option.reasoningEffort}${currentEffort === option.reasoningEffort ? ' (current)' : ''}`,
        description: option.description || undefined,
        value: option.reasoningEffort
      }))
    ];

    const picked = await vscode.window.showQuickPick(choices, {
      title: `Select Codex Reasoning Effort (${selectedModel.displayName})`,
      matchOnDescription: true
    });

    if (!picked) {
      return;
    }

    const { config, target } = this.getProviderConfiguration();
    await config.update('codex.reasoningEffort', picked.value, target);
    vscode.window.showInformationMessage(
      picked.value
        ? `Codex reasoning effort set to ${picked.value}.`
        : 'Codex reasoning effort reset to the model default.'
    );
  }

  async showOpenCodeStatus(settings = this.getCurrentSettings()): Promise<void> {
    try {
      const providers = await this.getOpenCodeClient(settings).listProviders(this.getOpenCodeDirectory());
      const connected = providers.filter(provider => provider.connected);
      if (connected.length === 0) {
        vscode.window.showWarningMessage(
          'OpenCode has no connected providers. Run "opencode auth login" or configure an OpenCode provider.'
        );
        return;
      }

      const summary = connected
        .map(provider => {
          const modelCount = provider.models.length;
          return `${provider.name} (${modelCount} model${modelCount === 1 ? '' : 's'})`;
        })
        .join(', ');
      vscode.window.showInformationMessage(`OpenCode connected providers: ${summary}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not read OpenCode provider status: ${message}`);
    }
  }

  async selectOpenCodeModel(settings = this.getCurrentSettings()): Promise<void> {
    if (!(await this.ensureOpenCodeAccess(settings))) {
      return;
    }

    const models = await this.getOpenCodeClient(settings).listModels(this.getOpenCodeDirectory());
    if (models.length === 0) {
      throw new Error('OpenCode did not return any connected models.');
    }

    const selectedReference = getModelReferenceWithoutVariant(settings.opencode.model);
    const picked = await vscode.window.showQuickPick(
      models.map(model => ({
        label: model.displayName,
        description: model.reference === selectedReference ? `${model.reference} - selected` : model.reference,
        detail: [model.description, model.variants.length > 0 ? `Variants: ${model.variants.join(', ')}` : '']
          .filter(Boolean)
          .join(' | ') || undefined,
        model
      })),
      {
        title: 'Select OpenCode Model',
        matchOnDescription: true,
        matchOnDetail: true
      }
    );

    if (!picked) {
      return;
    }

    const { config, target } = this.getProviderConfiguration();
    await config.update('opencode.model', picked.model.reference, target);
    await config.update('opencode.variant', '', target);
    vscode.window.showInformationMessage(`OpenCode model set to ${picked.model.reference}.`);
  }

  async selectOpenCodeVariant(settings = this.getCurrentSettings()): Promise<void> {
    if (!(await this.ensureOpenCodeAccess(settings))) {
      return;
    }

    const models = await this.getOpenCodeClient(settings).listModels(this.getOpenCodeDirectory());
    const selectedReference = getModelReferenceWithoutVariant(settings.opencode.model);
    const selectedModel = selectedReference
      ? models.find(model => model.reference === selectedReference)
      : models.find(model => model.isDefault) ?? models[0];

    if (!selectedModel) {
      throw new Error('OpenCode did not return a model for variant selection.');
    }

    const parsed = parseModelReference(settings.opencode.model);
    const currentVariant = settings.opencode.variant.trim() || parsed?.variant || '';
    const choices = [
      {
        label: `Use model default${currentVariant ? '' : ' (current)'}`,
        description: 'Let OpenCode use the model default variant.',
        value: ''
      },
      ...selectedModel.variants.map(variant => ({
        label: `${variant}${currentVariant === variant ? ' (current)' : ''}`,
        description: `${selectedModel.reference} variant`,
        value: variant
      }))
    ];

    const picked = await vscode.window.showQuickPick(choices, {
      title: `Select OpenCode Variant (${selectedModel.reference})`,
      matchOnDescription: true
    });

    if (!picked) {
      return;
    }

    const { config, target } = this.getProviderConfiguration();
    await config.update('opencode.model', selectedModel.reference, target);
    await config.update('opencode.variant', picked.value, target);
    vscode.window.showInformationMessage(
      picked.value
        ? `OpenCode variant set to ${picked.value}.`
        : 'OpenCode variant reset to the model default.'
    );
  }

  dispose(): void {
    this.codexClient?.dispose();
    this.codexClient = undefined;
    this.codexCommand = undefined;
    this.codexFastMode = undefined;
    this.openCodeClient?.dispose();
    this.openCodeClient = undefined;
    this.openCodeCommand = undefined;
    this.openCodeServerUrl = undefined;
  }

  private async ensureOpenRouterAccess(): Promise<boolean> {
    const existing = await getOpenRouterApiKey(this.context.secrets);
    if (existing) {
      return true;
    }

    const action = await vscode.window.showWarningMessage(
      'OpenRouter API key is not configured.',
      { modal: false },
      'Set API Key'
    );

    if (action !== 'Set API Key') {
      return false;
    }

    await promptForOpenRouterApiKey(this.context.secrets);
    return Boolean(await getOpenRouterApiKey(this.context.secrets));
  }

  private async ensureOpenCodeAccess(settings: ExtensionSettings, cwd?: string): Promise<boolean> {
    try {
      const directory = cwd ?? this.getOpenCodeDirectory();
      const providers = await this.getOpenCodeClient(settings).listProviders(directory);
      const connected = providers.filter(provider => provider.connected);
      if (connected.length === 0) {
        vscode.window.showWarningMessage(
          'OpenCode has no connected providers. Run "opencode auth login" or configure an OpenCode provider.'
        );
        return false;
      }

      const selected = settings.opencode.model.trim();
      if (selected) {
        const reference = parseModelReference(selected);
        const modelAvailable = connected.some(provider =>
          provider.id === reference?.providerID && provider.models.some(model => model.modelID === reference.modelID)
        );
        if (!modelAvailable) {
          vscode.window.showWarningMessage(
            `OpenCode model "${selected}" is not connected for this project. Select a connected OpenCode model.`
          );
          return false;
        }
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof OpenCodeResponseError) {
        vscode.window.showErrorMessage(`OpenCode provider check failed: ${message}`);
      } else {
        vscode.window.showErrorMessage(`OpenCode is not available: ${message}`);
      }
      return false;
    }
  }

  private async readCodexAccount(settings: ExtensionSettings): Promise<CodexAccountStatus> {
    return this.getCodexClient(settings).accountRead();
  }

  private getCodexClient(settings: ExtensionSettings): CodexAppServerClient {
    const command = settings.codex.command.trim() || 'codex';
    const fastMode = settings.codex.fastMode;
    if (!this.codexClient || this.codexCommand !== command || this.codexFastMode !== fastMode) {
      this.codexClient?.dispose();
      this.codexClient = new CodexAppServerClient(command, this.context.extension.packageJSON.version, fastMode);
      this.codexCommand = command;
      this.codexFastMode = fastMode;
    }

    return this.codexClient;
  }

  private getOpenCodeClient(settings: ExtensionSettings): OpenCodeClient {
    const command = settings.opencode.command.trim() || 'opencode';
    const serverUrl = settings.opencode.serverUrl.trim();
    if (
      !this.openCodeClient
      || this.openCodeCommand !== command
      || this.openCodeServerUrl !== serverUrl
    ) {
      this.openCodeClient?.dispose();
      this.openCodeClient = new OpenCodeClient(command, serverUrl, this.context.extension.packageJSON.version);
      this.openCodeCommand = command;
      this.openCodeServerUrl = serverUrl;
    }

    return this.openCodeClient;
  }

  private getProviderConfiguration(): {
    config: vscode.WorkspaceConfiguration;
    target: vscode.ConfigurationTarget;
  } {
    const resource = vscode.window.activeTextEditor?.document.uri;
    const config = vscode.workspace.getConfiguration('gitCommitPlanner', resource);
    const hasWorkspace = Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
    const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return { config, target };
  }

  private getCurrentSettings(): ExtensionSettings {
    return getSettings(vscode.window.activeTextEditor?.document.uri);
  }

  private getOpenCodeDirectory(): string {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeWorkspace = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    return activeWorkspace?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? process.cwd();
  }
}

function getModelReferenceWithoutVariant(value: string): string {
  return value.trim().split('#', 1)[0] ?? '';
}
