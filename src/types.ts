import * as vscode from 'vscode';

/**
 * Configuration for connecting to LM Studio
 */
export interface LMStudioConfig {
  serverUrl: string;
  apiKey: string;
  requestTimeout: number;
  treatAsRemote: boolean;
}

/**
 * LM Studio model information from /api/v1/models endpoint
 */
export interface LMStudioModel {
  id: string;
  object: string;
  owned_by: string;
  created?: number;
  loaded?: boolean;
  path?: string;
  format?: string;
  paramsString?: string;
  // Additional fields from LM Studio v1 API
  type?: string;
  publisher?: string;
  display_name?: string;
  architecture?: string;
  max_context_length?: number;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
  };
}

/**
 * Raw model from LM Studio /api/v1/models endpoint (uses 'key' instead of 'id')
 */
export interface LMStudioRawModel {
  key: string;
  type?: string;
  publisher?: string;
  display_name?: string;
  architecture?: string;
  max_context_length?: number;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
  };
  [prop: string]: unknown;
}

/**
 * Model metadata returned by `lms ls --json` / `lms ps --json`
 */
export interface LMStudioLocalModel {
  type?: string;
  modelKey: string;
  format?: string;
  displayName?: string;
  publisher?: string;
  path?: string;
  sizeBytes?: number;
  indexedModelIdentifier?: string;
  deviceIdentifier?: string;
  paramsString?: string;
  architecture?: string;
  vision?: boolean;
  trainedForToolUse?: boolean;
  maxContextLength?: number;
  max_context_length?: number;
  [prop: string]: unknown;
}

/**
 * Response from LM Studio /api/v1/models endpoint
 */
export interface ModelsResponse {
  object?: string;
  data?: LMStudioModel[];
  models?: LMStudioRawModel[];
}

/**
 * Chat message format for OpenAI-compatible API
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // null is required by OpenAI spec when the assistant message only contains tool_calls
  content: string | ChatMessageContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/**
 * Content part for multi-modal messages
 */
export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Tool definition for function calling
 */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Tool call from the model
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Request body for chat completions
 */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  tools?: ChatTool[];
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  /** Qwen3 / thinking models: set false to skip generating a reasoning trace */
  enable_thinking?: boolean;
  /** OpenAI-style reasoning effort hint for models that support it (e.g. o1, o3, QwQ) */
  reasoning_effort?: 'none' |'low' | 'medium' | 'high';
}

/**
 * Streaming chunk from chat completions with tool support
 */
export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }[];
    };
    finish_reason: string | null;
  }[];
}

/**
 * Non-streaming response from chat completions
 */
export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Get LM Studio configuration from VS Code settings
 */
export function getConfig(): LMStudioConfig {
  const config = vscode.workspace.getConfiguration('lmstudio-copilot');
  return {
    serverUrl: config.get<string>('serverUrl', 'http://localhost:1234'),
    apiKey: config.get<string>('apiKey', ''),
    requestTimeout: config.get<number>('requestTimeout', 60000),
    treatAsRemote: config.get<boolean>('treatAsRemote', false),
  };
}
