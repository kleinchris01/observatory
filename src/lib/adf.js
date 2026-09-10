// Minimal Atlassian Document Format builder.
//
// Jira Cloud's create-issue API wants ADF for the description field. This converts a plain
// text template into the smallest valid ADF that renders it, so the remediation playbooks
// can be written as readable template strings rather than nested JSON:
//   blank line  -> paragraph break
//   "## text"   -> level-3 heading
//   "- text"    -> bullet list item
// Everything else is paragraph text; consecutive non-blank lines join with a space.

export function renderADF(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const content = [];
  let para = [];
  let bullets = [];

  const flushPara = () => {
    if (para.length) {
      content.push({ type: "paragraph", content: [{ type: "text", text: para.join(" ") }] });
      para = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      content.push({
        type: "bulletList",
        content: bullets.map((b) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: b }] }],
        })),
      });
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") { flushPara(); flushBullets(); continue; }
    if (line.startsWith("## ")) {
      flushPara();
      flushBullets();
      content.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: line.slice(3) }] });
      continue;
    }
    if (line.startsWith("- ")) { flushPara(); bullets.push(line.slice(2)); continue; }
    flushBullets();
    para.push(line);
  }
  flushPara();
  flushBullets();

  if (!content.length) content.push({ type: "paragraph", content: [{ type: "text", text: "" }] });
  return { type: "doc", version: 1, content };
}
