import { TaggedError } from "better-result";
import type { Result as BetterResult } from "better-result";

export type WideResult<T, E> = BetterResult<T, E>;

export class NoActiveWideEventError extends TaggedError("NoActiveWideEventError")<{
  message: string;
}>() {}

export class FlushWideEventsTimeoutError extends TaggedError("FlushWideEventsTimeoutError")<{
  message: string;
  timeoutMs: number;
  pendingOperations: number;
  activeScopes: number;
}>() {}

export class EmitWideEventTimeoutError extends TaggedError("EmitWideEventTimeoutError")<{
  message: string;
  timeoutMs: number;
  eventId: string;
  eventName: string;
}>() {}

export class InvalidSamplerRateError extends TaggedError("InvalidSamplerRateError")<{
  message: string;
  rate: number;
}>() {}

export class InvalidPayloadPolicyError extends TaggedError("InvalidPayloadPolicyError")<{
  message: string;
  maxBytes: number;
}>() {}
