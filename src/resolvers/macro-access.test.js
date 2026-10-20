import { vi, describe, test, expect } from "vitest";
// The harness must be imported before the resolvers: it registers the vi.mock calls.
import { installResolverTestDefaults, mocks } from "./test-harness.js";
import {
  SHARED_RESOLVER_FUNCTIONS,
  withMacroAccessGuard,
  MacroAccessError,
  __RAW_ADMIN_ONLY_FUNCTIONS,
} from "../resolvers.js";
import { viewerProjectCount } from "./viewer.js";

const { checkMacroAccess } = { ...SHARED_RESOLVER_FUNCTIONS, ...__RAW_ADMIN_ONLY_FUNCTIONS };

// Split out of src/resolvers.test.js (docs/resolvers-refactor.md, follow-up 3). The mocked lib
// layer, the shared helpers and the per-test defaults live in test-harness.js.
installResolverTestDefaults();

// ---------------------------------------------------------------------------
// checkMacroAccess -- the macro's own access gate. Deliberately fails open
// (grants access) on any error, since blocking every user due to a transient
// API failure is worse than a brief over-permissive window. That fail-open
// behavior is exactly the kind of thing a refactor could silently invert
// with nothing to catch it, so every branch gets its own test.
// ---------------------------------------------------------------------------
describe("checkMacroAccess", () => {
  test("allows access when restriction is off", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: false, allowedGroups: [] } });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toMatchObject({ allowed: true });
    expect(mocks.apiAsAppRequestJira).not.toHaveBeenCalled();
  });

  test("denies with a clear reason when restricted but no groups configured", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: [] } });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no allowed groups/i);
  });

  test("denies when restricted and no accountId is present (not signed in)", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    const result = await checkMacroAccess({ context: {} });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/sign in/i);
  });

  test("allows a user who is in an allowed group", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "jira-admins" }, { name: "other-group" }],
    });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toMatchObject({ allowed: true });
  });

  test("denies a user who is not in any allowed group", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "some-other-group" }],
    });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/don't have permission/i);
  });

  test("fails open (allows) when the group-lookup API call is not ok", async () => {
    mocks.kvsGet.mockResolvedValue({ macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } });
    mocks.apiAsAppRequestJira.mockResolvedValue({ ok: false, status: 500 });
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toMatchObject({ allowed: true });
  });

  test("fails open (allows) when reading admin config throws", async () => {
    mocks.kvsGet.mockRejectedValue(new Error("kvs unavailable"));
    const result = await checkMacroAccess({ context: { accountId: "user-1" } });
    expect(result).toMatchObject({ allowed: true });
  });
});

// The macro's group restriction used to be enforced only by the page asking
// checkMacroAccess first. Every macro read now passes through the same decision.
describe("withMacroAccessGuard", () => {
  const restricted = { macroAccess: { restrictAccess: true, allowedGroups: ["jira-admins"] } };
  const inner = vi.fn(async () => ({ rows: ["data"] }));
  const guarded = () => withMacroAccessGuard({ getMacroFields: inner, checkMacroAccess: vi.fn(async () => "check") });

  test("lets every call through when the restriction is off", async () => {
    mocks.kvsGet.mockResolvedValueOnce({ macroAccess: { restrictAccess: false } });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).resolves.toEqual({ rows: ["data"] });
    expect(mocks.apiAsAppRequestJira).not.toHaveBeenCalled();
  });

  test("refuses a direct read from a viewer outside the allowed groups", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: true, json: async () => [{ name: "other" }] });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).rejects.toBeInstanceOf(MacroAccessError);
    expect(inner).not.toHaveBeenCalled();
  });

  test("refuses an anonymous caller when restricted", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    await expect(guarded().getMacroFields({ context: {} })).rejects.toThrow(/sign in/i);
  });

  test("serves a viewer in an allowed group, and asks Jira once per minute, not per call", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValue({ ok: true, json: async () => [{ name: "jira-admins" }] });
    const fns = guarded();
    await fns.getMacroFields({ context: { accountId: "u" } });
    await fns.getMacroFields({ context: { accountId: "u" } });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(mocks.apiAsAppRequestJira).toHaveBeenCalledTimes(1);
  });

  // The documented accepted risk (SECURITY_CHECKLIST 1.3): a failed lookup grants access.
  test("fails open when the group lookup errors, as the checklist documents", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(guarded().getMacroFields({ context: { accountId: "u" } })).resolves.toEqual({ rows: ["data"] });
  });

  test("leaves checkMacroAccess itself unguarded so a denied viewer can be told why", async () => {
    mocks.kvsGet.mockResolvedValue(restricted);
    mocks.apiAsAppRequestJira.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await expect(guarded().checkMacroAccess({ context: { accountId: "u" } })).resolves.toBe("check");
  });

  test("wraps every shared function", () => {
    const wrapped = withMacroAccessGuard(SHARED_RESOLVER_FUNCTIONS);
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(SHARED_RESOLVER_FUNCTIONS).sort());
  });
});

// The project count the macro shows a viewer. A failed lookup is "unknown" (null), never 0,
// which would tell someone they can see no projects at all.
describe("viewerProjectCount", () => {
  test("answers null when the viewer's projects cannot be resolved", async () => {
    mocks.getInstallationKey.mockImplementationOnce(() => {
      throw new Error("no install context");
    });
    expect(await viewerProjectCount({ accountId: "acct-1" })).toBeNull();
  });
});
