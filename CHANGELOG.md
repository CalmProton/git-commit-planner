# Changelog

## 2.4.0

- Add `gitCommitPlanner.ignoredGlobs` so binary and asset content (images, SVG, 3D files, media, lockfiles, source maps, and minified bundles) stays out of the prompt while the files stay in the changed-file list.
- Add `gitCommitPlanner.openRouter.reasoningEffort` so OpenRouter reasoning effort is configurable. The default stays `none`, and the extension retries without a reasoning setting when a model requires reasoning.
- Keep untracked files larger than 1 MB out of memory and improve binary detection with a UTF-8 validity check.

## 2.3.0

- Replace the Git Commit Planner extension icon.
- Add an optional Codex Fast mode setting.
- Log operation and provider phase timings for commit generation and planning.

## 2.2.1

- Retry OpenCode requests without structured output when a thinking model rejects the required tool choice.

## 2.2.0

- Rewrite the README and setting descriptions with ASD-STE100 writing principles.
- Use short, active sentences for user instructions and setting help.

## 2.1.1

- Group settings into General, provider, prompt, and diagnostics categories.
- Add OpenCode gateway support for connected providers and models.
- Add OpenCode provider status, model, and model-variant commands.
- Use temporary OpenCode sessions with repository tools disabled.
- Add a Git Commit Planner extension icon and README preview.

## 2.1.0

- Add Codex provider support through the local Codex App Server.
- Add ChatGPT sign-in, account status, sign-out, and current model selection commands.
- Add dynamic model and reasoning-effort selection commands for Codex settings.
- Route single-message generation and Commit Planner requests through the selected provider.
- Keep Codex turns read-only and ephemeral. The extension does not store ChatGPT tokens.

## 2.0.0

- Rename the extension to Git Commit Planner for Marketplace availability.
- Rename commands, settings, views, secret keys, MIME types, context values, and diagnostics to the `gitCommitPlanner` namespace.
- Add Marketplace search terms for AI Git commit messages, commit message generation, Conventional Commits, and commit planning.

## 1.1.6

- Improve single commit message cleanup for structured and labeled model responses.
- Retry unparseable single commit responses up to two times with a repair prompt.
- Add the Plan Commits shortcut beside Generate in the Source Control menus.

## 1.1.5

- Repair invalid Commit Planner JSON by asking the model to correct missing, duplicate, or unknown files before falling back to a local completion pass.
- Add explicit file-operation context so generated commit messages do not describe deleted files as additions.

## 1.1.4

- Raise the configurable output-token ceiling to `128000`.
- Add `gitCommitPlanner.maxPlanOutputTokens` so Commit Planner can request much larger JSON plans without increasing the default token budget for single commit messages.

## 1.1.3

- Refresh Commit Planner state when Git changes are committed elsewhere, removing only files that no longer have pending changes.
- Allow deleting the final commit group to clear a stale or unwanted plan.

## 1.1.2

- Exclude local `.fallow` cache files from packaged VSIX output.

## 1.1.1

- Read resource-scoped Git Commit Planner settings using the selected repository URI so folder-level model settings are respected.

## 1.1.0

- Add a `Commit Planner` Source Control view for splitting unstaged changes into multiple AI-generated commits.
- Support moving files between commit groups, editing messages, regenerating messages, and adding or removing commit groups.
- Commit planned groups sequentially with clean-index and stale-working-tree checks.

## 1.0.2

- Rename the public settings namespace to `gitCommitPlanner`.
- Update README and Marketplace text to use Git Commit Planner and Conventional Commits wording.
- Add a local release skill for future release automation.

## 1.0.1

- Generate Conventional Commits messages by default.
- Attach the Conventional Commits 1.0.0 specification to the model prompt for `gitCommitPlanner.format: conventional`.
- Keep simple and custom formats available for workspace override.

## 1.0.0

- Publish the first stable release.
- License the project under MIT.
- Remove redundant command activation events from the extension manifest.
- Explicitly include Node and VS Code typings in the TypeScript project configuration.
- Add Marketplace metadata for the public repository, issue tracker, and homepage.
- Document OpenRouter diff processing and API key storage.

## 0.0.6

- Use structured XML prompts with a strict JSON output contract.
- Add configurable context-window budgeting with `modelContextTokens`, `maxPromptContextRatio`, and `maxPromptTokens`.
- Use Git CLI diffs as the primary tracked-diff source and keep VS Code Git API as a fallback.
- Make extension settings resource-scoped for workspace and folder configuration.

## 0.0.5

- Normalize VS Code Git API diff objects into usable patch text instead of `[object Object]`.
- Add debug logging to control verbose request/response diagnostics.
- Keep concise generation summaries enabled by default.

## 0.0.4

- Add verbose generation logs for settings, Git context, diff, prompt messages, OpenRouter request/response, raw model text, and final commit message.
- Tighten prompt instructions to avoid over-inference from small diffs.
- Preserve OpenRouter request/response diagnostics when provider calls fail.

## 0.0.3

- Disable OpenRouter reasoning by default for commit-message generation.

## 0.0.2

- Improve OpenRouter empty-response diagnostics.
- Request low reasoning effort and exclude reasoning output.
- Raise default output token budget for reasoning-model compatibility.

## 0.0.1

- Initial local version.
- Generate commit messages from Git changes through OpenRouter.
- Add Source Control toolbar commands and workspace settings.
