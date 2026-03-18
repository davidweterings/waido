import { randomUUID } from "node:crypto";

import type { WideEventData } from "#src/types.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function deepMerge(target: WideEventData, source: WideEventData): WideEventData {
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key];

    if (isPlainObject(sourceValue)) {
      target[key] = deepMerge(
        isPlainObject(targetValue) ? targetValue : {},
        sourceValue
      );
      continue;
    }

    if (Array.isArray(sourceValue)) {
      target[key] = [...sourceValue];
      continue;
    }

    target[key] = sourceValue;
  }

  return target;
}

export function cloneData(input: WideEventData | undefined): WideEventData {
  if (input === undefined) {
    return {};
  }

  return deepMerge({}, input);
}

export function createDefaultId(): string {
  return randomUUID();
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
