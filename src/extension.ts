import * as vscode from 'vscode';
import { buildDiffContext, getGitApi, pickRepository } from './git';
import { createLogger } from './logger';
import { CodexResponseError } from './codexAppServer';
import { OpenCodeResponseError } from './openCode';
import { OpenRouterResponseError } from './openrouter';
import { registerPlannedCommits } from './plannedCommits';
import { ProviderService } from './provider';
import { buildCommitMessageRepairMessages, buildMessages, parseCommitMessage } from './prompt';
import { COMMIT_MESSAGE_OUTPUT_SCHEMA } from './codexProtocol';
import { clearOpenRouterApiKey, promptForOpenRouterApiKey } from './secrets';
import { getSettings } from './settings';
import { PhaseTimer } from './timing';

let output: vscode.OutputChannel;
let providerService: ProviderService;
const COMMIT_MESSAGE_REPAIR_ATTEMPTS = 2;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Git Commit Planner');
  providerService = new ProviderService(context);

  context.subscriptions.push(
    output,
    providerService,
    vscode.commands.registerCommand('gitCommitPlanner.generate', () => generateCommitMessage(context, providerService)),
    vscode.commands.registerCommand('gitCommitPlanner.setOpenRouterApiKey', () => promptForOpenRouterApiKey(context.secrets)),
    vscode.commands.registerCommand('gitCommitPlanner.clearOpenRouterApiKey', () => clearOpenRouterApiKey(context.secrets)),
    vscode.commands.registerCommand('gitCommitPlanner.codexSignIn', () => runProviderCommand(() => providerService.signIn())),
    vscode.commands.registerCommand('gitCommitPlanner.codexSignOut', () => runProviderCommand(() => providerService.signOut())),
    vscode.commands.registerCommand('gitCommitPlanner.codexStatus', () => runProviderCommand(() => providerService.showStatus())),
    vscode.commands.registerCommand('gitCommitPlanner.selectCodexModel', () => runProviderCommand(() => providerService.selectModel())),
    vscode.commands.registerCommand('gitCommitPlanner.selectCodexReasoningEffort', () => runProviderCommand(() => providerService.selectReasoningEffort())),
    vscode.commands.registerCommand('gitCommitPlanner.opencodeStatus', () => runProviderCommand(() => providerService.showOpenCodeStatus())),
    vscode.commands.registerCommand('gitCommitPlanner.selectOpenCodeModel', () => runProviderCommand(() => providerService.selectOpenCodeModel())),
    vscode.commands.registerCommand('gitCommitPlanner.selectOpenCodeVariant', () => runProviderCommand(() => providerService.selectOpenCodeVariant()))
  );

  registerPlannedCommits(context, output, providerService);
}

export function deactivate(): void {
  providerService?.dispose();
  output?.dispose();
}

async function generateCommitMessage(context: vscode.ExtensionContext, providers: ProviderService): Promise<void> {
  const logger = createLogger(output);
  let timings: PhaseTimer | undefined;

  try {
    const git = await getGitApi();
    const repository = await pickRepository(git);

    if (!repository) {
      return;
    }

    const settings = getSettings(repository.rootUri);
    timings = new PhaseTimer();

    if (!(await timings.measure('provider readiness', () =>
      providers.ensureAccess(settings, repository.rootUri.fsPath)
    ))) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Generating commit message',
        cancellable: true
      },
      async (_progress, token) => {
        const abortController = new AbortController();
        const cancellation = token.onCancellationRequested(() => abortController.abort());

        try {
          const diffContext = await timings!.measure('diff collection', () =>
            buildDiffContext(repository, settings)
          );
          const promptInput = {
            diff: diffContext.diff,
            source: diffContext.source,
            files: diffContext.files,
            budget: diffContext.budget,
            truncated: diffContext.truncated,
            settings
          };
          const messages = timings!.measureSync('prompt construction', () => buildMessages(promptInput));

          logger.section('Generation started');
          logger.line(`Extension version: ${context.extension.packageJSON.version}`);
          logger.line(`Debug logging: ${settings.debugLogging ? 'enabled' : 'disabled'}`);
          logger.json('Generation summary', {
            provider: settings.provider,
            model: modelLabel(settings),
            format: settings.format,
            includeBody: settings.includeBody,
            diffChars: diffContext.diff.length,
            estimatedDiffTokens: diffContext.budget.estimatedDiffTokens,
            maxPromptTokens: diffContext.budget.maxPromptTokens,
            maxDiffTokens: diffContext.budget.maxDiffTokens,
            truncated: diffContext.truncated,
            source: diffContext.source,
            repository: repository.rootUri.fsPath,
            files: diffContext.files
          });

          if (settings.debugLogging) {
            logger.json('Settings', {
              provider: settings.provider,
              model: modelLabel(settings),
              ...(settings.provider === 'openrouter' ? { baseUrl: settings.openRouter.baseUrl } : settings.provider === 'codex' ? {
                codexCommand: settings.codex.command,
                reasoningEffort: settings.codex.reasoningEffort,
                fastMode: settings.codex.fastMode
              } : {
                openCodeCommand: settings.opencode.command,
                openCodeServerUrl: settings.opencode.serverUrl,
                openCodeVariant: settings.opencode.variant
              }),
              format: settings.format,
              includeBody: settings.includeBody,
              preferStaged: settings.preferStaged,
              maxDiffChars: settings.maxDiffChars,
              modelContextTokens: settings.modelContextTokens,
              maxPromptContextRatio: settings.maxPromptContextRatio,
              maxPromptTokens: settings.maxPromptTokens,
              calculatedMaxPromptTokens: diffContext.budget.maxPromptTokens,
              calculatedMaxDiffTokens: diffContext.budget.maxDiffTokens,
              calculatedMaxDiffChars: diffContext.budget.maxDiffChars,
              diffChars: diffContext.diff.length,
              originalDiffChars: diffContext.budget.originalChars,
              omittedFilePatches: diffContext.budget.omittedFilePatches,
              language: settings.language,
              temperature: settings.temperature,
              maxOutputTokens: settings.maxOutputTokens,
              customInstructionsConfigured: Boolean(settings.customInstructions.trim())
            });
            logger.json('Git context', {
              repository: repository.rootUri.fsPath,
              source: diffContext.source,
              files: diffContext.files,
              truncated: diffContext.truncated,
              stagedChanges: repository.state.indexChanges.length,
              workingTreeChanges: repository.state.workingTreeChanges.length,
              untrackedChanges: repository.state.untrackedChanges.length
            });
            logger.text('Diff sent to provider', diffContext.diff);
            logger.json('Messages sent to provider', messages);
          } else {
            logger.line('Enable gitCommitPlanner.debugLogging for full diff, prompt, request, and response diagnostics.');
          }

          let result = await timings!.measure('provider generation', () =>
            providers.generate(
              settings,
              messages,
              repository.rootUri.fsPath,
              COMMIT_MESSAGE_OUTPUT_SCHEMA,
              abortController.signal
            )
          );
          logger.json('Provider phase timings', result.timings);

          if (settings.debugLogging) {
            logger.json('Provider request', result.request);
            logger.json('Provider response', result.response);
            logger.text('Extracted model text', result.text);
          } else {
            logger.json('Provider response summary', responseSummary(result.response));
          }

          let message = timings!.measureSync('response parsing', () => parseCommitMessage(result.text));
          logger.text('Commit message after cleanup', message ?? '[unparseable response]');

          for (let attempt = 1; !message?.trim() && attempt <= COMMIT_MESSAGE_REPAIR_ATTEMPTS; attempt += 1) {
            logger.section(`Commit message parse repair attempt ${attempt}`);
            logger.line(`The model response was not parseable. Requesting a corrected response (${attempt}/${COMMIT_MESSAGE_REPAIR_ATTEMPTS}).`);

            const repairMessages = buildCommitMessageRepairMessages({
              ...promptInput,
              invalidResponse: result.text
            });

            if (settings.debugLogging) {
              logger.json('Repair messages sent to provider', repairMessages);
            }

            result = await timings!.measure(`schema repair ${attempt}`, () =>
              providers.generate(
                settings,
                repairMessages,
                repository.rootUri.fsPath,
                COMMIT_MESSAGE_OUTPUT_SCHEMA,
                abortController.signal
              )
            );
            logger.json(`Provider repair phase timings ${attempt}`, result.timings);

            if (settings.debugLogging) {
              logger.json('Provider repair request', result.request);
              logger.json('Provider repair response', result.response);
              logger.text('Extracted repair model text', result.text);
            } else {
              logger.json('Provider repair response summary', responseSummary(result.response));
            }

            message = timings!.measureSync(
              `response parsing after repair ${attempt}`,
              () => parseCommitMessage(result.text)
            );
            logger.text(`Commit message after repair ${attempt}`, message ?? '[unparseable response]');
          }

          if (!message?.trim()) {
            throw new Error(`The provider did not return a parseable commit message after ${COMMIT_MESSAGE_REPAIR_ATTEMPTS} repair attempts.`);
          }

          repository.inputBox.value = message;
          vscode.window.showInformationMessage('Commit message generated.');
        } finally {
          cancellation.dispose();
        }
      }
    );
  } catch (error) {
    if (error instanceof OpenRouterResponseError || error instanceof CodexResponseError || error instanceof OpenCodeResponseError) {
      logger.section('Provider failure diagnostics');
      logger.json('Provider request', error.request);
      logger.json('Provider response', error.response);
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(error);
    vscode.window.showErrorMessage(`Git Commit Planner: ${message}`);
  } finally {
    if (timings) {
      logger.section('Performance timings');
      logger.json('Commit message phase timings', timings.snapshot());
    }
  }
}

function modelLabel(settings: ReturnType<typeof getSettings>): string {
  if (settings.provider === 'codex') {
    return settings.codex.model.trim() || '(Codex default)';
  }

  if (settings.provider === 'opencode') {
    const model = settings.opencode.model.trim() || '(OpenCode default)';
    const variant = settings.opencode.variant.trim();
    return variant && !model.includes('#') ? `${model}#${variant}` : model;
  }

  return settings.openRouter.model;
}

function responseSummary(response: unknown): unknown {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const record = response as Record<string, unknown>;
  return record.choiceSummary ?? record.resultSummary ?? response;
}

async function runProviderCommand(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const logger = createLogger(output);
    if (error instanceof OpenRouterResponseError || error instanceof CodexResponseError || error instanceof OpenCodeResponseError) {
      logger.section('Provider failure diagnostics');
      logger.json('Provider request', error.request);
      logger.json('Provider response', error.response);
    }
    logger.error(error);
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Git Commit Planner: ${message}`);
  }
}
