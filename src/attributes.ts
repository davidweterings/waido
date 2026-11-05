import type { WideEventCandidate, WideEventData } from "#src/types.js";
import { isPlainObject } from "#src/utils.js";

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttributeValue>;

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function toAttributeArray(values: unknown[]): AttributeValue {
  const isHomogeneousPrimitive =
    values.every(isPrimitive) && new Set(values.map((value) => typeof value)).size <= 1;

  return isHomogeneousPrimitive ? (values as string[]) : JSON.stringify(values);
}

function flatten(data: WideEventData, prefix: string, output: Attributes): Attributes {
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (isPrimitive(value)) {
      output[name] = value;
    } else if (Array.isArray(value)) {
      output[name] = toAttributeArray(value);
    } else if (isPlainObject(value)) {
      flatten(value, name, output);
    }
  }

  return output;
}

/** Drops absent values, which aren't valid attributes. */
export function compact(attributes: Record<string, AttributeValue | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  ) as Attributes;
}

/** Flattens an event into the dotted keys backends index, such as `http.route` and `user.id`. */
export function toEventAttributes(event: WideEventCandidate): Attributes {
  return {
    ...flatten(event.data, "", {}),
    ...compact({
      "waido.event.id": event.id,
      "waido.event.name": event.name,
      "waido.event.parent_id": event.parentId,
      "waido.event.kind": event.kind,
      "waido.outcome": event.outcome,
      "waido.duration_ms": event.durationMs,
      "waido.status": event.status,
      "waido.payload.truncated": event.payload.truncated || undefined,
      "waido.error_count":
        event.errors.length > 0 ? event.errors.length + (event.errorsDropped ?? 0) : undefined,
      "error.type": event.errors[0]?.name,
    }),
  };
}
