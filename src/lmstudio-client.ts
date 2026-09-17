import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import {
  LMStudioConfig,
  LMStudioLocalModel,
  LMStudioModel,
  LMStudioRawModel,
  ChatMessage,
  ChatMessageContentPart,
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatTool,
  ToolCall,
  getConfig,
} from './types';

// ────────────────────────────────────────────────────────────────────────────
// Stream parts — what we yield back to the provider
// ────────────────────────────────────────────────────────────────────────────

export type StreamPart =
  | { text: string }
  | { toolCall: ToolCall };

interface ThinkState {
  tag: string | null;
  pending: string;
}

interface GemmaChannelState {
  insideThought: boolean;
  pending: string;
}

// XML tool-call pattern: <tool_call>{"name":"fn","arguments":{…}}</tool_call>
const XML_TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Low-level HTTP streaming client for LM Studio's OpenAI-compatible API.
 *
 * Design principles (from studying VS Code's LanguageModelChatProvider API):
 *   - Stream text to the caller immediately — no unnecessary buffering.
 *   - Buffer ONLY when we see the start of a <tool_call> tag.
 *   - Once a tool call is yielded, suppress all further text in that turn
 *     (models often append filler like "I'm ready to help!" after tool calls).
 *   - Strip <think>…</think> reasoning traces statefully across SSE chunks.
 *   - Handle 3 tool-call formats: OpenAI delta.tool_calls, XML <tool_call>,
 *     and legacy <|channel|>…<|message|> format.
 */
export class LMStudioClient {
  private abortControllers = new Map<string, AbortController>();
  private modelLoadPromises = new Map<string, Promise<boolean>>();
  private resolvedCliPath: string | null | undefined;

  constructor(private logger: Logger) {}

  private log(msg: string): void {
    this.logger.verbose(`[Client] ${msg}`);
  }

  private warn(msg: string): void {
    this.logger.warn(`[Client] ${msg}`);
  }

  private error(msg: string): void {
    this.logger.error(`[Client] ${msg}`);
  }

  private getConfig(): LMStudioConfig {
    return getConfig();
  }

  private getCliPathSetting(): string {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    return config.get<string>('cliPath', 'lms').trim() || 'lms';
  }

  private getStartupWaitMs(): number {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    return Math.max(config.get<number>('startupWaitMs', 3000), 0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async execFileAsync(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      cp.execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        const rawCode = (error as NodeJS.ErrnoException | null)?.code;
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: code,
        });
      });
    });
  }

  private async resolveCliPath(): Promise<string | null> {
    if (this.resolvedCliPath !== undefined) {
      return this.resolvedCliPath;
    }

    const homeDir = os.homedir();
    const isWindows = process.platform === 'win32';
    const cliName = isWindows ? 'lms.exe' : 'lms';
    const candidates = [...new Set([
      this.getCliPathSetting(),
      process.env.LMSTUDIO_CLI_PATH,
      'lms',
      path.join(homeDir, '.lmstudio', 'bin', cliName),
      process.platform === 'linux' ? path.join(homeDir, '.local', 'bin', cliName) : undefined,
      process.platform === 'darwin' ? path.join('/Applications', 'LM Studio.app', 'Contents', 'Resources', cliName) : undefined,
      isWindows && process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'LM Studio', 'resources', 'bin', cliName)
        : undefined,
      isWindows && process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, '.lmstudio', 'bin', cliName)
        : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate)))];

    for (const candidate of candidates) {
      const result = await this.execFileAsync(candidate, ['--help'], 5000);
      if (result.exitCode === 0) {
        this.resolvedCliPath = candidate;
        this.log(`Resolved LM Studio CLI path: ${candidate}`);
        return candidate;
      }
    }

    this.resolvedCliPath = null;
    this.log('LM Studio CLI was not found in the configured path, PATH, or common install locations');
    return null;
  }

  private async execLms(
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = await this.resolveCliPath();
    if (!cliPath) {
      return { stdout: '', stderr: 'LM Studio CLI not found', exitCode: 127 };
    }

    this.log(`CLI: ${cliPath} ${args.join(' ')}`);
    const result = await this.execFileAsync(cliPath, args, timeoutMs);
    if (result.exitCode !== 0) {
      this.error(`CLI command failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return result;
  }

  private async execLmsJson<T>(args: string[], timeoutMs: number): Promise<T | null> {
    const result = await this.execLms(args, timeoutMs);
    if (result.exitCode !== 0) {
      return null;
    }

    const text = result.stdout.trim();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      this.warn(`Failed to parse CLI JSON for "${args.join(' ')}": ${error}`);
      return null;
    }
  }

  private async spawnDetachedLms(args: string[]): Promise<boolean> {
    const cliPath = await this.resolveCliPath();
    if (!cliPath) {
      return false;
    }

    try {
      const child = cp.spawn(cliPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      this.log(`Spawned detached CLI process: ${cliPath} ${args.join(' ')}`);
      return true;
    } catch (error) {
      this.error(`Failed to spawn detached CLI process: ${error}`);
      return false;
    }
  }

  private parseServerUrl(): URL | null {
    try {
      return new URL(this.getConfig().serverUrl);
    } catch (error) {
      this.error(`Invalid server URL: ${error}`);
      return null;
    }
  }

  public isLocalServerUrl(): boolean {
    if (this.getConfig().treatAsRemote) {
      return false;
    }

    const url = this.parseServerUrl();
    if (!url) {
      return false;
    }

    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
  }

  private mapLocalModel(model: LMStudioLocalModel, loaded: boolean): LMStudioModel {
    const maxContextLength =
      typeof model.maxContextLength === 'number'
        ? model.maxContextLength
        : typeof model.max_context_length === 'number'
          ? model.max_context_length
          : undefined;

    return {
      id: model.modelKey,
      object: 'model',
      owned_by: model.publisher || 'unknown',
      loaded,
      type: model.type,
      publisher: model.publisher,
      display_name: model.displayName,
      path: model.path,
      format: model.format,
      paramsString: model.paramsString,
      architecture: model.architecture,
      max_context_length: maxContextLength,
      capabilities: {
        vision: Boolean(model.vision),
        trained_for_tool_use: Boolean(model.trainedForToolUse),
      },
    };
  }

  private async waitForConnection(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.checkConnection()) {
        return true;
      }
      await this.sleep(1000);
    }

    return this.checkConnection();
  }

  private async waitForModelAvailability(modelId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const models = await this.getModels();
      if (models.some((model) => model.id === modelId)) {
        return true;
      }
      await this.sleep(1500);
    }

    const finalModels = await this.getModels();
    return finalModels.some((model) => model.id === modelId);
  }

  // ── Connection check ──────────────────────────────────────────────────

  async checkConnection(): Promise<boolean> {
    const config = this.getConfig();
    this.log(`Checking connection to ${config.serverUrl}...`);
    try {
      const r = await fetch(`${config.serverUrl}/api/v1/models`, {
        method: 'GET',
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      this.log(`Connection check: ${r.status}`);
      return r.ok;
    } catch (e) {
      this.error(`Connection check failed: ${e}`);
      return false;
    }
  }

  // ── Model listing ─────────────────────────────────────────────────────

  async getModels(): Promise<LMStudioModel[]> {
    const config = this.getConfig();
    this.log(`Fetching models from ${config.serverUrl}/api/v1/models...`);
    try {
      const r = await fetch(`${config.serverUrl}/api/v1/models`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(config.requestTimeout),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const raw = await r.json();
      this.log(`Raw models: ${JSON.stringify(raw).slice(0, 500)}`);

      let models: LMStudioModel[];
      if (raw?.models && Array.isArray(raw.models)) {
        const rawModels = (raw.models as LMStudioRawModel[]).filter(m => m.type !== 'embedding');
        models = rawModels.map(m => ({
          id: m.key, object: 'model', owned_by: m.publisher || 'unknown',
          type: m.type, publisher: m.publisher, display_name: m.display_name,
          architecture: m.architecture, max_context_length: m.max_context_length,
          capabilities: m.capabilities,
        }));
        this.log(`Filtered ${raw.models.length} -> ${models.length} LLM models`);
      } else if (Array.isArray(raw)) {
        models = raw;
      } else if (raw?.data && Array.isArray(raw.data)) {
        models = raw.data;
      } else {
        this.log(`Unexpected response shape: ${Object.keys(raw)}`);
        models = [];
      }
      this.log(`Found ${models.length} models: ${models.map(m => m.id).join(', ')}`);
      return models;
    } catch (e) {
      this.error(`Error fetching models: ${e}`);
      return [];
    }
  }

  async getInstalledModels(): Promise<LMStudioModel[]> {
    if (!this.isLocalServerUrl()) {
      this.log('Skipping local `lms ls` because the configured server URL is not local');
      return [];
    }

    const rawModels = await this.execLmsJson<LMStudioLocalModel[]>(['ls', '--json'], this.getConfig().requestTimeout);
    if (!Array.isArray(rawModels)) {
      return [];
    }

    const loadedIds = await this.getLoadedModelIds();
    const deduped = new Map<string, LMStudioModel>();

    for (const rawModel of rawModels) {
      if (!rawModel?.modelKey || rawModel.type === 'embedding') {
        continue;
      }

      if (deduped.has(rawModel.modelKey)) {
        continue;
      }

      deduped.set(rawModel.modelKey, this.mapLocalModel(rawModel, loadedIds.has(rawModel.modelKey)));
    }

    const models = Array.from(deduped.values());
    this.log(`Found ${models.length} installed LM Studio model(s)`);
    return models;
  }

  async getLoadedModelIds(): Promise<Set<string>> {
    if (!this.isLocalServerUrl()) {
      this.log('Skipping local `lms ps` because the configured server URL is not local');
      const liveModels = await this.getModels();
      return new Set(liveModels.map((model) => model.id));
    }

    const rawModels = await this.execLmsJson<LMStudioLocalModel[]>(['ps', '--json'], this.getConfig().requestTimeout);
    if (!Array.isArray(rawModels)) {
      return new Set<string>();
    }

    return new Set(
      rawModels
        .map((model) => model.modelKey)
        .filter((modelKey): modelKey is string => Boolean(modelKey)),
    );
  }

  async ensureServerRunning(): Promise<boolean> {
    if (await this.checkConnection()) {
      return true;
    }

    if (!this.isLocalServerUrl()) {
      this.log('Skipping CLI auto-start because the configured server URL is not local');
      return false;
    }

    const cliPath = await this.resolveCliPath();
    if (!cliPath) {
      return false;
    }

    await this.execLms(['daemon', 'up', '--json'], 15000);

    const serverStatus = await this.execLmsJson<{ running?: boolean; port?: number }>(['server', 'status', '--json'], 5000);
    if (!serverStatus?.running) {
      const url = this.parseServerUrl();
      const args = ['server', 'start', '--port', String(url?.port || 1234)];
      if (url && !['localhost', '127.0.0.1'].includes(url.hostname)) {
        args.push('--bind', url.hostname);
      }

      const spawned = await this.spawnDetachedLms(args);
      if (!spawned) {
        return false;
      }
    }

    const timeoutMs = Math.max(this.getStartupWaitMs(), 1000) + 15000;
    return this.waitForConnection(timeoutMs);
  }

  async stopServer(): Promise<boolean> {
    if (!this.isLocalServerUrl()) {
      this.log('Skipping local CLI stop because the configured server URL is not local');
      return false;
    }

    const result = await this.execLms(['server', 'stop'], 30000);
    if (result.exitCode !== 0) {
      return false;
    }

    await this.sleep(1000);
    return !(await this.checkConnection());
  }

  async ensureModelLoaded(modelId: string): Promise<boolean> {
    const existingLoadPromise = this.modelLoadPromises.get(modelId);
    if (existingLoadPromise) {
      this.log(`Waiting for in-flight model load: ${modelId}`);
      return existingLoadPromise;
    }

    const loadPromise = this.ensureModelLoadedInternal(modelId)
      .finally(() => {
        this.modelLoadPromises.delete(modelId);
      });

    this.modelLoadPromises.set(modelId, loadPromise);
    return loadPromise;
  }

  private async ensureModelLoadedInternal(modelId: string): Promise<boolean> {
    if (!this.isLocalServerUrl()) {
      const serverReady = await this.checkConnection();
      if (!serverReady) {
        this.error(`Cannot load model ${modelId} because the LM Studio server is unavailable`);
        return false;
      }

      return this.waitForModelAvailability(modelId, Math.max(this.getConfig().requestTimeout, 10 * 60 * 1000));
    }

    const serverReady = await this.ensureServerRunning();
    if (!serverReady) {
      this.error(`Cannot load model ${modelId} because the LM Studio server is unavailable`);
      return false;
    }

    const loadedModelIds = await this.getLoadedModelIds();
    if (!loadedModelIds.has(modelId)) {
      this.log(`Loading model on demand: ${modelId}`);
      const loadResult = await this.execLms(['load', modelId, '-y'], Math.max(this.getConfig().requestTimeout, 10 * 60 * 1000));
      if (loadResult.exitCode !== 0) {
        return false;
      }
    }

    return this.waitForModelAvailability(modelId, Math.max(this.getConfig().requestTimeout, 10 * 60 * 1000));
  }

  private extractMessageText(content: string | ChatMessageContentPart[] | null): string {
    if (!content) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    return content
      .filter((part): part is Extract<ChatMessageContentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  async getInlineCompletion(
    modelId: string,
    prefix: string,
    suffix: string,
    options: {
      languageId?: string;
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
    } = {},
    token?: vscode.CancellationToken,
  ): Promise<string | null> {
    const config = this.getConfig();
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? config.requestTimeout, 1000),
      30000,
    );
    const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? 96));
    const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.2;

    const requestBody: ChatCompletionRequest = {
      model: modelId,
      stream: false,
      max_tokens: maxTokens,
      temperature,
      enable_thinking: false,
      reasoning_effort: 'none',
      messages: [
        {
          role: 'system',
          content: [
            'You are an inline code completion engine.',
            'Return only the code to insert at the cursor.',
            'Do not explain your answer.',
            'Do not wrap the output in markdown fences.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Language: ${options.languageId ?? 'unknown'}`,
            'Complete the code at <cursor>.',
            'Return only the inserted text.',
            '',
            '<before>',
            prefix,
            '</before>',
            '',
            '<after>',
            suffix,
            '</after>',
          ].join('\n'),
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelDisposable = token?.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(`${config.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        this.warn(`Inline completion request failed (${response.status}): ${responseText.slice(0, 300)}`);
        return null;
      }

      const payload = await response.json() as ChatCompletionResponse;
      const firstChoice = payload.choices?.[0];
      if (!firstChoice) {
        return null;
      }

      const text = this.extractMessageText(firstChoice.message.content)
        .replace(/\r\n/g, '\n')
        .replace(/<\|(endoftext|im_end|end_of_turn|eot_id)\|>/g, '')
        .trimEnd();

      return text.length > 0 ? text : null;
    } catch (error) {
      if (controller.signal.aborted) {
        return null;
      }

      this.warn(`Inline completion request error: ${error}`);
      return null;
    } finally {
      clearTimeout(timeout);
      cancelDisposable?.dispose();
    }
  }

  // ── Streaming chat completion ─────────────────────────────────────────

  async *streamChatCompletionWithTools(
    modelId: string,
    messages: ChatMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stop?: string[];
      tools?: ChatTool[];
    } = {},
    requestId?: string,
  ): AsyncGenerator<StreamPart, void, unknown> {
    const config = this.getConfig();
    const ac = new AbortController();
    if (requestId) this.abortControllers.set(requestId, ac);

    const normalizedMessages = this.normalizeOutgoingMessages(messages);

    const body: ChatCompletionRequest = {
      model: modelId,
      messages: normalizedMessages,
      stream: true,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 32663,
      top_p: options.topP ?? 1,
      stop: options.stop,
    };
    const clientConfig = vscode.workspace.getConfiguration('lmstudio-copilot');
    const enableThinking = clientConfig.get<boolean>('enableThinking', true);
    if (!enableThinking) {
      body.enable_thinking = false;
      this.log('enable_thinking=false (user setting)');
    }

    const reasoningEffort = clientConfig.get<string>('reasoningEffort', 'default');
    if (reasoningEffort !== 'default') {
      body.reasoning_effort = reasoningEffort as 'none' | 'low' | 'medium' | 'high';
      this.log(`reasoning_effort=${reasoningEffort} (user setting)`);
    } else if (!enableThinking) {
      body.reasoning_effort = 'none';
      this.log("reasoning_effort=none (derived from enableThinking=false)");
    }
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
      this.log(`Request includes ${options.tools.length} tools`);
    }

    this.log(`POST ${config.serverUrl}/v1/chat/completions`);
    try {
      const resp = await fetch(`${config.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`LM Studio API error: ${resp.status} - ${await resp.text()}`);
      if (!resp.body) throw new Error('No response body');

      const gemmaChannelTransformEnabled = clientConfig.get<boolean>('gemmaChannelThinkingTransform', true)
        && /gemma/i.test(modelId);
      if (gemmaChannelTransformEnabled) {
        this.log(`Gemma channel-thinking transform enabled for model: ${modelId}`);
      }

      yield* this.processSSEStream(resp.body, gemmaChannelTransformEnabled);
    } finally {
      if (requestId) this.abortControllers.delete(requestId);
    }
  }

  /** Legacy convenience wrapper — yields raw text only. */
  async *streamChatCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number; topP?: number; stop?: string[] } = {},
    requestId?: string,
  ): AsyncGenerator<string, void, unknown> {
    for await (const part of this.streamChatCompletionWithTools(modelId, messages, options, requestId)) {
      if ('text' in part) yield part.text;
    }
  }

  cancelRequest(requestId: string): void {
    const c = this.abortControllers.get(requestId);
    if (c) { c.abort(); this.abortControllers.delete(requestId); }
  }

  // ====================================================================
  //  PRIVATE — SSE stream processing
  // ====================================================================

  private async *processSSEStream(
    body: ReadableStream<Uint8Array>,
    gemmaChannelTransformEnabled = false,
  ): AsyncGenerator<StreamPart, void, unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    // State
    const thinkState: ThinkState = { tag: null, pending: '' };
    const gemmaChannelState: GemmaChannelState = { insideThought: false, pending: '' };
    let holdBuffer = '';          // text held while waiting for </tool_call>
    let toolCallYielded = false;  // tracks whether ANY tool call was emitted this turn

    // OpenAI-style tool calls assembled from deltas
    const oaiToolCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          if (line === 'data: [DONE]') {
            // Flush hold buffer
            if (holdBuffer) {
              yield* this.flushHoldBuffer(holdBuffer, toolCallYielded);
              holdBuffer = '';
            }
            // Emit OpenAI-style tool calls
            for (const [idx, tc] of oaiToolCalls) {
              this.log(`OAI tool call [${idx}]: id="${tc.id}" name="${tc.name}" args="${tc.args.slice(0, 200)}"`);
              if (tc.id && tc.name) {
                toolCallYielded = true;
                yield { toolCall: { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } } };
              } else {
                this.log(`Skipping incomplete OAI tool call [${idx}]: id="${tc.id}" name="${tc.name}"`);
              }
            }
            oaiToolCalls.clear();
            continue;
          }

          if (!line.startsWith('data: ')) continue;
          let chunk: ChatCompletionChunk;
          try { chunk = JSON.parse(line.slice(6)); } catch { continue; }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          // Log finish_reason when present
          if (choice.finish_reason) {
            this.log(`finish_reason: ${choice.finish_reason} (accumulated ${oaiToolCalls.size} OAI tool calls)`);
          }

          // ── OpenAI-style delta.tool_calls ──────────────────────────
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!oaiToolCalls.has(tc.index)) oaiToolCalls.set(tc.index, { id: '', name: '', args: '' });
              const cur = oaiToolCalls.get(tc.index)!;
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
            }
          }

          // ── Text content ──────────────────────────────────────────
          const rawContent = choice.delta?.content;
          if (!rawContent) continue;

          let text = this.filterText(rawContent, thinkState);
          if (gemmaChannelTransformEnabled) {
            text = this.filterGemmaChannelContent(text, gemmaChannelState);
          }
          if (!text) continue;

          // Always accumulate into holdBuffer so we can detect tool calls
          // even after a previous tool call was already yielded.
          holdBuffer += text;

          // Try to extract tool calls from the buffer first
          let foundToolCall = false;

          // Check for complete XML tool calls
          if (holdBuffer.includes('</tool_call>')) {
            const parsed = this.parseXmlToolCalls(holdBuffer);
            if (parsed.calls.length > 0) {
              for (const tc of parsed.calls) { toolCallYielded = true; yield { toolCall: tc }; }
              holdBuffer = parsed.remaining;
              foundToolCall = true;
            }
          }

          // Check for legacy tool calls
          if (holdBuffer.includes('<|channel|>') && holdBuffer.includes('<|message|>') && holdBuffer.includes('}')) {
            const parsed = this.parseLegacyToolCalls(holdBuffer);
            if (parsed.calls.length > 0) {
              for (const tc of parsed.calls) { toolCallYielded = true; yield { toolCall: tc }; }
              holdBuffer = parsed.remaining;
              foundToolCall = true;
            }
          }

          if (foundToolCall) continue;

          // Still accumulating a partial tool-call tag → keep holding
          if (holdBuffer.includes('<tool_call') || holdBuffer.includes('<|channel|>')) {
            continue;
          }

          // No tool-call tag in buffer → emit as text (but only if no
          // tool call was ever yielded — text after tool calls is filler)
          if (!toolCallYielded) {
            yield { text: holdBuffer };
          }
          holdBuffer = '';
        }
      }

      // Stream ended — flush remaining
      if (holdBuffer) yield* this.flushHoldBuffer(holdBuffer, toolCallYielded);
      for (const [, tc] of oaiToolCalls) {
        if (tc.id && tc.name) {
          yield { toolCall: { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } } };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Flush the hold buffer: extract tool calls, then emit remaining text only if no tool call was ever yielded. */
  private *flushHoldBuffer(buf: string, alreadyYielded: boolean): Generator<StreamPart, void, unknown> {
    const xml = this.parseXmlToolCalls(buf);
    const legacy = this.parseLegacyToolCalls(xml.remaining);
    const allCalls = [...xml.calls, ...legacy.calls];
    for (const tc of allCalls) yield { toolCall: tc };
    if (allCalls.length === 0 && !alreadyYielded) {
      const cleaned = legacy.remaining.trim();
      if (cleaned) yield { text: cleaned };
    }
  }

  // ── Text filtering ────────────────────────────────────────────────────

  /**
   * Strip reasoning tags from streamed text with cross-chunk state.
   * Supports <think>, <thinking>, <reasoning>, and <reflection> blocks.
   */
  private filterText(raw: string, state: ThinkState): string {
    const tags = ['think', 'thinking', 'reasoning', 'reflection'];
    let buf = state.pending + raw;
    state.pending = '';

    let out = '';
    let i = 0;

    while (i < buf.length) {
      if (state.tag) {
        const closeTag = `</${state.tag}>`;
        const close = buf.indexOf(closeTag, i);
        if (close === -1) {
          const keep = Math.max(closeTag.length - 1, 0);
          state.pending = buf.slice(Math.max(i, buf.length - keep));
          return out.replace(/<\|(startofstream|endofstream|im_start|im_end|endoftext|end_of_turn|eot_id)\|>/g, '');
        }
        i = close + closeTag.length;
        if (buf[i] === '\n') i++;
        state.tag = null;
        continue;
      }

      let bestTag: string | null = null;
      let bestIdx = -1;
      let bestOpenLen = 0;

      for (const tag of tags) {
        const open = `<${tag}>`;
        const idx = buf.indexOf(open, i);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestTag = tag;
          bestOpenLen = open.length;
        }
      }

      if (bestIdx === -1 || !bestTag) {
        out += buf.slice(i);
        break;
      }

      out += buf.slice(i, bestIdx);
      i = bestIdx + bestOpenLen;
      state.tag = bestTag;
    }

    // Keep trailing partial delimiter for the next chunk to avoid leaking fragment tokens.
    const partial = out.match(/<[\/a-zA-Z_-]*$/);
    if (!state.tag && partial && partial.index !== undefined) {
      out = out.slice(0, partial.index);
      state.pending = partial[0];
    }

    return out.replace(/<\|(startofstream|endofstream|im_start|im_end|endoftext|end_of_turn|eot_id)\|>/g, '');
  }

  /**
   * Gemma-only channel filter with cross-chunk pending support.
   * Hides thought/analysis channels while preserving function-call channels.
   */
  private filterGemmaChannelContent(raw: string, state: GemmaChannelState): string {
    const channelTokenRe = /(<channel\|>)|(<\|channel\|>|<\|channel>)\s*([^\n<]*)/gi;
    let buf = state.pending + raw;
    state.pending = '';

    let cursor = 0;
    let output = '';

    for (const match of buf.matchAll(channelTokenRe)) {
      const matchText = match[0] ?? '';
      const index = match.index ?? 0;

      const before = buf.slice(cursor, index);
      if (!state.insideThought) {
        output += before;
      }

      const isMalformedClose = Boolean(match[1]);
      const rawLabel = (isMalformedClose ? '' : match[3] ?? '').trim();
      const label = rawLabel.toLowerCase();

      // Preserve function channels so downstream legacy tool parser can still decode calls.
      if (isMalformedClose) {
        state.insideThought = false;
      } else if (label.startsWith('to=functions/')) {
        state.insideThought = false;
        output += matchText;
      } else if (
        label === 'thought'
        || label === 'thinking'
        || label === 'analysis'
        || label === 'reasoning'
        || label === 'reflection'
        || label === 'commentary'
      ) {
        state.insideThought = true;
      } else if (
        label === 'final'
        || label === 'assistant'
        || label === 'response'
        || label === 'answer'
      ) {
        state.insideThought = false;
      }

      cursor = index + matchText.length;
    }

    const tail = buf.slice(cursor);
    if (!state.insideThought) {
      output += tail;
    }

    // If a channel token starts but is incomplete, hold it for the next SSE chunk.
    const partial = buf.match(/<\|?[a-zA-Z_]*$/);
    if (partial && partial.index !== undefined && partial.index + partial[0].length === buf.length) {
      state.pending = partial[0];
      if (!state.insideThought && output.endsWith(partial[0])) {
        output = output.slice(0, -partial[0].length);
      }
    }

    return output;
  }

  // ── Tool-call parsers ─────────────────────────────────────────────────

  /** Parse <tool_call>{…}</tool_call> blocks. */
  private parseXmlToolCalls(text: string): { calls: ToolCall[]; remaining: string } {
    const calls: ToolCall[] = [];
    let remaining = text;
    let idx = 0;
    for (const m of text.matchAll(XML_TOOL_CALL_RE)) {
      try {
        const parsed = JSON.parse(m[1].trim()) as { name?: string; arguments?: unknown };
        if (parsed.name) {
          const argsStr = typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});
          calls.push({ id: `call_${Date.now()}_${idx++}`, type: 'function', function: { name: parsed.name, arguments: argsStr } });
          remaining = remaining.replace(m[0], '');
          this.log(`Parsed XML tool call: ${parsed.name}`);
        }
      } catch (e) { this.log(`XML tool-call parse error: ${e}`); }
    }
    return { calls, remaining };
  }

  /** Parse legacy <|channel|>…<|message|>{…} and <|fn_name|>{…} formats. */
  private parseLegacyToolCalls(text: string): { calls: ToolCall[]; remaining: string } {
    const calls: ToolCall[] = [];
    let remaining = text;
    let idx = 0;

    const channelRe = /<\|channel\|>.*?to=functions\/([^\s<]+)\s*<\|constrain\|>json<\|message\|>([\s\S]*?\})(?=<\||$)/g;
    for (const m of text.matchAll(channelRe)) {
      try {
        JSON.parse(m[2]);
        calls.push({ id: `call_${Date.now()}_${idx++}`, type: 'function', function: { name: m[1], arguments: m[2] } });
        remaining = remaining.replace(m[0], '');
        this.log(`Parsed legacy tool call: ${m[1]}`);
      } catch { /* skip */ }
    }

    const simpleRe = /<\|([a-zA-Z_][a-zA-Z0-9_]*)\|>(\{[\s\S]*?\})(?=<\||$)/g;
    const skip = new Set(['channel', 'constrain', 'message', 'endoftext', 'im_start', 'im_end']);
    for (const m of remaining.matchAll(simpleRe)) {
      if (skip.has(m[1].toLowerCase())) continue;
      try {
        JSON.parse(m[2]);
        calls.push({ id: `call_${Date.now()}_${idx++}`, type: 'function', function: { name: m[1], arguments: m[2] } });
        remaining = remaining.replace(m[0], '');
        this.log(`Parsed simple tool call: ${m[1]}`);
      } catch { /* skip */ }
    }

    remaining = remaining
      .replace(/<\|channel\|>.*?(?=<\||$)/g, '')
      .replace(/<\|constrain\|>.*?(?=<\||$)/g, '')
      .replace(/<\|message\|>/g, '')
      .trim();

    return { calls, remaining };
  }

  private normalizeOutgoingMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages
      .map((m) => {
        const sanitized = this.sanitizeOutgoingContent(m.content);
        const empty = this.isContentEmpty(sanitized);

        if (m.role === 'assistant' && m.tool_calls?.length) {
          return { ...m, content: empty ? null : sanitized };
        }

        // Drop messages that are empty (unless it's an assistant with tool_calls)
        if (empty) return null;

        return { ...m, content: sanitized };
      })
      .filter((m): m is ChatMessage => m !== null);
  }

  private isContentEmpty(content: string | ChatMessageContentPart[] | null): boolean {
    if (!content) return true;
    if (typeof content === 'string') return content.trim().length === 0;
    if (Array.isArray(content)) {
      if (content.length === 0) return true;
      return content.every(part => part.type === 'text' && part.text.trim().length === 0);
    }
    return false;
  }

  private sanitizeOutgoingContent(content: string | ChatMessageContentPart[] | null): string | ChatMessageContentPart[] | null {
    if (content === null) return null;
    if (Array.isArray(content)) {
      return content
        .map(part => {
          if (part.type === 'text') {
            const cleaned = part.text
              .replace(/<\|(startofstream|endofstream|im_start|im_end|endoftext|end_of_turn|eot_id)\|>/g, '')
              .replace(/<\/?(tool_response|tool_call)>/g, '')
              .trim();
            return { ...part, text: cleaned };
          }
          return part;
        })
        .filter(part => part.type !== 'text' || part.text.length > 0);
    }
    return content
      .replace(/<\|(startofstream|endofstream|im_start|im_end|endoftext|end_of_turn|eot_id)\|>/g, '')
      .replace(/<\/?(tool_response|tool_call)>/g, '')
      .trim();
  }

}
