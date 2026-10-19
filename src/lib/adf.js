// Minimal Atlassian Document Format builder.
//
// Jira Cloud's create-issue API wants ADF for the description field. This converts a plain
// text template into the smallest valid ADF that renders it, so the remediation playbooks
// can be written as readable template strings rather than nested JSON:
//   blank line  -> paragraph break
//   "## text"   -> level-3 heading
//   "- text"    -> bullet list item
//   "[label](https://...)" anywhere in a paragraph or bullet -> a link
// Everything else is paragraph text; consecutive non-blank lines join with a space.
//
// Links exist because a remediation ticket has to take its reader straight to the thing it is
// about -- the filter, the scheme, the project's roles page -- rather than leave them to go
// searching by id. Only http(s) targets become links; anything else stays literal text.

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

// One run of text as ADF inline nodes: plain text, with each [label](url) as a linked text
// node. Empty runs are dropped -- ADF rejects a text node with no text.
export function inlineNodes(text) {
  const nodes = [];
  let last = 0;
  const source = String(text || "");
  for (const m of source.matchAll(LINK)) {
    if (m.index > last) nodes.push({ type: "text", text: source.slice(last, m.index) });
    nodes.push({ type: "text", text: m[1], marks: [{ type: "link", attrs: { href: m[2] } }] });
    last = m.index + m[0].length;
  }
  if (last < source.length) nodes.push({ type: "text", text: source.slice(last) });
  return nodes.length ? nodes : [{ type: "text", text: "" }];
}

export function renderADF(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const content = [];
  let para = [];
  let bullets = [];

  const flushPara = () => {
    if (para.length) {
      content.push({ type: "paragraph", content: inlineNodes(para.join(" ")) });
      para = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      content.push({
        type: "bulletList",
        content: bullets.map((b) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inlineNodes(b) }],
        })),
      });
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flushPara();
      flushBullets();
      continue;
    }
    if (line.startsWith("## ")) {
      flushPara();
      flushBullets();
      content.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: line.slice(3) }] });
      continue;
    }
    if (line.startsWith("- ")) {
      flushPara();
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();
    para.push(line);
  }
  flushPara();
  flushBullets();

  if (!content.length) content.push({ type: "paragraph", content: [{ type: "text", text: "" }] });
  return { type: "doc", version: 1, content };
}
