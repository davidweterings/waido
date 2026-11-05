import type {
  WideEventData,
  WideEventDraft,
  WideEventPayloadInfo,
  WideEventPayloadPolicy,
} from "#src/types.js";
import { isPlainObject } from "#src/utils.js";

export const DEFAULT_MAX_BYTES = 64 * 1024;

/** Room left for `sampling` and `payload`, which are added after the limit is applied. */
const RESERVED_BYTES = 256;

interface Leaf {
  parent: Record<string, unknown>;
  key: string;
  size: number;
}

function getJsonSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function collectLeaves(data: Record<string, unknown>, leaves: Leaf[]): void {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value)) {
      collectLeaves(value, leaves);
      continue;
    }

    leaves.push({ parent: data, key, size: getJsonSizeBytes(value) });
  }
}

/** Replaces the largest values first, so small fields such as `http.route` survive. */
function truncateData(data: WideEventData, overBy: number, placeholder: string): void {
  const placeholderSize = getJsonSizeBytes(placeholder);
  const leaves: Leaf[] = [];
  collectLeaves(data, leaves);
  leaves.sort((left, right) => right.size - left.size);

  let remaining = overBy;
  for (const leaf of leaves) {
    if (remaining <= 0 || leaf.size <= placeholderSize) {
      return;
    }

    leaf.parent[leaf.key] = placeholder;
    remaining -= leaf.size - placeholderSize;
  }
}

/** Last resort for events made huge by their errors: the newest errors lose detail first. */
function shrinkErrors(event: WideEventDraft, budget: number): void {
  for (const field of ["stack", "cause"] as const) {
    for (let index = event.errors.length - 1; index >= 0; index -= 1) {
      if (getJsonSizeBytes(event) <= budget) {
        return;
      }

      delete event.errors[index][field];
    }
  }
}

export function applyPayloadPolicy(
  event: WideEventDraft,
  policy: WideEventPayloadPolicy | undefined,
): WideEventPayloadInfo {
  const maxBytes = policy?.maxBytes ?? DEFAULT_MAX_BYTES;
  const budget = Math.max(0, maxBytes - RESERVED_BYTES);
  const initialSize = getJsonSizeBytes(event);

  if (initialSize <= budget) {
    return { sizeBytes: initialSize, truncated: false, maxBytes };
  }

  const placeholder = policy?.truncatePlaceholder ?? "[Truncated]";
  truncateData(event.data, initialSize - budget, placeholder);

  if (getJsonSizeBytes(event) > budget) {
    event.data = { __truncated: true };
  }

  shrinkErrors(event, budget);

  return { sizeBytes: getJsonSizeBytes(event), truncated: true, maxBytes };
}
