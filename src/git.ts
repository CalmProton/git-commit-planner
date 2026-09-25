import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import {
  filterIgnoredPatches,
  formatBytes,
  looksBinary,
  matchesAnyGlob,
  MAX_UNTRACKED_FILE_BYTES,
  splitFilePatches
} from './pathFilters';
import type { ExtensionSettings } from './settings';

const execFileAsync = promisify(execFile);

export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: Status;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: {
    readonly indexChanges: Change[];
    readonly workingTreeChanges: Change[];
    readonly untrackedChanges: Change[];
    readonly onDidChange?: vscode.Event<void>;
  };
  readonly ui: {
    readonly selected: boolean;
  };
  diffWithHEAD(): Promise<unknown>;
  diffIndexWithHEAD(): Promise<unknown>;
}

interface GitApi {
  readonly repositories: Repository[];
  getRepository(uri: vscode.Uri): Repository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export interface DiffContext {
  repository: Repository;
  diff: string;
  source: 'staged' | 'unstaged';
  files: Array<{ path: string; status: string }>;
  budget: DiffBudget;
  truncated: boolean;
}

export interface DiffBudget {
  modelContextTokens: number;
  maxPromptTokens: number;
  reservedNonDiffTokens: number;
  maxDiffTokens: number;
  maxDiffChars: number;
  originalChars: number;
  includedChars: number;
  estimatedDiffTokens: number;
  omittedFilePatches: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  uri: vscode.Uri;
}

export async function getGitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');

  if (!extension) {
    throw new Error('The built-in VS Code Git extension is not available.');
  }

  const gitExtension = extension.isActive ? extension.exports : await extension.activate();

  if (!gitExtension.enabled) {
    throw new Error('The built-in VS Code Git extension is disabled.');
  }

  return gitExtension.getAPI(1);
}

export async function pickRepository(git: GitApi): Promise<Repository | undefined> {
  if (git.repositories.length === 0) {
    throw new Error('No Git repositories are open in this workspace.');
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeRepository = git.getRepository(activeEditorUri);
    if (activeRepository) {
      return activeRepository;
    }
  }

  const selectedRepository = git.repositories.find(repository => repository.ui.selected);
  if (selectedRepository) {
    return selectedRepository;
  }

  if (git.repositories.length === 1) {
    return git.repositories[0];
  }

  const items = git.repositories.map(repository => ({
    label: path.basename(repository.rootUri.fsPath),
    description: repository.rootUri.fsPath,
    repository
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select Git Repository',
    placeHolder: 'Choose which repository to generate a commit message for'
  });

  return picked?.repository;
}

export async function buildDiffContext(repository: Repository, settings: ExtensionSettings): Promise<DiffContext> {
  const hasStagedChanges = repository.state.indexChanges.length > 0;
  const hasWorkingTreeChanges = repository.state.workingTreeChanges.length > 0 || repository.state.untrackedChanges.length > 0;

  if (!hasStagedChanges && !hasWorkingTreeChanges) {
    throw new Error('No staged or unstaged changes found.');
  }

  if (settings.preferStaged && hasStagedChanges) {
    const rawDiff = filterIgnoredPatches(await getStagedDiff(repository), settings.ignoredGlobs);
    const clipped = compactDiff(rawDiff, createDiffBudget(settings, rawDiff.length));

    return {
      repository,
      diff: clipped.diff,
      source: 'staged',
      files: describeChanges(repository, repository.state.indexChanges),
      budget: clipped.budget,
      truncated: clipped.truncated
    };
  }

  const trackedDiff = hasWorkingTreeChanges
    ? filterIgnoredPatches(await getUnstagedDiff(repository), settings.ignoredGlobs)
    : '';
  const untrackedDiff = await buildUntrackedDiff(repository, getEffectiveMaxDiffChars(settings), settings.ignoredGlobs);
  const rawDiff = [trackedDiff, untrackedDiff].filter(Boolean).join('\n\n');
  const clipped = compactDiff(rawDiff, createDiffBudget(settings, rawDiff.length));

  if (!clipped.diff.trim()) {
    throw new Error('No text changes found to describe.');
  }

  return {
    repository,
    diff: clipped.diff,
    source: 'unstaged',
    files: describeChanges(repository, [
      ...repository.state.workingTreeChanges,
      ...repository.state.untrackedChanges
    ]),
    budget: clipped.budget,
    truncated: clipped.truncated
  };
}

export async function buildWorkingTreeDiffContext(repository: Repository, settings: ExtensionSettings): Promise<DiffContext> {
  await assertCleanIndex(repository);

  const files = await getWorkingTreeChangedFiles(repository);

  if (files.length === 0) {
    throw new Error('No unstaged or untracked changes found.');
  }

  const trackedDiff = filterIgnoredPatches(await getUnstagedDiff(repository), settings.ignoredGlobs);
  const untrackedDiff = await buildUntrackedDiffFromFiles(
    repository,
    files,
    getEffectiveMaxDiffChars(settings),
    settings.ignoredGlobs
  );
  const rawDiff = [trackedDiff, untrackedDiff].filter(Boolean).join('\n\n');
  const clipped = compactDiff(rawDiff, createDiffBudget(settings, rawDiff.length));

  if (!clipped.diff.trim()) {
    throw new Error('No text changes found to describe.');
  }

  return {
    repository,
    diff: clipped.diff,
    source: 'unstaged',
    files: files.map(file => ({
      path: file.path,
      status: file.status
    })),
    budget: clipped.budget,
    truncated: clipped.truncated
  };
}

export async function assertCleanIndex(repository: Repository): Promise<void> {
  const status = await getStatusEntries(repository);
  const staged = status.filter(entry => hasIndexChange(entry.xy));

  if (staged.length > 0) {
    throw new Error('Planned commits require a clean index. Unstage existing changes before planning or committing.');
  }
}

export async function getWorkingTreeChangedFiles(repository: Repository): Promise<ChangedFile[]> {
  const status = await getStatusEntries(repository);

  return status
    .filter(entry => !hasIndexChange(entry.xy) && hasWorkingTreeChange(entry.xy))
    .map(entry => ({
      path: entry.path,
      status: statusDescription(entry.xy),
      uri: vscode.Uri.file(path.join(repository.rootUri.fsPath, entry.path))
    }));
}

export async function getPendingChangedFiles(repository: Repository): Promise<ChangedFile[]> {
  const status = await getStatusEntries(repository);

  return status
    .filter(entry => hasIndexChange(entry.xy) || hasWorkingTreeChange(entry.xy))
    .map(entry => ({
      path: entry.path,
      status: statusDescription(entry.xy),
      uri: vscode.Uri.file(path.join(repository.rootUri.fsPath, entry.path))
    }));
}

export async function getWorkingTreeFingerprint(repository: Repository): Promise<string> {
  const status = await gitExec(repository, ['status', '--porcelain=v1', '-z', '-uall', '--']);
  return status.stdout;
}

export async function gitAddPaths(repository: Repository, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) {
    throw new Error('Cannot stage an empty commit group.');
  }

  for (const batch of chunkGitPaths(paths)) {
    await gitExec(repository, ['add', '-A', '--', ...batch]);
  }
}

export async function gitCommitWithMessage(repository: Repository, messageFilePath: string): Promise<void> {
  await gitExec(repository, ['commit', '-F', messageFilePath]);
}

export async function gitExec(repository: Repository, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repository.rootUri.fsPath,
    maxBuffer: 200 * 1024 * 1024
  });
}

function describeChanges(repository: Repository, changes: readonly Change[]): Array<{ path: string; status: string }> {
  return changes.map(change => ({
    path: toRelativePath(repository.rootUri, change.uri),
    status: Status[change.status] ?? `UNKNOWN_${change.status}`
  }));
}

interface StatusEntry {
  xy: string;
  path: string;
}

async function getStatusEntries(repository: Repository): Promise<StatusEntry[]> {
  const { stdout } = await gitExec(repository, ['status', '--porcelain=v1', '-z', '-uall', '--']);
  const parts = stdout.split('\0').filter(Boolean);
  const entries: StatusEntry[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);

    entries.push({
      xy,
      path: filePath
    });

    if (xy[0] === 'R' || xy[0] === 'C') {
      index += 1;
    }
  }

  return entries;
}

function hasIndexChange(xy: string): boolean {
  const indexStatus = xy[0];
  return indexStatus !== ' ' && indexStatus !== '?';
}

function hasWorkingTreeChange(xy: string): boolean {
  return xy === '??' || xy[1] !== ' ';
}

function statusDescription(xy: string): string {
  if (xy === '??') {
    return 'UNTRACKED';
  }

  if (xy[1] === ' ') {
    switch (xy[0]) {
      case 'M':
        return 'INDEX_MODIFIED';
      case 'A':
        return 'INDEX_ADDED';
      case 'D':
        return 'INDEX_DELETED';
      case 'R':
        return 'INDEX_RENAMED';
      case 'C':
        return 'INDEX_COPIED';
      default:
        return `INDEX_${xy[0] || 'UNKNOWN'}`;
    }
  }

  switch (xy[1]) {
    case 'M':
      return 'MODIFIED';
    case 'D':
      return 'DELETED';
    case 'T':
      return 'TYPE_CHANGED';
    default:
      return `WORKING_TREE_${xy[1] || 'UNKNOWN'}`;
  }
}

function chunkGitPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const filePath of paths) {
    const nextChars = currentChars + filePath.length + 1;

    if (current.length > 0 && nextChars > 12000) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(filePath);
    currentChars += filePath.length + 1;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function compactDiff(diff: string, budget: DiffBudget): { diff: string; budget: DiffBudget; truncated: boolean } {
  const maxChars = budget.maxDiffChars;

  if (diff.length <= maxChars) {
    return {
      diff,
      budget: {
        ...budget,
        includedChars: diff.length,
        estimatedDiffTokens: estimateTokens(diff)
      },
      truncated: false
    };
  }

  const patches = splitFilePatches(diff);
  const chunks: string[] = [];
  let remainingChars = maxChars;
  let omittedFilePatches = 0;

  for (const patch of patches) {
    if (remainingChars <= 0) {
      omittedFilePatches += 1;
      continue;
    }

    const separatorCost = chunks.length > 0 ? 2 : 0;
    if (patch.length + separatorCost <= remainingChars) {
      chunks.push(patch);
      remainingChars -= patch.length + separatorCost;
      continue;
    }

    const allowed = Math.max(0, remainingChars - separatorCost);
    if (allowed > 0) {
      chunks.push(`${patch.slice(0, allowed)}\n[File patch truncated because the prompt budget was reached.]`);
      remainingChars = 0;
    }
  }

  if (omittedFilePatches > 0) {
    chunks.push(`[${omittedFilePatches} file patch(es) omitted because the prompt budget was reached.]`);
  }

  const compacted = chunks.join('\n\n');

  return {
    diff: compacted,
    budget: {
      ...budget,
      includedChars: compacted.length,
      estimatedDiffTokens: estimateTokens(compacted),
      omittedFilePatches
    },
    truncated: true
  };
}

function createDiffBudget(settings: ExtensionSettings, originalChars: number): DiffBudget {
  const maxPromptTokens = settings.maxPromptTokens > 0
    ? settings.maxPromptTokens
    : Math.floor(settings.modelContextTokens * settings.maxPromptContextRatio);
  const reservedNonDiffTokens = Math.max(2000, settings.maxOutputTokens + 1500);
  const maxDiffTokens = Math.max(1000, maxPromptTokens - reservedNonDiffTokens);
  const tokenBasedMaxChars = maxDiffTokens * 4;
  const maxDiffChars = settings.maxDiffChars > 0
    ? Math.min(settings.maxDiffChars, tokenBasedMaxChars)
    : tokenBasedMaxChars;

  return {
    modelContextTokens: settings.modelContextTokens,
    maxPromptTokens,
    reservedNonDiffTokens,
    maxDiffTokens,
    maxDiffChars,
    originalChars,
    includedChars: 0,
    estimatedDiffTokens: 0,
    omittedFilePatches: 0
  };
}

function getEffectiveMaxDiffChars(settings: ExtensionSettings): number {
  return createDiffBudget(settings, 0).maxDiffChars;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function getStagedDiff(repository: Repository): Promise<string> {
  return gitDiff(repository, ['diff', '--cached', '--no-ext-diff', '--']);
}

async function getUnstagedDiff(repository: Repository): Promise<string> {
  return gitDiff(repository, ['diff', '--no-ext-diff', '--']);
}

async function gitDiff(repository: Repository, args: string[]): Promise<string> {
  try {
    const { stdout } = await gitExec(repository, args);

    return stdout;
  } catch {
    const fallback = args.includes('--cached')
      ? await repository.diffIndexWithHEAD()
      : await repository.diffWithHEAD();

    return normalizeDiff(fallback);
  }
}

function normalizeDiff(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDiff).filter(Boolean).join('\n\n');
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['diff', 'patch', 'content', 'contents', 'text']) {
      const normalized = normalizeDiff(record[key]);
      if (normalized.trim()) {
        return normalized;
      }
    }

    return JSON.stringify(value, undefined, 2);
  }

  return String(value);
}

async function buildUntrackedDiff(
  repository: Repository,
  maxChars: number,
  ignoredGlobs: readonly string[]
): Promise<string> {
  const chunks: string[] = [];
  let remainingChars = Math.max(1000, maxChars);

  for (const change of repository.state.untrackedChanges) {
    if (remainingChars <= 0) {
      chunks.push('[Additional untracked files omitted because the diff is too large.]');
      break;
    }

    const relativePath = toRelativePath(repository.rootUri, change.uri);
    const chunk = await readUntrackedFileAsPatch(change.uri, relativePath, remainingChars, ignoredGlobs);
    chunks.push(chunk);
    remainingChars -= chunk.length;
  }

  return chunks.join('\n\n');
}

async function buildUntrackedDiffFromFiles(
  repository: Repository,
  files: readonly ChangedFile[],
  maxChars: number,
  ignoredGlobs: readonly string[]
): Promise<string> {
  const chunks: string[] = [];
  let remainingChars = Math.max(1000, maxChars);

  for (const file of files.filter(file => file.status === 'UNTRACKED')) {
    if (remainingChars <= 0) {
      chunks.push('[Additional untracked files omitted because the diff is too large.]');
      break;
    }

    const chunk = await readUntrackedFileAsPatch(file.uri, file.path, remainingChars, ignoredGlobs);
    chunks.push(chunk);
    remainingChars -= chunk.length;
  }

  return chunks.join('\n\n');
}

async function readUntrackedFileAsPatch(
  uri: vscode.Uri,
  relativePath: string,
  maxChars: number,
  ignoredGlobs: readonly string[]
): Promise<string> {
  if (matchesAnyGlob(relativePath, ignoredGlobs)) {
    return `Untracked file (content omitted because the path matches gitCommitPlanner.ignoredGlobs): ${relativePath}`;
  }

  let bytes: Uint8Array;

  try {
    const stat = await vscode.workspace.fs.stat(uri);

    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      return `Untracked file (content omitted because it is larger than ${formatBytes(MAX_UNTRACKED_FILE_BYTES)}): ${relativePath}`;
    }

    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    return `Untracked file: ${relativePath}\n[Could not read file: ${error instanceof Error ? error.message : String(error)}]`;
  }

  // Guard against a file that grew between `stat` and `readFile`, or a virtual
  // file system that reports an inaccurate size.
  if (bytes.length > MAX_UNTRACKED_FILE_BYTES) {
    return `Untracked file (content omitted because it is larger than ${formatBytes(MAX_UNTRACKED_FILE_BYTES)}): ${relativePath}`;
  }

  if (looksBinary(bytes)) {
    return `Untracked binary file: ${relativePath}`;
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.split(/\r?\n/).map(line => `+${line}`).join('\n');
  const patch = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    '@@',
    lines
  ].join('\n');

  return patch.length > maxChars
    ? `${patch.slice(0, maxChars)}\n[Untracked file truncated.]`
    : patch;
}

export function toRelativePath(rootUri: vscode.Uri, uri: vscode.Uri): string {
  return path.relative(rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
}
