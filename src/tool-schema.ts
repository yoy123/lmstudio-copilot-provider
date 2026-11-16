/**
 * Inline local JSON Schema references for LM Studio's tool grammar.
 * Invalid, external, and recursive references are rejected rather than
 * silently weakening the tool's input constraints.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointer(pointer: string): string[] {
  if (pointer === '#') {
    return [];
  }
  if (!pointer.startsWith('#/')) {
    throw new Error(`only local JSON Pointer references are supported: ${pointer}`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pointer.slice(2));
  } catch {
    throw new Error(`invalid URI encoding in JSON Pointer reference: ${pointer}`);
  }

  return decoded.split('/').map((token) => {
    if (/~(?![01])/.test(token)) {
      throw new Error(`invalid JSON Pointer escape in reference: ${pointer}`);
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

export function normalizeToolParameters(input: unknown): Record<string, unknown> {
  if (input === undefined) {
    return { type: 'object', properties: {} };
  }
  if (!isObject(input)) {
    throw new Error('tool input schema must be a JSON Schema object');
  }

  const root = input;

  function resolve(pointer: string): unknown {
    let current: unknown = root;
    for (const token of decodePointer(pointer)) {
      if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
        throw new Error(`unresolved JSON Schema reference: ${pointer}`);
      }
      current = current[token];
    }
    if (!isObject(current)) {
      throw new Error(`JSON Schema reference does not resolve to a schema object: ${pointer}`);
    }
    return current;
  }

  function expand(value: unknown, activeRefs: ReadonlySet<string>, depth: number): unknown {
    if (depth > 64) {
      throw new Error('JSON Schema nesting exceeds the supported depth of 64');
    }
    if (Array.isArray(value)) {
      return value.map((item) => expand(item, activeRefs, depth + 1));
    }
    if (!isObject(value)) {
      return value;
    }

    if (typeof value.$ref === 'string') {
      const pointer = value.$ref;
      if (activeRefs.has(pointer)) {
        throw new Error(`circular JSON Schema reference: ${pointer}`);
      }

      const nextRefs = new Set(activeRefs);
      nextRefs.add(pointer);
      const expandedReference = expand(resolve(pointer), nextRefs, depth + 1);
      const siblings = expand(
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')),
        activeRefs,
        depth + 1,
      );

      if (!isObject(siblings) || Object.keys(siblings).length === 0) {
        return expandedReference;
      }
      if (!isObject(expandedReference)) {
        throw new Error(`reference does not resolve to an object schema: ${pointer}`);
      }

      return { allOf: [expandedReference, siblings] };
    }

    const expanded: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '$defs' || key === 'definitions') {
        continue;
      }
      expanded[key] = expand(item, activeRefs, depth + 1);
    }
    return expanded;
  }

  const normalized = expand(root, new Set(), 0);
  if (!isObject(normalized)) {
    throw new Error('normalized tool input schema is not an object');
  }
  return normalized;
}
