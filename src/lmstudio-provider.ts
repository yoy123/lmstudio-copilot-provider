import * as vscode from 'vscode';
import { LMStudioClient } from './lmstudio-client';
import { Logger } from './logger';
import { normalizeToolParameters } from './tool-schema';
import { LMStudioModel, ChatMessage, ChatTool, ChatMessageContentPart } from './types';

/**
 * Information about an LM Studio model for VS Code
 */
interface LMStudioModelInfo extends vscode.LanguageModelChatInformation {
  lmstudioModelId: string;
  isLoaded: boolean;
  isUserSelectable: boolean;
}

/**
 * LM Studio language model provider for VS Code Copilot.
 *
 * KEY DESIGN DECISIONS (from reading VS Code's LanguageModelChatProvider source):
 *
 * 1. VS Code ALWAYS sends the FULL conversation history in every call to
 *    provideLanguageModelChatResponse. We do NOT need our own history store.
 *    Each call includes all prior user messages, assistant messages (including
 *    our tool calls), and tool results.
 *
 * 2. We are a PURE LLM PROXY. When the model wants to call a tool, we report
 *    a ToolCallPart and return. VS Code executes the tool, then makes a NEW
 *    call to provideLanguageModelChatResponse with the result appended.
 *    We do NOT call vscode.lm.invokeTool ourselves.
 *
 * 3. We prepend exactly ONE system message (merged into the jinja template's
 *    system block) with minimal behavioral rules. We do NOT list tools (the
 *    template's <tools> block handles that), and we do NOT add multiple system
 *    messages (they break the model's expected chat structure).
 *
 * 4. Tool-call deduplication is the only provider-level state we maintain.
 */
export class LMStudioProvider implements vscode.LanguageModelChatProvider<LMStudioModelInfo> {
  private _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  private availableModels: LMStudioModel[] = [];
  private disposables: vscode.Disposable[] = [];

  // Tool-call deduplication — prevent the same call from being reported twice
  // within a single streaming response (some models stutter).
  // Reset at the start of each provideLanguageModelChatResponse call.
  private requestDedupSet = new Set<string>();

  // Short-circuit image tool results only once per callId. Otherwise a stale
  // failure can be echoed forever on later turns without a fresh tool call.
  private shortCircuitedToolCallIds = new Set<string>();

  constructor(
    private client: LMStudioClient,
    private context: vscode.ExtensionContext,
    private logger: Logger
  ) {
    this.disposables.push(this._onDidChangeLanguageModelChatInformation);
  }

  private log(msg: string): void {
    this.logger.verbose(`[Provider] ${msg}`);
  }

  private warn(msg: string): void {
    this.logger.warn(`[Provider] ${msg}`);
  }

  private error(msg: string): void {
    this.logger.error(`[Provider] ${msg}`);
  }

  /**
   * True when the running VS Code version can decode a `usage` data part from
   * our stream into session token accounting (verified on 1.140). On older
   * versions we skip emitting it so it doesn't surface as a stray attachment.
   */
  private static supportsUsageReporting(): boolean {
    const [major, minor] = vscode.version.split('.').map((part) => parseInt(part, 10));
    return major > 1 || (major === 1 && minor >= 140);
  }

  private isAssistantRole(role: vscode.LanguageModelChatMessageRole | string): boolean {
    return role === vscode.LanguageModelChatMessageRole.Assistant || role === 'assistant';
  }

  private isUserRole(role: vscode.LanguageModelChatMessageRole | string): boolean {
    return role === vscode.LanguageModelChatMessageRole.User || role === 'user';
  }

  private isTextPartLike(part: unknown): part is { value: string } {
    if (part instanceof vscode.LanguageModelTextPart) {
      return true;
    }

    if (typeof part !== 'object' || part === null) {
      return false;
    }

    const candidate = part as { value?: unknown };
    return typeof candidate.value === 'string';
  }

  private textPartValue(part: unknown): string {
    if (!this.isTextPartLike(part)) {
      return '';
    }

    return part.value;
  }

  private isToolCallPartLike(part: unknown): part is { callId: string; name: string; input: unknown } {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return true;
    }

    if (typeof part !== 'object' || part === null) {
      return false;
    }

    const candidate = part as { callId?: unknown; name?: unknown; input?: unknown };
    return typeof candidate.callId === 'string'
      && typeof candidate.name === 'string'
      && Object.prototype.hasOwnProperty.call(candidate, 'input');
  }

  private isToolResultPartLike(part: unknown): part is { callId: string; content: unknown } {
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return true;
    }

    if (typeof part !== 'object' || part === null) {
      return false;
    }

    const candidate = part as { callId?: unknown; content?: unknown };
    return typeof candidate.callId === 'string'
      && Object.prototype.hasOwnProperty.call(candidate, 'content');
  }

  private isImageDataPartLike(part: unknown): part is { mimeType: string; data: unknown } {
    if (part instanceof vscode.LanguageModelDataPart) {
      return part.mimeType.startsWith('image/');
    }

    if (typeof part !== 'object' || part === null) {
      return false;
    }

    const candidate = part as { mimeType?: unknown; data?: unknown };
    return typeof candidate.mimeType === 'string'
      && candidate.mimeType.startsWith('image/')
      && Object.prototype.hasOwnProperty.call(candidate, 'data');
  }

  private toBuffer(data: unknown): Buffer | null {
    if (data instanceof Uint8Array) {
      return Buffer.from(data);
    }

    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(data));
    }

    if (Array.isArray(data) && data.every((item) => typeof item === 'number')) {
      return Buffer.from(data);
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Model discovery
  // ──────────────────────────────────────────────────────────────────────

  async refreshModels(): Promise<void> {
    this.log('Refreshing models...');
    const [installedModels, liveModels] = await Promise.all([
      this.client.getInstalledModels(),
      this.client.getModels(),
    ]);

    const mergedModels = new Map<string, LMStudioModel>();

    for (const model of installedModels) {
      mergedModels.set(model.id, model);
    }

    for (const model of liveModels) {
      const existing = mergedModels.get(model.id);
      mergedModels.set(model.id, {
        ...existing,
        ...model,
        loaded: true,
        display_name: model.display_name ?? existing?.display_name,
        publisher: model.publisher ?? existing?.publisher,
        // The live API entry may omit the context length (e.g. older server
        // shapes) — don't clobber a known value from `lms ls` with undefined.
        max_context_length: model.max_context_length ?? existing?.max_context_length,
      });
    }

    this.availableModels = Array.from(mergedModels.values()).sort((left, right) => {
      const leftLoaded = left.loaded ? 1 : 0;
      const rightLoaded = right.loaded ? 1 : 0;
      if (leftLoaded !== rightLoaded) {
        return rightLoaded - leftLoaded;
      }

      return this.getDisplayName(left).localeCompare(this.getDisplayName(right));
    });

    if (this.availableModels.length === 0) {
      this.log('No models available from LM Studio');
    } else {
      this.log(`Found ${this.availableModels.length} model(s): ${this.availableModels.map(m => m.id).join(', ')}`);
    }

    this._onDidChangeLanguageModelChatInformation.fire();
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<LMStudioModelInfo[]> {
    this.log(`provideLanguageModelChatInformation: ${this.availableModels.length} models`);

    // Conservative input cap for models that don't report a context length.
    // Keeps the session-usage widget (and auto-compaction) functional instead
    // of assuming an unbounded window.
    const FALLBACK_CONTEXT_TOKENS = 32768;

    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const configuredMaxInputTokens = config.get<number>('maxInputTokens', 1048576);
    const configuredMaxOutputTokens = config.get<number>('maxOutputTokens', 16384);
    const enableToolCalling = config.get<boolean>('enableToolCalling', true);

    return this.availableModels.map(model => {
      const contextLength = typeof model.max_context_length === 'number' && model.max_context_length > 0
        ? model.max_context_length
        : FALLBACK_CONTEXT_TOKENS;
      const safeOutputLimit = Number.isFinite(configuredMaxOutputTokens) && configuredMaxOutputTokens > 0
        ? Math.floor(configuredMaxOutputTokens)
        : 16384;
      const maxOutputTokens = Math.min(safeOutputLimit, Math.max(1, Math.floor(contextLength / 2)));
      const safeInputLimit = Number.isFinite(configuredMaxInputTokens) && configuredMaxInputTokens > 0
        ? Math.floor(configuredMaxInputTokens)
        : FALLBACK_CONTEXT_TOKENS;
      const maxInputTokens = Math.max(1, Math.min(safeInputLimit, contextLength - maxOutputTokens));

      this.log(
        `Context budget for ${model.id}: context=${contextLength}, input=${maxInputTokens}, output=${maxOutputTokens}` +
        (typeof model.max_context_length === 'number' && model.max_context_length > 0 ? '' : ' (fallback context)'),
      );

      return {
        id: model.id,
        name: this.getDisplayName(model),
        family: 'lmstudio',
        version: '1.0.0',
        maxInputTokens,
        maxOutputTokens,
        lmstudioModelId: model.id,
        isLoaded: Boolean(model.loaded),
        isUserSelectable: true,
        capabilities: {
          toolCalling: enableToolCalling,
          imageInput: model.capabilities?.vision ?? false,
        },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Chat response
  // ──────────────────────────────────────────────────────────────────────

  async provideLanguageModelChatResponse(
    model: LMStudioModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const modelId = model.lmstudioModelId;
    let requestModel = model;
    this.log(`Chat request for ${modelId} | ${messages.length} messages | ${options.tools?.length ?? 0} tools`);

    const ready = await this.client.ensureModelLoaded(modelId);
    if (!ready) {
      throw new Error(`LM Studio could not load the selected model: ${modelId}`);
    }

    if (!model.isLoaded) {
      await this.refreshModels();
      const refreshedInformation = this.provideLanguageModelChatInformation({ silent: false }, token);
      if (Array.isArray(refreshedInformation)) {
        requestModel = refreshedInformation.find((availableModel) => availableModel.id === modelId) ?? model;
      }
    }

    // Short-circuit: if the last message is a tool result from a "terminal"
    // tool (like image generation), just echo the result — don't send it
    // back through the LLM where it will hallucinate follow-up questions.
    const shortCircuit = this.tryShortCircuitToolResult(messages);
    if (shortCircuit) {
      this.shortCircuitedToolCallIds.add(shortCircuit.callId);
      this.log(`Short-circuit: tool result from "${shortCircuit.toolName}"`);
      this.log(`Short-circuit text: ${shortCircuit.text.slice(0, 500)}`);
      progress.report(new vscode.LanguageModelTextPart(shortCircuit.text));
      return;
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // 1. Convert VS Code messages → OpenAI format
    const openaiMessages = this.convertMessages(messages);

    // Debug: log the converted messages so we can see what's being sent
    this.log(`--- Converted ${openaiMessages.length} messages ---`);
    for (let i = 0; i < openaiMessages.length; i++) {
      const m = openaiMessages[i];
      const contentPreview = typeof m.content === 'string'
        ? m.content.slice(0, 150)
        : m.content === null ? 'null' : String(m.content).slice(0, 150);
      const tcInfo = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(tc => tc.function.name).join(',')}]` : '';
      const tcId = m.tool_call_id ? ` tool_call_id=${m.tool_call_id}` : '';
      this.log(`  [${i}] role=${m.role}${tcId}${tcInfo} content="${contentPreview}"`);
    }

    // 2. Optionally prepend a single, minimal system message.
    //    Controlled by the "injectSystemPrompt" setting so users whose
    //    LM Studio chat templates already include system instructions can
    //    disable it without relying on model-name sniffing.
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const injectSystemPrompt = config.get<boolean>('injectSystemPrompt', true);
    const hasLeadingSystem = openaiMessages[0]?.role === 'system';
    if (injectSystemPrompt && !hasLeadingSystem) {
      // The model's jinja template merges messages[0] (if system) with
      // the <tools> block, so this is the only system message we should add.
      // We do NOT list tools here — the template does that.
      openaiMessages.unshift({
        role: 'system',
        content: [
          'You are a helpful AI coding assistant embedded in Visual Studio Code.',
          'Respond concisely and directly. Answer in the same language the user writes in.',
          'Do not introduce yourself. Do not restate your identity or capabilities unless the user explicitly asks.',
          'Do not include <think> or </think> tags in your output.',
        ].join('\n'),
      });
    } else {
      this.log(`Skipping system prompt (inject=${injectSystemPrompt}, leadingSystem=${hasLeadingSystem})`);
    }

    // 3. Convert tools → OpenAI format (with budget limit)
    const tools = await this.convertTools(options.tools, messages, openaiMessages, requestModel);

    // 4. Set up cancellation
    token.onCancellationRequested(() => this.client.cancelRequest(requestId));

    // 5. Reset per-request dedup
    this.requestDedupSet.clear();

    // 6. Stream the response
    const requestedOutputTokens = options.modelOptions?.maxOutputTokens;
    const maxTokens = typeof requestedOutputTokens === 'number'
      && Number.isFinite(requestedOutputTokens)
      && requestedOutputTokens > 0
      ? Math.min(Math.floor(requestedOutputTokens), requestModel.maxOutputTokens)
      : requestModel.maxOutputTokens;
    const stream = this.client.streamChatCompletionWithTools(
      modelId,
      openaiMessages,
      {
        temperature: options.modelOptions?.temperature as number | undefined,
        maxTokens,
        tools,
      },
      requestId
    );

    try {
      for await (const part of stream) {
        if (token.isCancellationRequested) break;

        if ('usage' in part && LMStudioProvider.supportsUsageReporting()) {
          // Report token usage to VS Code so the session context-usage widget
          // (and auto-compaction) can account for this turn. The BYOK bridge
          // decodes a data part with mimeType "usage" as JSON containing
          // prompt_tokens / completion_tokens.
          const usagePayload: Record<string, unknown> = {
            prompt_tokens: part.usage.prompt_tokens,
            completion_tokens: part.usage.completion_tokens,
          };
          progress.report(vscode.LanguageModelDataPart.json(usagePayload, 'usage'));
        } else if ('text' in part) {
          progress.report(new vscode.LanguageModelTextPart(part.text));
        } else if ('toolCall' in part) {
          const tc = part.toolCall;

          // Validate required fields — skip if incomplete
          if (!tc.id || !tc.function?.name) {
            this.log(`Skipping incomplete tool call: id=${tc.id} name=${tc.function?.name}`);
            continue;
          }

          const dedupKey = `${tc.function.name}:${tc.function.arguments}`;
          if (this.requestDedupSet.has(dedupKey)) {
            this.log(`Duplicate tool call blocked (same response): ${tc.function.name}`);
            continue;
          }
          this.requestDedupSet.add(dedupKey);

          // Safely parse arguments — default to {} on failure
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            this.warn(`Tool call "${tc.function.name}" has invalid JSON args: ${tc.function.arguments}`);
            parsedArgs = {};
          }

          this.log(`Tool call: ${tc.function.name} (id=${tc.id}) args=${JSON.stringify(parsedArgs).slice(0, 200)}`);
          progress.report(new vscode.LanguageModelToolCallPart(
            tc.id,
            tc.function.name,
            parsedArgs
          ));
        }
      }
    } catch (error) {
      this.error(`Streaming error: ${error}`);
      if (!token.isCancellationRequested) throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Short-circuit for tool results that don't need LLM processing
  // ──────────────────────────────────────────────────────────────────────

  /** Tools whose results should be echoed directly, not sent back to the LLM. */
  private static readonly SHORT_CIRCUIT_TOOLS = new Set([
    'lmstudio_generate_image',
  ]);

  /**
   * If the last message(s) contain tool results from a short-circuit tool,
   * return the result text so we can skip the LLM call entirely.
   */
  private tryShortCircuitToolResult(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): { toolName: string; text: string; callId: string } | null {
    const lastMessage = messages.at(-1);
    if (!lastMessage) {
      return null;
    }

    const parts = Array.isArray(lastMessage.content) ? lastMessage.content : [];
    const toolResults = parts.filter((p): p is { callId: string; content: unknown } => this.isToolResultPartLike(p));

    if (toolResults.length === 0) {
      return null;
    }

    for (const result of toolResults) {
      const toolName = this.resolveToolName(messages, result.callId);
      if (toolName && LMStudioProvider.SHORT_CIRCUIT_TOOLS.has(toolName)) {
        if (this.shortCircuitedToolCallIds.has(result.callId)) {
          this.log(`Skipping stale short-circuit for callId=${result.callId} tool=${toolName}`);
          continue;
        }

        const text = this.extractToolResultText(result.content);
        return { toolName, text: text || 'Done.', callId: result.callId };
      }
    }

    return null;
  }

  /** Walk backwards through messages to find which tool name a callId belongs to. */
  private resolveToolName(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    callId: string
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = Array.isArray(messages[i].content) ? messages[i].content : [];
      for (const p of parts) {
        if (this.isToolCallPartLike(p) && p.callId === callId) {
          return p.name;
        }
      }
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Token counting
  // ──────────────────────────────────────────────────────────────────────

  async provideTokenCount(
    _model: LMStudioModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.ceil(text.length / 4);
    }
    
    const converted = this.convertToChatMessageContent(text.content);
    let length = 0;
    if (typeof converted === 'string') {
      length = converted.length;
    } else if (Array.isArray(converted)) {
      for (const part of converted) {
        if (part.type === 'text') {
          length += part.text.length;
        } else if (part.type === 'image_url') {
          // Heuristic: images take significant context, often ~1000 tokens or more.
          // Since we don't have the exact model's tokenisation for images, we use a constant.
          length += 4000; 
        }
      }
    }
    return Math.ceil(length / 4);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Message conversion: VS Code → OpenAI format
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Convert VS Code messages to OpenAI chat format.
   *
   * VS Code sends the FULL conversation history every time. The messages can
   * contain a mix of content part types:
   *   - LanguageModelTextPart → plain text
   *   - LanguageModelToolCallPart → an assistant's tool call request
   *   - LanguageModelToolResultPart → the result of a tool execution
   *   - LanguageModelDataPart → an image or other binary data (for vision models)
   *
   * We flat-map because one VS Code message may expand into multiple OpenAI
   * messages (e.g. a user message with tool results → one "tool" message per result).
   */
  private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const parts = Array.isArray(msg.content) ? msg.content : [];

      // ── Tool result parts → role: "tool" ─────────────────────────────
      const toolResultParts = parts.filter((p): p is { callId: string; content: unknown } => this.isToolResultPartLike(p));
      if (toolResultParts.length > 0) {
        for (const part of toolResultParts) {
          result.push({
            role: 'tool',
            content: this.extractToolResultText(part.content),
            tool_call_id: part.callId,
          });
        }
        // Include any accompanying content (text/images) as a separate user message
        const userContent = this.convertToChatMessageContent(msg.content);
        if (!this.isContentEmpty(userContent)) {
          result.push({ role: 'user', content: userContent });
        }
        continue;
      }

      // ── Assistant with tool call parts ───────────────────────────────
      if (this.isAssistantRole(msg.role)) {
        const toolCallParts = parts.filter((p): p is { callId: string; name: string; input: unknown } => this.isToolCallPartLike(p));
        if (toolCallParts.length > 0) {
          const text = parts
            .filter((p): p is { value: string } => this.isTextPartLike(p))
            .map(p => p.value)
            .join('');

          result.push({
            role: 'assistant',
            content: text || null, // OpenAI requires null when tool_calls present
            tool_calls: toolCallParts.map(tc => ({
              id: tc.callId,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
              },
            })),
          });
          continue;
        }
      }

      // ── Plain message (User/Assistant/System) ────────────────────────
      const convertedContent = this.convertToChatMessageContent(msg.content);
      if (!this.isContentEmpty(convertedContent)) {
        result.push({
          role: this.mapRole(msg.role),
          content: convertedContent,
        });
      }
    }

    return result;
  }

  /**
   * Convert VS Code message content parts to OpenAI-compatible content.
   * Handles text and images (vision).
   */
  private convertToChatMessageContent(
    content: string | readonly any[]
  ): string | ChatMessageContentPart[] {
    if (typeof content === 'string') return content;

    const parts: ChatMessageContentPart[] = [];
    for (const part of content) {
      if (this.isTextPartLike(part)) {
        parts.push({ type: 'text', text: part.value });
      } else if (this.isImageDataPartLike(part)) {
        const bytes = this.toBuffer(part.data);
        if (!bytes) {
          continue;
        }

        const base64 = bytes.toString('base64');
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${base64}` }
        });
      }
    }

    // If it's just one text part, return it as a string for better compatibility
    // with models that don't fully support the array-of-parts format for plain text.
    if (parts.length === 1 && parts[0].type === 'text') {
      return parts[0].text;
    }

    return parts;
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

  /**
   * Select the most useful tool schemas that fit the request's remaining
   * estimated input budget. VS Code does not expose a tokenizer for schemas,
   * so the estimate uses serialized schema size at roughly four characters
   * per token and is intentionally conservative.
   */
  private async convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    openaiMessages: ChatMessage[],
    model: LMStudioModelInfo,
  ): Promise<ChatTool[] | undefined> {
    if (!tools?.length) return undefined;

    const config = vscode.workspace.getConfiguration('lmstudio-copilot');
    const configuredMaxTools = config.get<number>('maxTools', 20);
    const inspectedMaxTools = config.inspect<number>('maxTools');
    const settings = {
      default: inspectedMaxTools?.defaultValue,
      user: inspectedMaxTools?.globalValue,
      workspace: inspectedMaxTools?.workspaceValue,
      folder: inspectedMaxTools?.workspaceFolderValue,
      userLanguage: inspectedMaxTools?.globalLanguageValue,
      workspaceLanguage: inspectedMaxTools?.workspaceLanguageValue,
      folderLanguage: inspectedMaxTools?.workspaceFolderLanguageValue,
    };
    const validMaxTools = Number.isFinite(configuredMaxTools) && configuredMaxTools >= 0;
    const maxTools = validMaxTools ? Math.floor(configuredMaxTools) : 20;
    if (!validMaxTools) {
      this.warn(`Invalid maxTools value ${configuredMaxTools}; using default count limit 20`);
    }
    this.log(`maxTools configuration=${JSON.stringify(settings)}; configured=${configuredMaxTools}; effective=${maxTools}; count limit=${maxTools === 0 ? 'unlimited' : maxTools}`);

    const usedToolNames = new Set<string>();
    for (const message of messages) {
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
          usedToolNames.add(part.name);
        }
      }
    }

    const queryText = messages
      .filter((message) => this.isUserRole(message.role))
      .slice(-2)
      .map((message) => this.extractMessageContent(message))
      .join(' ')
      .toLowerCase();
    const queryTerms = new Set(queryText.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
    const candidates: Array<{ name: string; tool: ChatTool; cost: number; score: number; required: boolean }> = [];
    let invalidCount = 0;

    for (const tool of tools) {
      try {
        const chatTool: ChatTool = {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: normalizeToolParameters(tool.inputSchema),
          },
        };
        const descriptionTerms = new Set(
          `${tool.name} ${tool.description}`.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [],
        );
        let relevance = 0;
        for (const term of queryTerms) {
          if (descriptionTerms.has(term)) relevance += 1;
        }
        const cost = Math.ceil(JSON.stringify(chatTool).length / 4) + 8;
        candidates.push({
          name: tool.name,
          tool: chatTool,
          cost,
          score: relevance,
          required: usedToolNames.has(tool.name),
        });
      } catch (error) {
        invalidCount += 1;
        const source = this.getToolSource(tool);
        this.warn(
          `Excluding tool with incompatible schema from MCP server "${source.server}", tool "${source.tool}": ${error}`,
        );
      }
    }

    const promptTokens = this.estimateChatMessagesTokens(openaiMessages);
    const availableSchemaTokens = Math.max(0, model.maxInputTokens - promptTokens);
    const required = candidates.filter((candidate) => candidate.required);
    const optional = candidates
      .filter((candidate) => !candidate.required)
      .sort((left, right) => {
        const leftEfficiency = left.score / left.cost;
        const rightEfficiency = right.score / right.cost;
        return rightEfficiency - leftEfficiency || right.score - left.score || left.name.localeCompare(right.name);
      });

    const selected: typeof candidates = [];
    let usedSchemaTokens = 0;
    const addCandidate = (candidate: (typeof candidates)[number], enforceCount: boolean): void => {
      if (enforceCount && maxTools > 0 && selected.length >= maxTools) return;
      if (usedSchemaTokens + candidate.cost > availableSchemaTokens) return;
      selected.push(candidate);
      usedSchemaTokens += candidate.cost;
    };
    for (const candidate of required) {
      addCandidate(candidate, false);
    }
    for (const candidate of optional) {
      addCandidate(candidate, true);
    }

    const excluded = tools.length - selected.length;
    this.log(
      `Tool budget: available=${tools.length}, selected=${selected.length}, excluded=${excluded}, ` +
      `invalid=${invalidCount}, prompt≈${promptTokens} tokens, schemas≈${usedSchemaTokens}/${availableSchemaTokens} tokens`,
    );
    if (required.some((candidate) => !selected.includes(candidate))) {
      this.warn('One or more previously used tools could not fit in the remaining input-token budget');
    }
    if (promptTokens > model.maxInputTokens) {
      this.warn(`Estimated prompt (${promptTokens} tokens) exceeds the model input budget (${model.maxInputTokens} tokens)`);
    }

    return selected.map((candidate) => candidate.tool);
  }

  private getToolSource(tool: vscode.LanguageModelChatTool): { server: string; tool: string } {
    const metadata = tool as vscode.LanguageModelChatTool & {
      serverName?: unknown;
      mcpServerName?: unknown;
      server?: unknown;
    };
    const serverName = typeof metadata.serverName === 'string'
      ? metadata.serverName
      : typeof metadata.mcpServerName === 'string'
        ? metadata.mcpServerName
        : typeof metadata.server === 'string'
          ? metadata.server
          : typeof metadata.server === 'object' && metadata.server !== null && 'name' in metadata.server
            && typeof metadata.server.name === 'string'
            ? metadata.server.name
            : 'not exposed by VS Code';
    return { server: serverName, tool: tool.name };
  }

  private estimateChatMessagesTokens(messages: ChatMessage[]): number {
    let tokens = 0;
    for (const message of messages) {
      let characters = 0;
      let imageTokens = 0;
      if (typeof message.content === 'string') {
        characters += message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text') {
            characters += part.text.length;
          } else {
            imageTokens += 4000;
          }
        }
      }
      if (message.tool_calls) {
        characters += JSON.stringify(message.tool_calls).length;
      }
      tokens += Math.ceil(characters / 4) + imageTokens + 4;
    }
    return tokens;
  }

  private mapRole(role: vscode.LanguageModelChatMessageRole | string): 'system' | 'user' | 'assistant' {
    if (this.isAssistantRole(role)) {
      return 'assistant';
    }

    if (this.isUserRole(role)) {
      return 'user';
    }

    return 'user';
  }

  private extractMessageContent(msg: vscode.LanguageModelChatRequestMessage): string {
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((p): p is { value: string } => this.isTextPartLike(p))
        .map(p => p.value)
        .join('');
    }
    return String(content);
  }

  private extractToolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(c => {
        if (this.isTextPartLike(c)) return c.value;
        if (typeof c === 'object' && c !== null && 'value' in c) return String((c as { value: unknown }).value);
        return typeof c === 'string' ? c : JSON.stringify(c);
      }).join('');
    }
    return String(content);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  private formatModelName(modelId: string): string {
    return modelId
      .replace(/^(models\/|\/)/g, '')
      .replace(/[-_]/g, ' ')
      .replace(/\.gguf$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  private getDisplayName(model: LMStudioModel): string {
    return model.display_name?.trim() || this.formatModelName(model.id);
  }

  getAvailableModels(): LMStudioModel[] {
    return [...this.availableModels];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
