import {
  createNameRateSampler,
  createNameRateSamplerResult,
  createRateSampler,
  createRateSamplerResult
} from "../src/index.js";

describe("sampler helpers", () => {
  it("returns err from createRateSamplerResult for invalid rate", () => {
    const result = createRateSamplerResult(2);
    expect(result.isErr()).toBe(true);
  });

  it("returns fail-safe dropped sampler for invalid createRateSampler input", async () => {
    const sampler = createRateSampler(2);
    const decision = await sampler({
      id: "1",
      name: "x",
      kind: "custom",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: "success",
      data: {}
    });

    expect(typeof decision).toBe("object");
    expect((decision as { sampled: boolean }).sampled).toBe(false);
  });

  it("returns err from createNameRateSamplerResult for invalid map rate", () => {
    const result = createNameRateSamplerResult(
      {
        test: -1
      },
      1
    );
    expect(result.isErr()).toBe(true);
  });

  it("returns a usable sampler for valid name rates", async () => {
    const sampler = createNameRateSampler(
      {
        always: 1
      },
      0
    );

    const decision = await sampler({
      id: "1",
      name: "always",
      kind: "custom",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      outcome: "success",
      data: {}
    });

    if (typeof decision === "boolean") {
      expect(decision).toBe(true);
      return;
    }

    expect(decision.sampled).toBe(true);
  });
});
