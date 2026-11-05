import {
  createNameRateSampler,
  createRateSampler,
  createTailSampler,
  errors,
  slowerThan,
  traceSampled,
} from "../src/index.js";
import type {
  WideEventCandidate,
  WideEventSampler,
  WideEventSamplingDecision,
} from "../src/index.js";

function candidate(overrides: Partial<WideEventCandidate> = {}): WideEventCandidate {
  const now = new Date(0).toISOString();
  return {
    id: "1",
    name: "job",
    kind: "custom",
    startedAt: now,
    endedAt: now,
    durationMs: 1,
    outcome: "success",
    payload: { sizeBytes: 0, truncated: false, maxBytes: 1 },
    data: {},
    errors: [],
    ...overrides,
  };
}

function decide(sampler: WideEventSampler, overrides?: Partial<WideEventCandidate>) {
  return sampler(candidate(overrides)) as WideEventSamplingDecision;
}

describe("createTailSampler", () => {
  const dropAll = { keep: [errors(), slowerThan(2000)], rate: 0 };

  it("always keeps errors, whatever the rate", () => {
    expect(decide(createTailSampler(dropAll), { outcome: "error" })).toEqual({
      sampled: true,
      reason: "keep_rule",
      rule: "errors",
      sampleRate: 1,
    });
  });

  it("always keeps slow events", () => {
    expect(decide(createTailSampler(dropAll), { durationMs: 2001 })).toMatchObject({
      sampled: true,
      rule: "slower_than:2000",
    });
    expect(decide(createTailSampler(dropAll), { durationMs: 2000 }).sampled).toBe(false);
  });

  it("keeps events matching a custom rule, and names the rule", () => {
    function enterprise(event: WideEventCandidate): boolean {
      return event.data.user?.tier === "enterprise";
    }

    const sampler = createTailSampler({ keep: [enterprise, (e) => e.data.vip === true], rate: 0 });

    expect(decide(sampler, { data: { user: { tier: "enterprise" } } }).rule).toBe("enterprise");
    expect(decide(sampler, { data: { vip: true } }).rule).toBe("keep[1]");
    expect(decide(sampler).sampled).toBe(false);
  });

  it("keeps rule matches on traceSampled only when opted in", () => {
    const sampler = createTailSampler({ keep: [traceSampled()], rate: 0 });
    expect(decide(sampler, { traceSampled: true }).rule).toBe("trace_sampled");
    expect(decide(sampler, { traceSampled: false }).sampled).toBe(false);
    expect(decide(createTailSampler({ rate: 0 }), { traceSampled: true }).sampled).toBe(false);
  });

  it("records the rate as a 1-in-N integer for sampled events", () => {
    const decision = decide(createTailSampler({ rate: 0.05, random: () => 0 }));
    expect(decision).toEqual({
      sampled: true,
      reason: "rate_keep",
      rule: "rate:0.05",
      sampleRate: 20,
    });
    expect(decide(createTailSampler({ rate: 0.03, random: () => 0 })).sampleRate).toBe(33);
  });

  it("samples from the random source when there is no trace", () => {
    const sampler = createTailSampler({ rate: 0.5, random: () => 0.75 });
    expect(decide(sampler).sampled).toBe(false);
    expect(decide(sampler).reason).toBe("rate_drop");
  });

  it("derives the decision from the trace ID, ignoring the random source", () => {
    const keptAtAnyRate = `${"0".repeat(18)}${"f".repeat(14)}`;
    const droppedBelowRateOne = `${"f".repeat(18)}${"0".repeat(14)}`;

    const neverRandom = () => 0.99;
    const alwaysRandom = () => 0;

    expect(
      decide(createTailSampler({ rate: 0.05, random: neverRandom }), { traceId: keptAtAnyRate })
        .sampled,
    ).toBe(true);
    expect(
      decide(createTailSampler({ rate: 0.05, random: alwaysRandom }), {
        traceId: droppedBelowRateOne,
      }).sampled,
    ).toBe(false);
  });

  it("matches the OpenTelemetry rejection threshold for 1%", () => {
    // 0.99 * 2^56 is 0xfd70a3d70a3d70, which the spec abbreviates to th:fd70a4.
    const sampler = createTailSampler({ rate: 0.01 });
    const justBelow = `${"0".repeat(18)}fd70a3d70a3d00`;
    const justAbove = `${"0".repeat(18)}fd70a400000000`;

    expect(decide(sampler, { traceId: justBelow }).sampled).toBe(false);
    expect(decide(sampler, { traceId: justAbove }).sampled).toBe(true);
  });

  it("makes the same decision for a trace across independent services", () => {
    const traceIds = Array.from({ length: 200 }, (_, index) =>
      index.toString(16).padStart(4, "0").repeat(8),
    );
    const serviceA = createTailSampler({ rate: 0.5 });
    const serviceB = createTailSampler({ rate: 0.5 });

    for (const traceId of traceIds) {
      expect(decide(serviceA, { traceId }).sampled).toBe(decide(serviceB, { traceId }).sampled);
    }
  });

  it("treats rates of 0 and 1 as absolute", () => {
    const traceId = "f".repeat(32);
    const zero = `${"0".repeat(32)}`;
    expect(decide(createTailSampler({ rate: 0 }), { traceId }).sampled).toBe(false);
    expect(decide(createTailSampler({ rate: 1 }), { traceId: zero }).sampled).toBe(true);
  });

  it("throws at startup for invalid configuration", () => {
    expect(() => createTailSampler({ rate: 2 })).toThrow(RangeError);
    expect(() => createTailSampler({ rate: Number.NaN })).toThrow(RangeError);
    expect(() => createTailSampler({ rate: 1, keep: ["errors" as never] })).toThrow(TypeError);
    expect(() => slowerThan(-1)).toThrow(RangeError);
  });
});

describe("createRateSampler", () => {
  it("throws for an invalid rate instead of silently dropping everything", () => {
    expect(() => createRateSampler(2)).toThrow(RangeError);
  });

  it("records the sample rate", () => {
    expect(decide(createRateSampler(0.1, () => 0))).toMatchObject({
      sampled: true,
      sampleRate: 10,
    });
  });
});

describe("createNameRateSampler", () => {
  it("throws for an invalid rate", () => {
    expect(() => createNameRateSampler({ job: -1 })).toThrow(RangeError);
    expect(() => createNameRateSampler({}, 2)).toThrow(RangeError);
  });

  it("uses the rate for the event's name, falling back otherwise", () => {
    const sampler = createNameRateSampler({ always: 1 }, 0);
    expect(decide(sampler, { name: "always" }).sampled).toBe(true);
    expect(decide(sampler, { name: "other" }).sampled).toBe(false);
    expect(decide(sampler, { name: "constructor" }).sampled).toBe(false);
  });
});
