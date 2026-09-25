import * as vscode from 'vscode';
import { DEFAULT_IGNORED_GLOBS } from './pathFilters';

export type CommitFormat = 'conventional' | 'simple' | 'custom';
export type IncludeBody = 'never' | 'auto' | 'always';
export type Provider = 'openrouter' | 'codex' | 'opencode';
export type CodexReasoningEffort = string;
export type OpenRouterReasoningEffort = string;

export interface ExtensionSettings {
  provider: Provider;
  openRouter: {
    baseUrl: string;
    model: string;
    siteUrl: string;
    appTitle: string;
    reasoningEffort: OpenRouterReasoningEffort;
  };
  codex: {
    command: string;
    model: string;
    reasoningEffort: CodexReasoningEffort;
    fastMode: boolean;
  };
  opencode: {
    command: string;
    serverUrl: string;
    model: string;
    variant: string;
  };
  format: CommitFormat;
  includeBody: IncludeBody;
  customInstructions: string;
  preferStaged: boolean;
  maxDiffChars: number;
  modelContextTokens: number;
  maxPromptContextRatio: number;
  maxPromptTokens: number;
  language: string;
  temperature: number;
  maxOutputTokens: number;
  maxPlanOutputTokens: number;
  ignoredGlobs: string[];
  debugLogging: boolean;
}

export function getSettings(resource?: vscode.Uri): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('gitCommitPlanner', resource);

  return {
    provider: config.get<Provider>('provider', 'openrouter'),
    openRouter: {
      baseUrl: config.get<string>('openRouter.baseUrl', 'https://openrouter.ai/api/v1'),
      model: config.get<string>('openRouter.model', 'openrouter/auto'),
      siteUrl: config.get<string>('openRouter.siteUrl', ''),
      appTitle: config.get<string>('openRouter.appTitle', 'Git Commit Planner VS Code Extension'),
      reasoningEffort: config.get<OpenRouterReasoningEffort>('openRouter.reasoningEffort', 'none')
    },
    codex: {
      command: config.get<string>('codex.command', 'codex'),
      model: config.get<string>('codex.model', ''),
      reasoningEffort: config.get<CodexReasoningEffort>('codex.reasoningEffort', ''),
      fastMode: config.get<boolean>('codex.fastMode', false)
    },
    opencode: {
      command: config.get<string>('opencode.command', 'opencode'),
      serverUrl: config.get<string>('opencode.serverUrl', ''),
      model: config.get<string>('opencode.model', ''),
      variant: config.get<string>('opencode.variant', '')
    },
    format: config.get<CommitFormat>('format', 'conventional'),
    includeBody: config.get<IncludeBody>('includeBody', 'auto'),
    customInstructions: config.get<string>('customInstructions', ''),
    preferStaged: config.get<boolean>('preferStaged', true),
    maxDiffChars: config.get<number>('maxDiffChars', 0),
    modelContextTokens: config.get<number>('modelContextTokens', 200000),
    maxPromptContextRatio: config.get<number>('maxPromptContextRatio', 0.6),
    maxPromptTokens: config.get<number>('maxPromptTokens', 0),
    language: config.get<string>('language', 'en'),
    temperature: config.get<number>('temperature', 0.2),
    maxOutputTokens: config.get<number>('maxOutputTokens', 800),
    maxPlanOutputTokens: config.get<number>('maxPlanOutputTokens', 32000),
    ignoredGlobs: readIgnoredGlobs(config),
    debugLogging: config.get<boolean>('debugLogging', false)
  };
}

function readIgnoredGlobs(config: vscode.WorkspaceConfiguration): string[] {
  const value = config.get<unknown>('ignoredGlobs', DEFAULT_IGNORED_GLOBS);

  if (!Array.isArray(value)) {
    return [...DEFAULT_IGNORED_GLOBS];
  }

  return value.filter((glob): glob is string => typeof glob === 'string');
}
