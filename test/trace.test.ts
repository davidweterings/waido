import { extractTraceContextFromHeaders, parseTraceparent } from "../src/index.js";

const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);

describe("parseTraceparent", () => {
  it("treats the header's span ID as the parent, not this event's span", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
      traceSampled: true,
    });
  });

  it("reads the sampled flag", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.traceSampled).toBe(false);
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-03`)?.traceSampled).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(parseTraceparent("invalid")).toBeUndefined();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
  });

  it("normalizes case and accepts future versions with extra fields", () => {
    expect(parseTraceparent(`01-${"A".repeat(32)}-${SPAN_ID}-01-extra`)?.traceId).toBe(TRACE_ID);
  });
});

describe("extractTraceContextFromHeaders", () => {
  it("reads the traceparent header", () => {
    expect(extractTraceContextFromHeaders({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })).toEqual(
      { traceId: TRACE_ID, parentSpanId: SPAN_ID, traceSampled: true },
    );
  });

  it("returns undefined when it's missing or invalid", () => {
    expect(extractTraceContextFromHeaders({})).toBeUndefined();
    expect(extractTraceContextFromHeaders({ traceparent: "bad" })).toBeUndefined();
  });
});
