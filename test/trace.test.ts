import { extractTraceContextFromHeaders, parseTraceparent } from "../src/index.js";

describe("trace helpers", () => {
  it("parses valid traceparent headers", () => {
    const trace = parseTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(trace).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
    });
  });

  it("returns undefined for invalid traceparent values", () => {
    expect(parseTraceparent("invalid")).toBeUndefined();
  });

  it("extracts trace context from headers", () => {
    const trace = extractTraceContextFromHeaders({
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      tracestate: "vendor=t1"
    });

    expect(trace).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      tracestate: "vendor=t1"
    });
  });
});
