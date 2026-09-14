# Git Commit Planner

VS Code extension that generates Git commit messages and plans multi-commit changes with OpenRouter, Codex, or OpenCode.

[Install Git Commit Planner](https://marketplace.visualstudio.com/items?itemName=MadElectron.git-commit-planner)

![Git Commit Planner preview](./docs/commit-planner-preview.png)

## Features

- Adds a Generate action to the Source Control toolbar.
- Uses staged changes when they exist.
- Uses unstaged and untracked changes when no staged changes exist.
- Writes the generated message to the Git commit message input.
- Supports OpenRouter API keys.
- Supports ChatGPT sign-in through the local Codex App Server.
- Supports optional Codex Fast mode.
- Supports OpenCode as a gateway for configured providers.
- Does not store ChatGPT, Codex, or OpenCode provider credentials.
- Supports workspace settings in `.vscode/settings.json`.
- Writes generation summaries to the `Git Commit Planner` output channel.
- Generates Conventional Commits messages by default, such as `fix(api): correct pagination offset`.
- Adds a Commit Planner Source Control view for multi-commit changes.

## Commands

- `Git Commit Planner: Generate`
- `Git Commit Planner: Plan Commits`
- `Git Commit Planner: Commit Plan`
- `Git Commit Planner: Regenerate Plan`
- `Git Commit Planner: Edit Commit Message`
- `Git Commit Planner: Regenerate Commit Message`
- `Git Commit Planner: Move File to Commit`
- `Git Commit Planner: Add Commit Group`
- `Git Commit Planner: Remove Commit Group`
- `Git Commit Planner: Set OpenRouter API Key`
- `Git Commit Planner: Clear OpenRouter API Key`
- `Git Commit Planner: Sign in to Codex with ChatGPT`
- `Git Commit Planner: Sign out of Codex`
- `Git Commit Planner: Show Codex Account Status`
- `Git Commit Planner: Select Codex Model`
- `Git Commit Planner: Select Codex Reasoning Effort`
- `Git Commit Planner: Show OpenCode Provider Status`
- `Git Commit Planner: Select OpenCode Model`
- `Git Commit Planner: Select OpenCode Model Variant`

![Git Commit Planner commands in the VS Code Command Palette](./docs/command-palette.png)

## Settings

Example `.vscode/settings.json`:

```json
{
  "gitCommitPlanner.provider": "codex",
  "gitCommitPlanner.codex.model": "",
  "gitCommitPlanner.codex.reasoningEffort": "",
  "gitCommitPlanner.codex.fastMode": false,
  "gitCommitPlanner.openRouter.model": "openrouter/auto",
  "gitCommitPlanner.opencode.model": "",
  "gitCommitPlanner.opencode.variant": "",
  "gitCommitPlanner.format": "conventional",
  "gitCommitPlanner.includeBody": "auto",
  "gitCommitPlanner.preferStaged": true,
  "gitCommitPlanner.modelContextTokens": 200000,
  "gitCommitPlanner.maxPromptContextRatio": 0.6,
  "gitCommitPlanner.maxPromptTokens": 0,
  "gitCommitPlanner.maxDiffChars": 0,
  "gitCommitPlanner.maxOutputTokens": 800,
  "gitCommitPlanner.maxPlanOutputTokens": 32000,
  "gitCommitPlanner.debugLogging": false,
  "gitCommitPlanner.customInstructions": "Use concise commit messages. Do not mention generated files unless they are the main change."
}
```

The Settings editor shows six categories: General, OpenRouter, Codex, OpenCode, Prompt & Limits, and Diagnostics. The setting IDs in `settings.json` stay the same.

Do not store API keys in workspace settings. Use `Git Commit Planner: Set OpenRouter API Key` to save the OpenRouter key in VS Code SecretStorage.

To use Codex, install the Codex CLI. Select `codex` as the provider. Run `Git Commit Planner: Sign in to Codex with ChatGPT`.

When `gitCommitPlanner.provider` is `codex`, leave `gitCommitPlanner.codex.model` empty to use the Codex default. Use `Git Commit Planner: Select Codex Model` to select a model for the account. Model availability depends on the signed-in account. Use `Git Commit Planner: Select Codex Reasoning Effort` to select a supported value. Leave this setting empty to use the model default.

Set `gitCommitPlanner.codex.fastMode` to `true` to request [Codex Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed). The selected model must support Fast mode. Fast mode increases ChatGPT credit use or API cost.

To use OpenCode, install the OpenCode CLI. Run `opencode auth login` for each provider that you want to use.

When `gitCommitPlanner.provider` is `opencode`, Git Commit Planner starts `opencode serve` on the local loopback address when `gitCommitPlanner.opencode.serverUrl` is empty. It reads connected providers and models from this server.

Leave `gitCommitPlanner.opencode.model` empty to use the OpenCode default. Use `Git Commit Planner: Select OpenCode Model` to select a connected model. Use `Git Commit Planner: Select OpenCode Model Variant` to select a model variant. Set `gitCommitPlanner.opencode.serverUrl` when an OpenCode server already runs.

OpenCode supports hosted providers and custom OpenAI-compatible endpoints. Configure these providers in OpenCode before you use them. Git Commit Planner creates a temporary session with repository tools disabled. OpenCode manages provider authentication. The extension does not store these credentials.

The default value of `gitCommitPlanner.format` is `conventional`. Set it to `simple` or `custom` when you need another format.

OpenRouter does not use reasoning tokens by default. If OpenRouter returns no message content, increase `gitCommitPlanner.maxOutputTokens`. You can also select a concrete non-reasoning model instead of `openrouter/auto`.

Codex uses the selected model defaults when `gitCommitPlanner.codex.reasoningEffort` is empty. OpenCode uses the selected model defaults. Commit Planner uses `gitCommitPlanner.maxPlanOutputTokens` for plan JSON.

## Conventional Commits

Git Commit Planner follows the [Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/). The [conventional-commits/conventionalcommits.org](https://github.com/conventional-commits/conventionalcommits.org) repository contains the specification source.

## Privacy

Git Commit Planner reads Git diffs only when you run a generation command. It reads diffs from the selected repository.

With OpenRouter, the extension sends the diff and prompt to the configured OpenRouter API endpoint. The OpenRouter key is stored in VS Code SecretStorage. The extension does not write the key to workspace settings.

With Codex, the extension sends the prompt through the local Codex App Server. Codex manages ChatGPT authentication and account tokens.

With OpenCode, the extension sends the prompt through the configured OpenCode server. OpenCode manages provider authentication.

The extension does not store Codex or OpenCode credentials. Generation sessions are temporary. Repository tools are disabled.

## Large Changes

The extension does not fetch OpenRouter model metadata. It uses a configurable context size.

- `gitCommitPlanner.modelContextTokens`: sets the assumed model context size. Default: `200000`.
- `gitCommitPlanner.maxPromptContextRatio`: sets the maximum context fraction for the prompt. Default: `0.6`.
- `gitCommitPlanner.maxPromptTokens`: sets a direct prompt token limit. Set it to `0` to calculate the limit from the context size and ratio.

The extension uses the token limit to budget the diff. It reserves space for instructions and model output.

Large diffs are split at file patch boundaries when possible. The extension can truncate the diff at these boundaries. Set `gitCommitPlanner.maxDiffChars` to add a character limit. Set it to `0` to use token budgeting only.

## Commit Planner

Use `Git Commit Planner: Plan Commits` or the Commit Planner Source Control view to split unstaged and untracked changes into multiple whole-file commits.

The index must be clean before you use this workflow. Unstage existing staged changes before you plan or commit.

The planner requests up to `gitCommitPlanner.maxPlanOutputTokens` output tokens. The default is `32000`. This limit gives large plans space for all commits and file paths.

The planner reserves this limit before it compacts the diff.

If the provider returns an incomplete plan, the planner asks the provider to repair it. The repair request includes the missing, duplicate, and unknown file lists.

If repair fails, the planner completes the plan locally. It keeps valid groups and adds the remaining files to related or fallback groups. These groups need message review.

After the planner creates a plan, you can move files between groups. You can edit messages, regenerate messages, add groups, or remove groups.

`Git Commit Planner: Commit Plan` checks the index and the working tree before it commits. It then stages and commits each group in order.

## Settings UI

After you install or update the VSIX, reload VS Code. Open Settings and search for `Git Commit Planner`, `gitCommitPlanner`, or `@ext:MadElectron.git-commit-planner`.

## Diagnostics

Open the `Git Commit Planner` output channel when a generated message looks wrong.

Each generation logs:

- extension version
- selected repository and change source
- changed files and statuses
- response summary
- final sanitized commit message
- operation phase timings
- provider phase timings

Operation timings include provider readiness, diff collection, prompt construction, provider generation, response parsing, and schema repair. Provider timings include the available server, thread, session, model-turn, and cleanup phases.

Enable verbose diagnostics with:

```json
{
  "gitCommitPlanner.debugLogging": true
}
```

Verbose diagnostics also include:

- diff sent to the provider
- prompt messages sent to the provider
- redacted provider request data
- provider response data
- extracted model text
- final sanitized commit message

## Development

```bash
bun install
bun run compile
bun test
```

Codex support requires a working `codex` command. Set `gitCommitPlanner.codex.command` to the full executable path when `codex` is not in PATH.

OpenCode support requires a working `opencode` command or an existing server URL in `gitCommitPlanner.opencode.serverUrl`. Set `gitCommitPlanner.opencode.command` to the full executable path when `opencode` is not in PATH.

Press `F5` in VS Code to launch an Extension Development Host.
