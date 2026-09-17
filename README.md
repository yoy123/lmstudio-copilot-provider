# LM Studio for Copilot Chat

Run local LM Studio models inside VS Code Copilot Chat with streaming responses, tool calling, and optional image generation.

If LM Studio is installed on your machine, the extension is designed to work out of the box. It also supports connecting to remote LM Studio servers.

Install from the VS Code Marketplace:

[DanLambiase.lmstudio-copilot-provider](https://marketplace.visualstudio.com/items?itemName=DanLambiase.lmstudio-copilot-provider)

## What it does

- Adds LM Studio models to the Copilot Chat model picker
- Streams responses directly into VS Code chat
- Can auto-start LM Studio and lazy-load the selected model on first use (when using localhost)
- Supports remote LM Studio servers without local CLI dependencies

## Requirements

- VS Code 1.104.0 or later
- LM Studio server accessible at the configured URL (default: `http://localhost:1234`)
- For local usage: LM Studio installed on your machine
- For remote usage: Access to a running LM Studio server on another machine

## Quick Start

1. Install this extension.
2. Open Copilot Chat.
3. Pick an LM Studio model.
4. Send a prompt.

No separate CLI install, PATH setup, or manual model preload should be required for local setups.

## Remote Server Usage

You can connect to an LM Studio server running on a remote machine:

1. Set `lmstudio-copilot.serverUrl` to the remote server's URL (e.g., `http://your-server:1234`).
2. Ensure the remote server is running and accessible.
3. When using a remote server, local CLI features (auto-start, model discovery via CLI) are automatically disabled to avoid attempting to control the remote instance.

This is useful for setups where LM Studio runs on a dedicated server or in a container.

### SSH tunnelling ("looks-local" remote server)

If you tunnel a remote LM Studio over SSH, its URL on your local machine is still `http://localhost:1234`. The extension would normally treat this as a local installation and attempt CLI operations, which will fail because LM Studio is not actually installed locally.

Enable **Treat As Remote** to prevent this:

```json
"lmstudio-copilot.treatAsRemote": true
```

With this option enabled the extension skips all local CLI operations (auto-start, `lms ls` model discovery, `lms server stop`) regardless of how the server URL looks.

### Manual provider JSON fallback

If the VS Code GUI for adding a custom chat model is bugged, you can fall back to a manual provider definition and paste a model entry like this:

```json
{
  "name": "LM Studio",
  "vendor": "customendpoint",
  "apiKey": "lm-studio",
  "apiType": "chat-completions",
  "models": [
    {
      "id": "qwen/qwen3.6-27b",
      "name": "qwen/qwen3.6-27b",
      "url": "http://YOUR_TAILSCALE_IP:1234/v1/chat/completions",
      "toolCalling": true,
      "vision": false,
      "maxInputTokens": 80000,
      "maxOutputTokens": 16000,
      "streaming": true
    }
  ]
}
```

Replace the model `id`, display `name`, and `url` with the values exposed by your LM Studio server. Set `toolCalling` and `vision` to match the capabilities of the model you are exposing.
`maxInputTokens` should be the model's total context window. Copilot Chat reserves `maxOutputTokens` from that total for the response when calculating prompt capacity.

## About The CLI

You do not need to install the LM Studio CLI separately.

The CLI ships with LM Studio, and the extension will try to find it automatically for local installations.

The extension tries to find the CLI in this order:

- `lmstudio-copilot.cliPath`
- `lms` on `PATH`
- common LM Studio install locations

For most users, nothing needs to be configured here. CLI features are skipped when using remote servers.

## Important Settings

Most users can leave the defaults alone. These are the settings that matter most:

- `lmstudio-copilot.serverUrl`: LM Studio server URL (default: `http://localhost:1234`)
- `lmstudio-copilot.treatAsRemote`: Always treat the server as remote — disables all local CLI operations. Enable this when you tunnel a remote LM Studio over SSH so its URL looks like `localhost`.
- `lmstudio-copilot.cliPath`: Override the LM Studio CLI path if auto-detection does not find it
- `lmstudio-copilot.autoStartServer`: Start LM Studio automatically when the extension activates
- `lmstudio-copilot.launchCommand`: Fallback terminal command if CLI-based startup is unavailable
- `lmstudio-copilot.enableToolCalling`: Enable tool calling for supported models
- `lmstudio-copilot.maxTools`: Limit the number of tools exposed per request
- `lmstudio-copilot.imageGenEndpointUrl`: Base URL for DALL-E/OpenAI-compatible or A1111 image generation
- `lmstudio-copilot.imageGenApiKey`: Dedicated API key for image generation backends such as OpenAI DALL-E
- `lmstudio-copilot.logLevel`: Controls output logging verbosity. Default is `verbose`; set to `info`, `warning`, `error`, or `none`.

## Commands

- `LM Studio: Refresh Available Models`
- `LM Studio: Start Server in Integrated Terminal`
- `LM Studio: Stop Server Terminal`
- `LM Studio: Check Server Connection`

## Usage

Select an LM Studio model in Copilot Chat and start chatting. The extension will use LM Studio automatically and, when possible, start the local server and load the selected model for you.

## Optional Features

- Tool calling for supported local models
- Optional image generation through A1111 or DALL-E-compatible endpoints

### DALL-E Setup

Use these settings for OpenAI image generation:

```json
{
 "lmstudio-copilot.imageGenBackend": "dalle",
 "lmstudio-copilot.imageGenEndpointUrl": "https://api.openai.com",
 "lmstudio-copilot.imageGenApiKey": "sk-...",
 "lmstudio-copilot.imageGenModel": "dall-e-3"
}
```

`lmstudio-copilot.imageGenApiKey` is completely separate from `lmstudio-copilot.apiKey`. Chat requests keep using the LM Studio server key, and image generation uses only the dedicated image backend key.

For other OpenAI-compatible image servers, do not assume `dall-e-3` exists. Set `lmstudio-copilot.imageGenModel` to the exact model ID exposed by that server, or leave it blank so the extension can avoid forcing the OpenAI default.

## Troubleshooting

### Models not appearing

- Make sure LM Studio is running
- Check `lmstudio-copilot.serverUrl`
- Run `LM Studio: Check Server Connection`
- If LM Studio is installed in a non-standard location, set `lmstudio-copilot.cliPath`

### BYOK utility model error

If you see this Copilot error:

`No utility model is configured for 'copilot-utility-small' while the selected main agent model is BYOK.`

the extension now auto-fixes this on startup by setting compatible defaults when the chat utility model settings are not already explicitly configured.

To disable auto-fix behavior:

```json
{
  "lmstudio-copilot.autoFixByokUtilityModel": false
}
```

Manual fallback (if you prefer explicit chat settings):

```json
{
  "chat.byokUtilityModelDefault": "mainAgent",
  "chat.utilityModel": "",
  "chat.utilitySmallModel": ""
}
```

Then run **Developer: Reload Window**.

### Slow responses

- LM Studio performance depends on your hardware and the model size
- Consider using a smaller/faster model
- Increase the timeout in settings if needed

### Gemma reasoning text appears in chat

Some Gemma-family models may stream channel-style thinking markers instead of standard OpenAI-style hidden reasoning.

This extension automatically transforms Gemma channel-thinking output by default.

If needed, you can toggle this behavior:

```json
{
  "lmstudio-copilot.gemmaChannelThinkingTransform": true
}
```

## Development

```bash
# Install dependencies
npm install

# Compile and watch
npm run watch

# Package the extension
npm run package

# Build a VSIX for local install / Marketplace submission
npm run package:vsix

# Publish to VS Code Marketplace (requires VSCE_PAT)
npm run publish:vsce
```

### Release workflow

Typical release flow used by this project:

1. Rebuild: `npm run compile`
2. Production bundle: `npm run package`
3. VSIX artifact: `npm run package:vsix`
4. Publish: `npm run publish:vsce`

If publishing from CI or a non-interactive shell, export `VSCE_PAT` before step 4.

## License

MIT
