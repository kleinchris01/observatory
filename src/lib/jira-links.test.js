import { describe, it, expect } from "vitest";
import { jiraLinks as L, md } from "./jira-links.js";

const O = "https://acme.atlassian.net";

describe("jiraLinks", () => {
  it("returns null without an origin or an id, never a half-built URL", () => {
    expect(L.filter(null, "1")).toBeNull();
    expect(L.filter(O, "")).toBeNull();
    expect(L.permissionScheme(O, undefined)).toBeNull();
    expect(L.statusAdmin(null)).toBeNull();
  });

  it("builds the classic field admin links from the numeric custom field id only", () => {
    expect(L.field(O, "customfield_10042")).toBe(`${O}/secure/admin/EditCustomField!default.jspa?id=10042`);
    expect(L.fieldContexts(O, "customfield_10042")).toBe(`${O}/secure/admin/ConfigureCustomField!default.jspa?customFieldId=10042`);
    expect(L.field(O, "summary")).toBeNull();
  });

  it("encodes what it interpolates", () => {
    expect(L.search(O, "status = 1")).toBe(`${O}/issues/?jql=status%20%3D%201`);
    expect(L.projectRoles(O, "A B")).toBe(`${O}/plugins/servlet/project-config/A%20B/roles`);
  });
});

describe("workflow links", () => {
  it("opens a live workflow by name and the workflow list", () => {
    expect(L.workflow("https://a.net", "Build WF")).toBe("https://a.net/secure/admin/workflows/ViewWorkflowSteps.jspa?workflowMode=live&workflowName=Build%20WF");
    expect(L.workflow("https://a.net", "")).toBeNull();
    expect(L.workflowsAdmin("https://a.net")).toBe("https://a.net/secure/admin/workflows/ListWorkflows.jspa");
    expect(L.workflowsAdmin(null)).toBeNull();
  });
});

describe("md", () => {
  it("is a link with a URL and the bare label without one", () => {
    expect(md("Filter", `${O}/x`)).toBe(`[Filter](${O}/x)`);
    expect(md("Filter", null)).toBe("Filter");
  });

  it("softens brackets so a name cannot break the link syntax", () => {
    expect(md("[Legacy] Bugs", `${O}/x`)).toBe(`[(Legacy) Bugs](${O}/x)`);
  });
});
