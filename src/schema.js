// Tool input schemas: plain JSON Schema built with a few helpers, plus the small validator the MCP
// server runs on every tools/call. Only what Kraken's tools use: string, number, integer, boolean,
// enum, array, object, with description, default, min/max, maxItems, nullable and required.
//
//   input({ run_id: str({ required: true }), wait_seconds: num({ min: 0, max: 55, default: 0 }) })
import { fail } from './util.js';

// `required` and `nullable` are kept under symbols until input() turns them into JSON Schema.
const REQUIRED = Symbol('required'), NULLABLE = Symbol('nullable');
const node = (type) => ({ required, nullable, min, max, ...rest } = {}) => ({
  type, ...rest,
  ...(min !== undefined && { minimum: min }), ...(max !== undefined && { maximum: max }),
  [REQUIRED]: !!required, [NULLABLE]: !!nullable,
});
export const str = node('string');
export const num = node('number');
export const int = node('integer');
export const bool = node('boolean');
export const oneOf = (values, opts) => ({ ...node('string')(opts), enum: values });
export const list = (items, { maxItems, ...opts } = {}) =>
  ({ ...node('array')(opts), items, ...(maxItems && { maxItems }) });
export const obj = (properties, opts) => ({ ...input(properties), ...node('object')(opts) });

// A properties map -> an object JSON Schema: the flags become JSON Schema's `required` list and
// `type: [t, "null"]`.
export function input(properties) {
  const props = {}, required = [];
  for (const [k, p] of Object.entries(properties)) {
    if (p[REQUIRED]) required.push(k);
    props[k] = p[NULLABLE] ? { ...p, type: [p.type, 'null'] } : { ...p };
  }
  return { type: 'object', properties: props, ...(required.length && { required }) };
}

const typeOk = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: Array.isArray,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
};

// Returns a copy with defaults filled in and unknown keys dropped; throws on the first problem.
export function validate(schema, value, path = 'arguments') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((t) => typeOk[t](value))) fail(`${path} must be ${types.join(' or ')}`);
  if (value === null) return null;
  if (schema.enum && !schema.enum.includes(value)) fail(`${path} must be one of ${schema.enum.join(', ')}`);
  if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} must be >= ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} must be <= ${schema.maximum}`);
  if (Array.isArray(value)) {
    const tooMany = schema.maxItems !== undefined && value.length > schema.maxItems;
    if (tooMany) fail(`${path} takes at most ${schema.maxItems} items`);
    return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
  }
  if (types.includes('object')) {
    const out = {};
    for (const k of schema.required ?? []) if (value[k] === undefined) fail(`${path}.${k} is required`);
    for (const [k, p] of Object.entries(schema.properties ?? {})) {
      if (value[k] !== undefined) out[k] = validate(p, value[k], `${path}.${k}`);
      else if (p.default !== undefined) out[k] = structuredClone(p.default);
    }
    return out;
  }
  return value;
}
