# Changelog

## [1.30.7] - 2026-09-17

### Change 26

- Added experimental LM Studio inline autocompletion support with configurable model, context budget, timeout, and temperature settings.
- Fixed race conditions in on-demand model loading so concurrent requests no longer trigger duplicate model load operations.
- Fixed startup UX by preventing Output panel focus hijacking and hardening remote-host startup behavior.
- Improved context/token reporting and chat message-part parsing reliability across VS Code host/runtime variations.

## [1.30.6] - 2026-08-16

### Change 25

- Merged fix for Windows terminal command execution: terminal commands now run via VS Code shell integration with reliable output capture.
- Rebuilt and republished the extension for Marketplace.

## [1.30.5] - 2026-08-03

### Change 24

- Rebuilt the extension after the latest code changes and verified compilation/type-checking.
- Bumped release version for Marketplace publication.

## [1.30.4] - 2026-07-31

### Change 23

- Rebuilt the extension from source and verified TypeScript/type-check + production bundle pipeline.
- Refreshed release docs in `README.md` to reflect the current package and Marketplace deployment flow.

## [1.30.3] - 2026-07-12

### Change 22

- Rebuild and republish release packaging for `1.30.3`.

## [1.30.2] - 2026-07-12

### Change 21

- Added Gemma-specific channel-thinking filtering with a user toggle (`lmstudio-copilot.gemmaChannelThinkingTransform`) to prevent reasoning leakage in Copilot Chat.
- Strengthened Gemma stream filtering with cross-chunk pending-buffer handling for partial reasoning and channel delimiters.

## [1.30.1] - 2026-07-12

### Change 20

- Fixed model input-token limits to honor configured `maxInputTokens` while still capping by each model's advertised max context length.

## [1.30.0] - 2026-07-12

### Change 19

- Added automatic BYOK utility-model compatibility defaults to prevent the `copilot-utility-small` configuration error when utility settings are unset.

## [0.1.18] - 2026-06-16

### Change 18

- Add `lmstudio-copilot.treatAsRemote` setting. When enabled, the extension skips all local CLI operations (auto-start, `lms ls` model discovery, `lms server stop`) regardless of the server URL. This is useful when tunnelling a remote LM Studio over SSH, where the URL appears as `localhost` but should not trigger local-only commands.

## [0.1.17] - 2026-05-19

### Change 17

- Switch the Marketplace icon to `assets/Latest.png` and republish the extension as a follow-up release.

## [0.1.16] - 2026-05-19

### Change 16

- Fix LM Studio models not appearing in the VS Code 1.120 model picker by marking discovered models as user-selectable.

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres loosely to Semantic Versioning.

## [0.1.15] - 2026-05-05

### Change 15

- Published the Settings UI fix that reorganizes extension configuration into explicit sections
- Ensured the separate image generation API key surfaces under a dedicated `Image Generation` settings category
- Kept LM Studio chat auth and image backend auth clearly separated in the contributed settings UI

## [0.1.14] - 2026-05-05

### Change 14

- Reorganized the extension settings into explicit categories so the Settings UI surfaces image-generation options more clearly
- Added a dedicated `Image Generation` settings section so `lmstudio-copilot.imageGenApiKey` has an obvious place in the Settings editor
- Marked both API-key settings as machine-local to keep them out of sync and make their usage clearer in the UI

## [0.1.13] - 2026-05-05

### Change 13

- Added a dedicated `lmstudio-copilot.imageGenApiKey` setting for DALL-E and other image-generation backends
- Removed the image-tool fallback to `lmstudio-copilot.apiKey` so LM Studio chat auth and image backend auth stay fully separate
- Updated the README and tool setup guidance to document the separate image-generation credential path

## [0.1.12] - 2026-05-04

### Change 12

- Bumped the release version to publish the current aligned extension contents as a new Marketplace/GitHub release

## [0.1.11] - 2026-05-04

### Change 11

- Simplified the README to focus on the actual end-user setup and usage path
- Improved LM Studio CLI detection so the extension also checks common install locations instead of requiring `lms` to be on `PATH`
- Tightened the extension icon artwork inside `assets/Latest.png` so it fills the Marketplace icon frame more effectively

## [0.1.10] - 2026-05-04

### Change 10

- Added LM Studio CLI-backed startup so the extension can auto-start the daemon/server without requiring a manual command
- Switched model discovery to include installed local models from `lms ls --json`, not just models already loaded into the server
- Added lazy model loading so a model selected in Copilot Chat is loaded on the first prompt automatically
- Switched the extension marketplace icon to `assets/Latest.png`

## [0.1.9] - 2026-05-03

### Change 9

- Switched the extension marketplace icon to the new LM Studio logo asset

## [0.1.8] - 2026-04-28

### Added

- New `lmstudio-copilot.reasoningEffort` setting (`"default"` / `"low"` / `"medium"` / `"high"`) — sends the `reasoning_effort` parameter to models that support it (o1, o3, QwQ, and similar reasoning-capable models)
- Documented the existing `lmstudio-copilot.enableThinking` setting and added a dedicated "Extended thinking and reasoning effort" section to the README with usage examples

## [0.1.7] - 2026-04-03

### Change 8

- (Release placeholder — identical to 0.1.6 with changelog update)

## [0.1.6] - 2026-04-03

### Change 7

- Replaced Qwen-specific model-name sniffing with two user-controlled settings:
  - `lmstudio-copilot.injectSystemPrompt` — toggle the extension's system prompt injection (default: on)
  - `lmstudio-copilot.enableThinking` — toggle the `enable_thinking` parameter for thinking/CoT models (default: on)
- Removed `isQwenFamilyModel()` helpers from both provider and client — settings now apply to all model families

## [0.1.5] - 2026-03-27

### Change 6

- Improved Qwen-family model compatibility by normalizing outgoing messages before sending requests
- Added safer content sanitization for outgoing chat payloads to reduce malformed tool-call interactions
- Updated provider behavior to avoid injecting an extra system prompt when the target model or message layout already handles it

## [0.1.4] - 2026-03-27

### Change 5

- Updated extension marketplace metadata and publisher alignment for release consistency
- Switched to a PNG-only extension icon bundle and removed unused SVG icon assets

## [0.1.3] - 2026-03-19

### Change 4

- Refined the bundled extension icon based on the uploaded design: added a white background card, removed outer border bars, and adjusted the lower LM Studio symbol for cleaner overlap at small sizes

## [0.1.2] - 2026-03-19

### Change 3

- Replaced the text-heavy extension icon with a cleaner LM-style monogram mark for better small-size readability

## [0.1.1] - 2026-03-18

### Change 2

- Added a new bundled extension icon branded as **LMStudio Co-Pilot**
- Wired the icon into the extension manifest and VSIX package output

## [0.1.0] - 2026-03-18

- LM Studio model discovery and Copilot Chat provider integration
- Streaming chat completions through the LM Studio OpenAI-compatible API
- Built-in tools for terminal, file read/write, directory listing, file search, and image generation
- Optional Automatic1111 and DALL-E-compatible image generation support
- Tool budgeting for local models via `lmstudio-copilot.maxTools`
- Commands to refresh models, start the LM Studio server, stop the server terminal, and check connectivity

### Change 1

- Improved repository metadata, README, licensing, and packaging scripts for GitHub and Marketplace readiness
