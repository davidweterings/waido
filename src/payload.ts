import { InvalidPayloadPolicyError } from "#src/no-throw.js";
import type {
  WideEvent,
  WideEventPayloadInfo,
  WideEventPayloadPolicy,
  WideEventSamplingDecision
} from "#src/types.js";
import { cloneData } from "#src/utils.js";

type WideEventCandidate = Omit<WideEvent, "sampled" | "sampling">;

function getJsonSizeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function createTruncatedDataMarker(dataKeys: string[]): Record<string, unknown> {
  return {
    __truncated: true,
    __keys: dataKeys.slice(0, 25)
  };
}

function truncateEventDataToFit(
  event: WideEventCandidate,
  maxBytes: number,
  placeholder: string
): number {
  const data = cloneData(event.data);
  const sizedKeys = Object.keys(data)
    .map((key) => ({
      key,
      size: getJsonSizeBytes(data[key])
    }))
    .sort((left, right) => right.size - left.size);

  for (const { key } of sizedKeys) {
    event.data = data;

    const size = getJsonSizeBytes(event);
    if (size <= maxBytes) {
      return size;
    }

    data[key] = placeholder;
  }

  event.data = createTruncatedDataMarker(Object.keys(data));
  const markerSize = getJsonSizeBytes(event);
  if (markerSize <= maxBytes) {
    return markerSize;
  }

  event.data = {
    __truncated: true
  };

  return getJsonSizeBytes(event);
}

export interface PayloadPolicyResult {
  payload: WideEventPayloadInfo;
  forcedSamplingDecision?: WideEventSamplingDecision;
  error?: InvalidPayloadPolicyError;
}

function createDropDecision(reason: string, rule: string): WideEventSamplingDecision {
  return {
    sampled: false,
    reason,
    rule
  };
}

export function applyPayloadPolicy(
  event: WideEventCandidate,
  policy: WideEventPayloadPolicy | undefined
): PayloadPolicyResult {
  const initialSize = getJsonSizeBytes(event);

  if (!policy) {
    return {
      payload: {
        sizeBytes: initialSize,
        limited: false
      }
    };
  }

  if (!Number.isFinite(policy.maxBytes) || policy.maxBytes <= 0) {
    const error = new InvalidPayloadPolicyError({
      maxBytes: policy.maxBytes,
      message: `payloadPolicy.maxBytes must be a positive number. Received: ${policy.maxBytes}`
    });

    return {
      payload: {
        sizeBytes: initialSize,
        limited: true,
        maxBytes: policy.maxBytes,
        strategy: "drop"
      },
      forcedSamplingDecision: createDropDecision("invalid_payload_policy", `maxBytes:${policy.maxBytes}`),
      error
    };
  }

  if (initialSize <= policy.maxBytes) {
    return {
      payload: {
        sizeBytes: initialSize,
        limited: false,
        maxBytes: policy.maxBytes
      }
    };
  }

  const strategy = policy.overflowStrategy ?? "truncate";

  if (strategy === "drop") {
    return {
      payload: {
        sizeBytes: initialSize,
        limited: true,
        maxBytes: policy.maxBytes,
        strategy
      },
      forcedSamplingDecision: createDropDecision("payload_dropped", `maxBytes:${policy.maxBytes}`)
    };
  }

  if (strategy === "error") {
    const error = new InvalidPayloadPolicyError({
      maxBytes: policy.maxBytes,
      message: `Wide event payload exceeded maxBytes (${initialSize} > ${policy.maxBytes}) with overflowStrategy=error`
    });

    return {
      payload: {
        sizeBytes: initialSize,
        limited: true,
        maxBytes: policy.maxBytes,
        strategy
      },
      forcedSamplingDecision: createDropDecision(
        "payload_policy_error",
        `maxBytes:${policy.maxBytes};strategy:error`
      ),
      error
    };
  }

  const placeholder = policy.truncatePlaceholder ?? "[Truncated]";
  const finalSize = truncateEventDataToFit(event, policy.maxBytes, placeholder);

  return {
    payload: {
      sizeBytes: finalSize,
      limited: true,
      maxBytes: policy.maxBytes,
      strategy
    }
  };
}
