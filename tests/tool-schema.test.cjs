const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

const compiled = esbuild.buildSync({
  entryPoints: ['src/tool-schema.ts'],
  platform: 'node',
  format: 'cjs',
  bundle: true,
  write: false,
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
const { normalizeToolParameters } = mod.exports;

test('inlines definitions references while preserving constraints and input immutability', () => {
  const original = {
    type: 'object',
    definitions: { KindsFilter: { type: 'string', enum: ['fact', 'preference'] } },
    required: ['kinds'],
    properties: { kinds: { anyOf: [{ $ref: '#/definitions/KindsFilter' }, { type: 'null' }] } },
  };
  const normalized = normalizeToolParameters(original);
  assert.deepEqual(normalized.required, ['kinds']);
  assert.deepEqual(normalized.properties.kinds.anyOf[0], {
    type: 'string',
    enum: ['fact', 'preference'],
  });
  assert.equal(JSON.stringify(normalized).includes('$ref'), false);
  assert.equal(JSON.stringify(normalized).includes('definitions'), false);
  assert.equal(original.properties.kinds.anyOf[0].$ref, '#/definitions/KindsFilter');
});

test('resolves nested $defs references and preserves nested object constraints', () => {
  const normalized = normalizeToolParameters({
    type: 'object',
    $defs: {
      Address: {
        type: 'object',
        required: ['postal'],
        properties: { postal: { type: 'string', minLength: 3 } },
      },
      User: { type: 'object', properties: { address: { $ref: '#/$defs/Address' } } },
    },
    properties: { user: { $ref: '#/$defs/User' } },
  });

  assert.deepEqual(normalized.properties.user.properties.address, {
    type: 'object',
    required: ['postal'],
    properties: { postal: { type: 'string', minLength: 3 } },
  });
  assert.equal(JSON.stringify(normalized).includes('$defs'), false);
});

test('decodes JSON Pointer slash and tilde escapes', () => {
  const normalized = normalizeToolParameters({
    type: 'object',
    $defs: { 'filter/name~kind': { type: 'string', enum: ['fact'] } },
    properties: { kind: { $ref: '#/$defs/filter~1name~0kind' } },
  });
  assert.deepEqual(normalized.properties.kind, { type: 'string', enum: ['fact'] });
});

test('combines sibling constraints with a reference using allOf', () => {
  const normalized = normalizeToolParameters({
    type: 'object',
    definitions: { Name: { type: 'string', minLength: 2 } },
    properties: {
      name: { $ref: '#/definitions/Name', maxLength: 8, description: 'short name' },
    },
  });
  assert.deepEqual(normalized.properties.name, {
    allOf: [
      { type: 'string', minLength: 2 },
      { maxLength: 8, description: 'short name' },
    ],
  });
});

test('rejects unresolved, external, malformed, and circular references', () => {
  const invalidSchemas = [
    { type: 'object', properties: { x: { $ref: '#/$defs/Missing' } } },
    { type: 'object', properties: { x: { $ref: 'https://example.test/schema.json' } } },
    { type: 'object', properties: { x: { $ref: '#/$defs/invalid~2escape' } } },
    {
      type: 'object',
      definitions: { A: { type: 'object', properties: { self: { $ref: '#/definitions/A' } } } },
      properties: { root: { $ref: '#/definitions/A' } },
    },
  ];

  for (const schema of invalidSchemas) {
    assert.throws(() => normalizeToolParameters(schema), /reference|JSON Pointer/);
  }
});

test('supports reusing a non-circular reference in multiple branches', () => {
  const normalized = normalizeToolParameters({
    type: 'object',
    definitions: { Label: { type: 'string', minLength: 1 } },
    properties: {
      first: { $ref: '#/definitions/Label' },
      second: { $ref: '#/definitions/Label' },
    },
  });
  assert.deepEqual(normalized.properties.first, { type: 'string', minLength: 1 });
  assert.deepEqual(normalized.properties.second, { type: 'string', minLength: 1 });
});

test('missing schemas use an empty object schema and malformed roots are rejected', () => {
  assert.deepEqual(normalizeToolParameters(undefined), { type: 'object', properties: {} });
  assert.throws(() => normalizeToolParameters(null), /must be a JSON Schema object/);
});
