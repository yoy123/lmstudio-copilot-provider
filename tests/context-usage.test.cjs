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
const vscode = {
  version: '1.143.1',
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
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
const logger = { verbose() {}, warn() {}, error() {} };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const originalFetch = global.fetch;

beforeEach(() => { settings = { ...defaults }; vscode.version = '1.143.1'; });
afterEach(() => { global.fetch = originalFetch; });

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
    large: 1048576, medium: 262144, small: 8192,
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
    assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 32768);
  }
});

test('unknown limits also respect a smaller user cap', async () => {
  settings.maxInputTokens = 8192;
  const provider = await providerFor([model(undefined)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 8192);
});

test('live metadata does not erase a known installed context limit', async () => {
  const provider = await providerFor([model(262144)], [model(undefined)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 262144);
});

test('a smaller live context takes precedence over installed metadata', async () => {
  const provider = await providerFor([model(1048576)], [model(16384)]);
  assert.equal(provider.provideLanguageModelChatInformation({}, token)[0].maxInputTokens, 16384);
});

test('API discovery uses the smallest valid loaded-instance context', async () => {
  global.fetch = async () => Response.json({ models: [{
    key: 'test-model', max_context_length: 1048576,
    loaded_instances: [{ config: { context_length: 65536 } }, { context_length: 16384 }, { context_length: 0 }],
  }] });
  const models = await new LMStudioClient(logger).getModels();
  assert.equal(models[0].max_context_length, 16384);
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