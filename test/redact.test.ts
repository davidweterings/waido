import { createRedactor } from "../src/index.js";

describe("createRedactor", () => {
  it("replaces values at exact paths", () => {
    const data = { user: { id: "u1", email: "a@b.c" }, token: "secret" };
    createRedactor({ paths: ["user.email", "token"] })(data);
    expect(data).toEqual({ user: { id: "u1", email: "[REDACTED]" }, token: "[REDACTED]" });
  });

  it("supports wildcards across object keys and array items", () => {
    const data = {
      users: [{ email: "a" }, { email: "b", id: 1 }],
      headers: { authorization: "x", cookie: "y" },
    };
    createRedactor({ paths: ["users.*.email", "headers.*"] })(data);
    expect(data).toEqual({
      users: [{ email: "[REDACTED]" }, { email: "[REDACTED]", id: 1 }],
      headers: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
    });
  });

  it("ignores paths that don't exist, without creating them", () => {
    const data = { user: "not-an-object" };
    createRedactor({ paths: ["user.email", "missing.field"] })(data);
    expect(data).toEqual({ user: "not-an-object" });
  });

  it("supports a custom censor", () => {
    const data = { token: "secret" };
    createRedactor({ paths: ["token"], censor: "***" })(data);
    expect(data.token).toBe("***");
  });

  it("throws at startup for an invalid path", () => {
    expect(() => createRedactor({ paths: [""] })).toThrow(TypeError);
    expect(() => createRedactor({ paths: ["user..email"] })).toThrow(TypeError);
  });
});
