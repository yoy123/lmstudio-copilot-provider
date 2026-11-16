const assert = require('node:assert/strict');
const { beforeEach, afterEach, test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const manifest = require('../package.json');

// Bundle the real TypeScript in memory; only the VS Code host is mocked.
// Nothing reads user settings, calls a CLI, loads a model, or contacts a server.
const defaults = Object.fromEntries(manifest.contributes.configuration.flatMap(section =>
  Object.entries(section.properties).map(([key, value]) => [key.split('.').pop(), value.default])
));
let settings;
let configuredScopes;
const logs = [];
const vscode = {
  version: '1.143.1',
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => settings[key] ?? fallback,
      inspect: key => ({
        defaultValue: defaults[key],
        globalValue: configuredScopes.global[key],
        workspaceValue: configuredScopes.workspace[key],
        workspaceFolderValue: configuredScopes.folder[key],
        globalLanguageValue: undefined,
        workspaceLanguageValue: undefined,
        workspaceFolderLanguageValue: undefined,
      }),
    }),
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  LanguageModelToolCallPart: class {
    constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
  },
  LanguageModelToolResultPart: class {},
  LanguageModelDataPart: class {
    static json(value, mimeType) {
      return Object.assign(new this(), { data: Buffer.from(JSON.stringify(value)), mimeType });
    }
  },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
};

function loadSource(filename) {
  const entry = path.resolve(__dirname, '../src', filename);
  const bundle = buildSync({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    external: ['vscode'], write: false, logLevel: 'silent',
  }).outputFiles[0].text;
  const module = { exports: {} };
  const realRequire = createRequire(entry);
  const execute = vm.runInThisContext(`(function(require, module, exports) {${bundle}\n})`, { filename: entry });
  execute(id => id === 'vscode' ? vscode : realRequire(id), module, module.exports);
  return module.exports;
}

const { LMStudioClient } = loadSource('lmstudio-client.ts');
const { LMStudioProvider } = loadSource('lmstudio-provider.ts');
const logger = {
  verbose(message) { logs.push(['verbose', message]); },
  warn(message) { logs.push(['warning', message]); },
  error(message) { logs.push(['error', message]); },
};
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const originalFetch = global.fetch;

beforeEach(() => {
  settings = { ...defaults };
  configuredScopes = { global: {}, workspace: {}, folder: {} };
  logs.length = 0;
  vscode.version = '1.143.1';
});
afterEach(() => { global.fetch = originalFetch; });

async function startedServerArgs(serverUrl) {
  settings.serverUrl = serverUrl;
  const client = new LMStudioClient(logger);
  let startedArgs;
  client.checkConnection = async () => false;
  client.resolveCliPath = async () => 'lms';
  client.execLms = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  client.execLmsJson = async () => ({ running: false });
  client.spawnDetachedLms = async args => { startedArgs = args; return true; };
  client.waitForConnection = async () => true;
  assert.equal(await client.ensureServerRunning(), true);
  return startedArgs;
}

test('server startup leaves the port unspecified when the server URL omits it', async () => {
  assert.deepEqual(await startedServerArgs('http://localhost'), ['server', 'start']);
});

test('server startup uses an explicitly configured URL port', async () => {
  assert.deepEqual(await startedServerArgs('http://localhost:5678'), ['server', 'start', '--port', '5678']);
});

function model(max_context_length, id = 'test-model') {
  return { id, object: 'model', owned_by: 'test', loaded: true, max_context_length };
}

async function providerFor(installed, live = []) {
  const provider = new LMStudioProvider({
    getInstalledModels: async () => installed,
    getModels: async () => live,
  }, {}, logger);
  await provider.refreshModels();
  return provider;
}

function sse(events, splitAt = 0) {
  const bytes = Buffer.from(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
  return new ReadableStream({ start(controller) {
    if (splitAt) {
      for (let i = 0; i < bytes.length; i += splitAt) controller.enqueue(bytes.subarray(i, i + splitAt));
    } else controller.enqueue(bytes);
    controller.close();
  } });
}

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

test('model context sizes are not all clamped to 128K', async () => {
  const provider = await providerFor([model(1048576, 'large'), model(262144, 'medium'), model(8192, 'small')]);
  const info = provider.provideLanguageModelChatInformation({}, token);
  assert.deepEqual(Object.fromEntries(info.map(m => [m.id, m.maxInputTokens])), {
    large: 1032192, medium: 245760, small: 4096,
  });
  assert.deepEqual(Object.fromEntries(info.map(m => [m.id, m.maxOutputTokens])), {
    large: 16384, medium: 16384, small: 4096,
  });
});

test('explicit smaller input cap is respected', async () => {
  settings.maxInputTokens = 65536;
  const provider = await providerFor([model(1048576)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 65536);
});

test('missing, zero, negative and NaN model limits use the 32K fallback', async () => {
  for (const limit of [undefined, 0, -1, NaN]) {
    const provider = await providerFor([model(limit)]);
    assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 16384);
  }
});

test('unknown limits also respect a smaller user cap', async () => {
  settings.maxInputTokens = 8192;
  const provider = await providerFor([model(undefined)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 8192);
});

test('live metadata does not erase a known installed context limit', async () => {
  const provider = await providerFor([model(262144)], [model(undefined)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 245760);
});

test('a smaller live context takes precedence over installed metadata', async () => {
  const provider = await providerFor([model(1048576)], [model(16384)]);
  const info = provider.provideLanguageModelChatInformation({}, token)[0];
  assert.equal(info.maxInputTokens, 8192);
  assert.equal(info.maxOutputTokens, 8192);
});

test('model switching recalculates both input and output limits', async () => {
  const provider = await providerFor([model(1048576, 'large'), model(8192, 'small')]);
  const info = Object.fromEntries(provider.provideLanguageModelChatInformation({}, token).map(item => [item.id, item]));
  assert.equal(info.large.maxInputTokens, 1032192);
  assert.equal(info.small.maxInputTokens, 4096);
  assert.equal(info.small.maxOutputTokens, 4096);
});

test('API discovery uses the smallest valid loaded-instance context', async () => {
  global.fetch = async () => Response.json({ models: [{
    key: 'test-model', max_context_length: 1048576,
    loaded_instances: [{ config: { context_length: 65536 } }, { context_length: 16384 }, { context_length: 0 }],
  }] });
  const models = await new LMStudioClient(logger).getModels();
  assert.equal(models[0].max_context_length, 16384);
});

test('model discovery falls back to OpenAI endpoints and local readiness skips the LM Studio CLI', async () => {
  settings.serverUrl = 'http://127.0.0.1:8080/';
  settings.apiKey = 'test-key';
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push([url, init.headers.Authorization]);
    if (!url.endsWith('/v1/models') || url.includes('/api/')) return new Response('', { status: 404 });
    return Response.json({ data: [model(8192)] });
  };
  const client = new LMStudioClient(logger);
  client.execLms = async () => { throw new Error('LM Studio CLI must not be used'); };
  assert.equal((await client.getModels())[0].id, 'test-model');
  assert.equal(await client.checkConnection(), true);
  assert.equal(await client.ensureModelLoaded('test-model'), true);
  assert.deepEqual(requests.slice(0, 3).map(([url]) => url), [
    'http://127.0.0.1:8080/api/v1/models',
    'http://127.0.0.1:8080/api/v0/models',
    'http://127.0.0.1:8080/v1/models',
  ]);
  assert.ok(requests.every(([, authorization]) => authorization === ['Bearer', settings.apiKey].join(' ')));
});

test('discovery rejects invalid responses and accepts empty legacy model lists', async () => {
  const paths = [];
  global.fetch = async url => {
    paths.push(new URL(url).pathname);
    if (paths.length === 1) return Response.json({ error: 'not a model list' });
    return Response.json({ data: [] });
  };
  const client = new LMStudioClient(logger);
  assert.deepEqual(await client.getModels(), []);
  assert.deepEqual(paths, ['/api/v1/models', '/api/v0/models']);
});

test('discovery reports failure after all endpoints fail', async () => {
  const paths = [];
  global.fetch = async url => {
    paths.push(new URL(url).pathname);
    if (paths.length === 1) throw new TypeError('fetch failed');
    return new Response('', { status: 404 });
  };
  const client = new LMStudioClient(logger);
  assert.equal(await client.checkConnection(), false);
  assert.deepEqual(paths, ['/api/v1/models', '/api/v0/models', '/v1/models']);
});

test('native local servers retain CLI model loading', async () => {
  global.fetch = async () => Response.json({ models: [{ key: 'test-model' }] });
  const client = new LMStudioClient(logger);
  let loaded = false;
  client.getLoadedModelIds = async () => new Set();
  client.execLms = async args => { loaded = args[0] === 'load'; return { exitCode: 0 }; };
  assert.equal(await client.ensureModelLoaded('test-model'), true);
  assert.equal(loaded, true);
});

test('empty-choice usage survives byte-split SSE and is emitted once', async () => {
  const client = new LMStudioClient(logger);
  const usage = { prompt_tokens: 321, completion_tokens: 12 };
  const parts = await collect(client.processSSEStream(sse([
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [], usage }, '[DONE]',
  ], 1)));
  assert.deepEqual(parts, [{ text: 'Hello' }, { usage }]);
});

test('streams without usage keep working without fabricated counts', async () => {
  const client = new LMStudioClient(logger);
  assert.deepEqual(await collect(client.processSSEStream(sse([
    { choices: [{ delta: { content: 'Hello' } }] }, '[DONE]',
  ]))), [{ text: 'Hello' }]);
});

test('malformed usage does not overwrite the last valid usage', async () => {
  const usage = { prompt_tokens: 5, completion_tokens: 0 };
  const parts = await collect(new LMStudioClient(logger).processSSEStream(sse([
    { choices: [], usage },
    { choices: [], usage: { prompt_tokens: 'invalid', completion_tokens: 2 } }, '[DONE]',
  ])));
  assert.deepEqual(parts, [{ usage }]);
});

test('tool calls and final usage both survive streaming', async () => {
  const usage = { prompt_tokens: 30, completion_tokens: 8 };
  const parts = await collect(new LMStudioClient(logger).processSSEStream(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [], usage }, '[DONE]',
  ])));
  assert.equal(parts[0].toolCall.function.arguments, '{"path":"README.md"}');
  assert.equal(parts.filter(p => p.toolCall).length, 1);
  assert.deepEqual(parts.at(-1), { usage });
});

test('chat requests opt into streaming usage', async () => {
  let request;
  global.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return new Response(sse(['[DONE]']));
  };
  await collect(new LMStudioClient(logger).streamChatCompletionWithTools('test-model', [{ role: 'user', content: 'Hello' }]));
  assert.deepEqual(request.stream_options, { include_usage: true });
});

test('chat requests refresh context limits after lazy-loading an unloaded model', async () => {
  let sentOptions;
  const provider = new LMStudioProvider({
    ensureModelLoaded: async () => true,
    getInstalledModels: async () => [model(32768)],
    getModels: async () => [model(32768)],
    async *streamChatCompletionWithTools(_modelId, _messages, options) {
      sentOptions = options;
      yield { text: 'Ready' };
    },
  }, {}, logger);
  const parts = [];

  await provider.provideLanguageModelChatResponse({
    ...model(8192),
    lmstudioModelId: 'test-model',
    maxInputTokens: 4096,
    maxOutputTokens: 4096,
    isLoaded: false,
    isUserSelectable: true,
    name: 'test-model',
    family: 'lmstudio',
    version: '1.0.0',
    capabilities: { toolCalling: true },
  }, [], { modelOptions: { maxOutputTokens: 20000 } }, { report: part => parts.push(part) }, token);

  assert.equal(sentOptions.maxTokens, 16384);
  assert.equal(parts[0].value, 'Ready');
});

function makeTool(name, description = name, inputSchema = { type: 'object', properties: {} }) {
  return { name, description, inputSchema };
}

async function convertedTools(tools, { maxInputTokens = 10000, maxTools = 20, messages = [], openaiMessages = [] } = {}) {
  settings.maxTools = maxTools;
  const provider = new LMStudioProvider({}, {}, logger);
  return provider.convertTools(tools, messages, openaiMessages, { maxInputTokens });
}

test('zero removes the tool-count cap while the token budget still limits large collections', async () => {
  const tools = Array.from({ length: 96 }, (_, index) =>
    makeTool(`mcp_tool_${index}`, `tool description ${index}`));
  const selected = await convertedTools(tools, { maxInputTokens: 10000, maxTools: 0 });
  assert.ok(selected.length > 32);
  assert.ok(selected.length <= tools.length);
  assert.ok(logs.some(([, message]) => message.includes('count limit=unlimited')));

  logs.length = 0;
  const smallContext = await convertedTools(tools, { maxInputTokens: 300, maxTools: 0 });
  assert.ok(smallContext.length < tools.length);
  assert.ok(logs.some(([, message]) => message.includes('available=96') && message.includes('excluded=')));
});

test('positive maxTools limits ordinary tools but keeps a tool used in the conversation', async () => {
  const usedCall = new vscode.LanguageModelToolCallPart('call-1', 'required_tool', {});
  const messages = [{ role: 2, content: [usedCall] }];
  const tools = [
    makeTool('required_tool'),
    makeTool('other_tool'),
    makeTool('third_tool'),
  ];
  const selected = await convertedTools(tools, { maxInputTokens: 10000, maxTools: 1, messages });
  assert.deepEqual(selected.map(item => item.function.name), ['required_tool']);
});

test('tool selection favors current user-task relevance within the schema budget', async () => {
  const tools = [
    makeTool('weather_lookup', 'fetch current weather forecast'),
    makeTool('file_reader', 'read a file from the workspace'),
  ];
  const messages = [{ role: 1, content: [new vscode.LanguageModelTextPart('Please inspect the workspace file')] }];
  const selected = await convertedTools(tools, { maxInputTokens: 10000, maxTools: 1, messages });
  assert.deepEqual(selected.map(item => item.function.name), ['file_reader']);
});

test('incompatible MCP schemas are excluded and diagnostics identify available server metadata', async () => {
  const brokenTool = Object.assign(makeTool('broken_tool', 'broken', {
    type: 'object',
    properties: { value: { $ref: '#/$defs/missing' } },
  }), { serverName: 'mcp-server-a' });
  const selected = await convertedTools([brokenTool], { maxInputTokens: 10000 });
  assert.deepEqual(selected, []);
  assert.ok(logs.some(([, message]) =>
    message.includes('MCP server "mcp-server-a"') && message.includes('tool "broken_tool"')));
});

test('workspace maxTools overrides are reported without changing the configured value', async () => {
  configuredScopes.global.maxTools = 32;
  configuredScopes.workspace.maxTools = 0;
  settings.maxTools = 0;
  await convertedTools([makeTool('one')], { maxInputTokens: 10000, maxTools: 0 });
  assert.ok(logs.some(([, message]) =>
    message.includes('"user":32') && message.includes('"workspace":0') && message.includes('effective=0')));
});

for (const [version, supported] of [['1.104.0', false], ['1.139.9', false], ['1.140.0', true], ['1.143.1', true], ['1.144.0-insider', true], ['2.0.0', true]]) {
  test(`usage data is ${supported ? 'reported' : 'suppressed'} on VS Code ${version}`, async () => {
    vscode.version = version;
    const usage = { prompt_tokens: 99, completion_tokens: 7 };
    const provider = new LMStudioProvider({
      ensureModelLoaded: async () => true,
      async *streamChatCompletionWithTools() { yield { text: 'OK' }; yield { usage }; },
    }, {}, logger);
    const parts = [];
    await provider.provideLanguageModelChatResponse({ lmstudioModelId: 'test-model', isLoaded: true }, [], {}, { report: p => parts.push(p) }, token);
    assert.equal(parts[0].value, 'OK');
    assert.equal(parts.length, supported ? 2 : 1);
    if (supported) {
      assert.equal(parts[1].mimeType, 'usage');
      assert.deepEqual(JSON.parse(Buffer.from(parts[1].data).toString()), usage);
    }
  });
}