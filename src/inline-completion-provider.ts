import * as vscode from 'vscode';
import { LMStudioClient } from './lmstudio-client';
import { Logger } from './logger';
import { LMStudioModel } from './types';

interface InlineCompletionConfig {
  enabled: boolean;
  modelId: string;
  minPrefixChars: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  maxTokens: number;
  maxChars: number;
  timeoutMs: number;
  temperature: number;
}

interface CachedModelId {
  value: string | null;
  expiresAt: number;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

export class LMStudioInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private static readonly MODEL_CACHE_TTL_MS = 15000;
  private static readonly MODEL_READY_TTL_MS = 15000;
  private static readonly WARN_THROTTLE_MS = 10000;

  private cachedModelId: CachedModelId = { value: null, expiresAt: 0 };
  private modelReadyUntil = new Map<string, number>();
  private lastWarnLogAt = 0;

  constructor(
    private readonly client: LMStudioClient,
    private readonly logger: Logger,
  ) {}

  private log(message: string): void {
    this.logger.verbose(`[Inline] ${message}`);
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnLogAt >= LMStudioInlineCompletionProvider.WARN_THROTTLE_MS) {
      this.lastWarnLogAt = now;
      this.logger.warn(`[Inline] ${message}`);
      return;
    }

    this.log(`(suppressed warn) ${message}`);
  }

  private readConfig(): InlineCompletionConfig {
    const config = vscode.workspace.getConfiguration('lmstudio-copilot');

    return {
      enabled: config.get<boolean>('enableInlineCompletions', false),
      modelId: config.get<string>('inlineCompletionModel', '').trim(),
      minPrefixChars: Math.floor(clamp(config.get<number>('inlineCompletionMinPrefixChars', 3), 0, 256, 3)),
      maxPrefixChars: Math.floor(clamp(config.get<number>('inlineCompletionMaxPrefixChars', 6000), 256, 30000, 6000)),
      maxSuffixChars: Math.floor(clamp(config.get<number>('inlineCompletionMaxSuffixChars', 1200), 0, 10000, 1200)),
      maxTokens: Math.floor(clamp(config.get<number>('inlineCompletionMaxTokens', 96), 1, 1024, 96)),
      maxChars: Math.floor(clamp(config.get<number>('inlineCompletionMaxChars', 512), 16, 4096, 512)),
      timeoutMs: Math.floor(clamp(config.get<number>('inlineCompletionTimeoutMs', 8000), 1000, 30000, 8000)),
      temperature: clamp(config.get<number>('inlineCompletionTemperature', 0.2), 0, 2, 0.2),
    };
  }

  private shouldTrigger(linePrefix: string, context: vscode.InlineCompletionContext): boolean {
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
      return true;
    }

    if (!linePrefix || linePrefix.trim().length === 0) {
      return false;
    }

    const lastChar = linePrefix[linePrefix.length - 1];
    return /[\w\]\)\}"'`.:>$]/.test(lastChar);
  }

  private pickCandidateModelId(models: LMStudioModel[]): string | null {
    const llm = models.find((model) => model.type !== 'embedding');
    return llm?.id ?? null;
  }

  private async resolveModelId(configuredModelId: string): Promise<string | null> {
    if (configuredModelId) {
      return configuredModelId;
    }

    if (this.cachedModelId.expiresAt > Date.now()) {
      return this.cachedModelId.value;
    }

    const [liveModels, installedModels] = await Promise.all([
      this.client.getModels(),
      this.client.getInstalledModels(),
    ]);

    const modelId = this.pickCandidateModelId(liveModels)
      ?? this.pickCandidateModelId(installedModels)
      ?? null;

    this.cachedModelId = {
      value: modelId,
      expiresAt: Date.now() + LMStudioInlineCompletionProvider.MODEL_CACHE_TTL_MS,
    };

    if (!modelId) {
      this.warn('No LM Studio model available for inline completions. Set lmstudio-copilot.inlineCompletionModel or load a model first.');
    }

    return modelId;
  }

  private async ensureModelReady(modelId: string): Promise<boolean> {
    const readyUntil = this.modelReadyUntil.get(modelId) ?? 0;
    if (readyUntil > Date.now()) {
      return true;
    }

    const ready = this.client.isLocalServerUrl()
      ? await this.client.ensureModelLoaded(modelId)
      : await this.client.checkConnection();

    if (ready) {
      this.modelReadyUntil.set(modelId, Date.now() + LMStudioInlineCompletionProvider.MODEL_READY_TTL_MS);
      return true;
    }

    this.warn(`Inline completion model is not ready: ${modelId}`);
    return false;
  }

  private trimSuffixOverlap(completion: string, suffix: string): string {
    const maxOverlap = Math.min(completion.length, suffix.length, 512);
    for (let overlap = maxOverlap; overlap > 0; overlap--) {
      if (completion.endsWith(suffix.slice(0, overlap))) {
        return completion.slice(0, -overlap);
      }
    }

    return completion;
  }

  private postProcessCompletion(rawCompletion: string, suffix: string, maxChars: number): string {
    let completion = rawCompletion
      .replace(/\r\n/g, '\n')
      .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .replace(/<\|(startofstream|endofstream|im_start|im_end|endoftext|end_of_turn|eot_id)\|>/g, '')
      .replace(/<\/?(think|thinking|reasoning|reflection)>/gi, '')
      .replace(/^here(?:'s| is)(?: the)?(?: inline)?(?: completion)?:\s*/i, '')
      .replace(/\u0000/g, '');

    completion = this.trimSuffixOverlap(completion, suffix);

    if (completion.length > maxChars) {
      completion = completion.slice(0, maxChars);
    }

    return completion;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | undefined> {
    const cfg = this.readConfig();
    if (!cfg.enabled || token.isCancellationRequested) {
      return undefined;
    }

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (!this.shouldTrigger(linePrefix, context)) {
      return undefined;
    }

    const fullText = document.getText();
    const cursorOffset = document.offsetAt(position);
    const prefixStartOffset = Math.max(0, cursorOffset - cfg.maxPrefixChars);
    const suffixEndOffset = Math.min(fullText.length, cursorOffset + cfg.maxSuffixChars);

    const prefix = fullText.slice(prefixStartOffset, cursorOffset);
    if (prefix.length < cfg.minPrefixChars) {
      return undefined;
    }

    const suffix = fullText.slice(cursorOffset, suffixEndOffset);

    const modelId = await this.resolveModelId(cfg.modelId);
    if (!modelId || token.isCancellationRequested) {
      return undefined;
    }

    const ready = await this.ensureModelReady(modelId);
    if (!ready || token.isCancellationRequested) {
      return undefined;
    }

    const completion = await this.client.getInlineCompletion(
      modelId,
      prefix,
      suffix,
      {
        languageId: document.languageId,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        timeoutMs: cfg.timeoutMs,
      },
      token,
    );

    if (!completion || token.isCancellationRequested) {
      return undefined;
    }

    const insertText = this.postProcessCompletion(completion, suffix, cfg.maxChars);
    if (!insertText.trim()) {
      return undefined;
    }

    this.log(`Inline completion generated (${insertText.length} chars) for ${document.languageId}`);
    return [new vscode.InlineCompletionItem(insertText, new vscode.Range(position, position))];
  }
}