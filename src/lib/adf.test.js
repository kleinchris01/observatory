import { describe, it, expect } from "vitest";
import { renderADF } from "./adf.js";

describe("renderADF", () => {
  it("wraps output in a valid ADF doc", () => {
    const doc = renderADF("hello");
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("turns a '## ' line into a level-3 heading", () => {
    const doc = renderADF("## Why this matters");
    expect(doc.content[0]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Why this matters" }],
    });
  });

  it("groups consecutive '- ' lines into one bullet list", () => {
    const doc = renderADF("- first\n- second\n- third");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("bulletList");
    expect(doc.content[0].content.map((li) => li.content[0].content[0].text)).toEqual(["first", "second", "third"]);
  });

  it("joins consecutive non-blank prose lines into one paragraph", () => {
    const doc = renderADF("line one\nline two");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].content[0].text).toBe("line one line two");
  });

  it("splits paragraphs on a blank line", () => {
    const doc = renderADF("para one\n\npara two");
    expect(doc.content.map((p) => p.content[0].text)).toEqual(["para one", "para two"]);
  });

  it("handles a realistic multi-block template", () => {
    const doc = renderADF(`
## The filter
Name: Open Bugs
Filter id: 4001

## Steps
- Open the filter in Jira.
- Change its owner.

## Done when
The filter has an active owner.
`);
    const types = doc.content.map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "heading", "bulletList", "heading", "paragraph"]);
  });

  it("never returns an empty content array", () => {
    for (const input of ["", "   ", null, undefined, "\n\n\n"]) {
      const doc = renderADF(input);
      expect(doc.content.length).toBeGreaterThan(0);
      expect(doc.type).toBe("doc");
    }
  });

  it("normalises CRLF line endings", () => {
    const doc = renderADF("## Head\r\n\r\nbody");
    expect(doc.content[0].type).toBe("heading");
    expect(doc.content[1].content[0].text).toBe("body");
  });
});

describe("renderADF links", () => {
  it("turns [label](https://...) into a linked text node inside paragraphs and bullets", () => {
    const doc = renderADF(
      "See [the filter](https://x.atlassian.net/issues/?filter=1) now.\n\n- [A](https://a.b/c) and b",
    );
    expect(doc.content[0].content).toEqual([
      { type: "text", text: "See " },
      {
        type: "text",
        text: "the filter",
        marks: [{ type: "link", attrs: { href: "https://x.atlassian.net/issues/?filter=1" } }],
      },
      { type: "text", text: " now." },
    ]);
    expect(doc.content[1].content[0].content[0].content[0]).toMatchObject({ text: "A", marks: [{ type: "link" }] });
  });

  it("leaves a non-http target as literal text", () => {
    const doc = renderADF("[bad](javascript:alert(1))");
    expect(doc.content[0].content).toEqual([{ type: "text", text: "[bad](javascript:alert(1))" }]);
  });
});
