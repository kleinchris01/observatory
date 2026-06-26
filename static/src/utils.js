export function formatTimestamp(value) {
  if (!value) return "No field change detected";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatNumber(value, fallback = "0") {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString() : fallback;
}

// Jira stores many field names in ALL CAPS. Detect predominantly-uppercase names
// and convert them to title case so the table isn't visually aggressive.
export function toDisplayName(name) {
  if (!name) return name;
  const s = String(name);
  const letters = s.replace(/[^a-zA-Z]/g, "");
  if (!letters.length) return s;
  const upperRatio = (s.match(/[A-Z]/g) || []).length / letters.length;
  if (upperRatio < 0.75) return s; // already mixed-case — leave it alone
  return s.toLowerCase().replace(/(?:^|[\s()\-/])\S/g, (c) => c.toUpperCase());
}

export function buildValueJql(fields, rqtValue) {
  const clauses = [];
  for (const f of fields || []) {
    const m = String(f.fieldId).match(/customfield_(\d+)/);
    if (m) clauses.push(`cf[${m[1]}] ~ "${rqtValue}"`);
    else if (f.fieldId === "summary") clauses.push(`summary ~ "${rqtValue}"`);
    else if (f.fieldId === "description") clauses.push(`description ~ "${rqtValue}"`);
    else if (f.fieldId === "comment") clauses.push(`comment ~ "${rqtValue}"`);
  }
  return clauses.length ? clauses.join(" OR ") : `text ~ "${rqtValue}"`;
}
