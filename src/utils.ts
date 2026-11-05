import { randomUUID } from "node:crypto";

import type { WideEventData } from "#src/types.js";

const CIRCULAR_PLACEHOLDER = "[Circular]";
const MAX_DEPTH_PLACEHOLDER = "[MaxDepth]";
const UNSERIALIZABLE_PLACEHOLDER = "[Unserializable]";
const MAX_DEPTH = 32;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Assigning to `__proto__` would replace an object's prototype instead of adding a field. */
export function isUnsafeKey(key: string): boolean {
  return key === "__proto__";
}

/** Reads a field without walking the prototype chain, so `constructor` and friends read as absent. */
export function readOwn(target: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

function mergeInto(
  target: WideEventData,
  source: WideEventData,
  ancestors: Set<object>,
): WideEventData {
  ancestors.add(source);

  for (const [key, sourceValue] of Object.entries(source)) {
    if (isUnsafeKey(key)) {
      continue;
    }

    if (isPlainObject(sourceValue)) {
      if (ancestors.has(sourceValue)) {
        target[key] = CIRCULAR_PLACEHOLDER;
        continue;
      }

      const targetValue = readOwn(target, key);
      target[key] = mergeInto(
        isPlainObject(targetValue) ? targetValue : {},
        sourceValue,
        ancestors,
      );
      continue;
    }

    target[key] = Array.isArray(sourceValue) ? [...sourceValue] : sourceValue;
  }

  ancestors.delete(source);
  return target;
}

export function deepMerge(target: WideEventData, source: WideEventData): WideEventData {
  return mergeInto(target, source, new Set());
}

function sanitizeObject(value: object, ancestors: Set<object>, depth: number): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (value instanceof URL || value instanceof RegExp) {
    return String(value);
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[Binary ${value.byteLength} bytes]`;
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return sanitizeValue(toJSON.call(value), ancestors, depth + 1);
  }

  if (value instanceof Set) {
    return [...value].map((item) => sanitizeValue(item, ancestors, depth + 1) ?? null);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, ancestors, depth + 1) ?? null);
  }

  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  const output: Record<string, unknown> = {};

  for (const [key, child] of entries) {
    const name = String(key);
    if (isUnsafeKey(name)) {
      continue;
    }

    const sanitized = sanitizeValue(child, ancestors, depth + 1);
    if (sanitized !== undefined) {
      output[name] = sanitized;
    }
  }

  return output;
}

function sanitizeValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return undefined;
  }

  if (value === null) {
    return null;
  }

  if (ancestors.has(value)) {
    return CIRCULAR_PLACEHOLDER;
  }

  if (depth >= MAX_DEPTH) {
    return MAX_DEPTH_PLACEHOLDER;
  }

  ancestors.add(value);
  try {
    return sanitizeObject(value, ancestors, depth);
  } catch {
    return UNSERIALIZABLE_PLACEHOLDER;
  } finally {
    ancestors.delete(value);
  }
}

/** Converts arbitrary fields into a JSON-safe copy. A bad field can never lose the event. */
export function sanitizeData(data: unknown): WideEventData {
  const sanitized = sanitizeValue(data, new Set(), 0);
  return isPlainObject(sanitized) ? sanitized : {};
}

export function createDefaultId(): string {
  return randomUUID();
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
