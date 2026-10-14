// Automation pillar: insights, the rule index and analysis saves, cascades, blast radius and field/status usage.
//
// Moved verbatim from src/resolvers.js; see docs/resolvers-refactor.md.

import {
  incrMetric,
  METRIC_NAMES,
  getInstallationKey,
  probeEndpoint,
  probeStargateEndpoint,
  getCloudId,
  getAllJiraProjects,
} from "../lib/jira-api.js";
import {
  readIssueTypeSnapshotMeta,
  loadIssueTypes,
  readUserSnapshotMeta,
  loadUsers,
} from "../lib/project-store.js";
import { analyzeCascadeGraph, MAX_CHAIN_DEPTH } from "../lib/cascade-graph.js";
import { assessAutomationEvidence, DEFAULT_ANALYSIS_STALE_AFTER_DAYS } from "../lib/automation-analysis.js";
import {
  readAutomationAnalysis,
  writeAutomationAnalysis,
  readAutomationPart,
  writeAutomationPart,
  replaceAutomationReferences,
  replaceAutomationRules,
  replaceAutomationFindings,
  replaceAutomationCascades,
  replaceAutomationBlast,
  loadBlastRules,
  loadCascadeSummary,
  loadCascades,
  loadCascadeEdges,
  loadRuleDirectoryFor,
  loadAutomationReferencesFor,
  AUTOMATION_PARTS,
  MAX_PREVIEW_FINDINGS,
  MAX_STORED_CASCADES,
  MAX_STORED_CROSS_RULE,
} from "../lib/store/automation.js";
import { logger, fallbackOn } from "../lib/logger.js";
import { readAdminConfig } from "./admin-config.js";

export async function getAutomationInsights({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const analysis = await readAutomationAnalysis(installationKey);

    if (!analysis) {
      return {
        available: false,
        reason: "no-analysis",
        refreshedAt: null,
      };
    }

    // Decided here rather than in the browser so the tab, the Rovo agent and the field panel
    // all take the same view of whether this import is still current. indexRequired is false
    // because this is the estate summary, not a per-entity lookup -- only the age applies.
    const cfg = await readAdminConfig().catch(() => null);
    const evidence = assessAutomationEvidence({
      indexRequired: false,
      refreshedAt: analysis.refreshedAt ?? null,
      staleAfterDays: Number(cfg?.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS,
    });

    return {
      available: true,
      refreshedAt: analysis.refreshedAt ?? null,
      evidence,
      source: analysis.source ?? "unknown",
      estate: analysis.estate ?? null,
      // A preview for the overview. The Findings section fetches the full list separately;
      // sending 675 rows with the first paint would slow every visit to pay for one section.
      findingsPreview: analysis.findingsPreview ?? [],
      findingsTotal: analysis.findingsTotal ?? (analysis.findingsPreview?.length ?? 0),
      cascades: analysis.cascades ?? [],
      cascadesTotal: analysis.cascadesTotal ?? (analysis.cascades?.length ?? 0),
      selfTriggeringTotal: analysis.selfTriggeringTotal ?? 0,
      // The three cross-rule checks. Null, not zero, on an analysis saved before they were
      // stored: those imports were never measured for them, and the tab says so.
      ...crossRuleSection(analysis),
      // The blast-radius tier histogram for the overview. Null on an analysis imported
      // before blast scoring existed — the tab shows a "re-import" prompt for that section.
      blast: analysis.blast ?? null,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationInsights failed:", error);
    throw error;
  }
}

// The cross-rule lists, keyed so the getter and the saver agree on the names.
export const CROSS_RULE_KEYS = ["eventCascades", "competingPairs", "fieldContradictions"];

// Saving: totals come from the payload (they describe the estate, not the capped list);
// a payload without a list leaves the check unmeasured rather than recording zero.
export function storedCrossRule(document) {
  const out = {};
  for (const key of CROSS_RULE_KEYS) {
    const list = document[key];
    if (!Array.isArray(list)) continue;
    const total = Number(document[`${key}Total`]);
    out[key] = list.slice(0, MAX_STORED_CROSS_RULE);
    out[`${key}Total`] = Number.isFinite(total) && total >= list.length ? total : list.length;
  }
  return out;
}

// Reading: null when the stored analysis predates the check.
export function crossRuleSection(analysis) {
  const out = {};
  for (const key of CROSS_RULE_KEYS) {
    const measured = Array.isArray(analysis[key]);
    out[key] = measured ? analysis[key] : [];
    out[`${key}Total`] = measured ? (Number(analysis[`${key}Total`]) || analysis[key].length) : null;
  }
  return out;
}

// The blast rollup is admin-supplied like the rest of the analysis payload. An admin can
// already read everything in it, so the risk is a malformed shape wedging the overview, not
// disclosure — every field is coerced and the top list is capped.
export function sanitizeBlastSummary(blast) {
  if (!blast || typeof blast !== "object" || Array.isArray(blast)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tiers = blast.byTier && typeof blast.byTier === "object" ? blast.byTier : {};
  return {
    available: Boolean(blast.available),
    total: num(blast.total),
    byTier: {
      estate: num(tiers.estate),
      "cross-project": num(tiers["cross-project"]),
      project: num(tiers.project),
      contained: num(tiers.contained),
    },
    estateWideCount: num(blast.estateWideCount),
    estateWideShare: num(blast.estateWideShare),
    estateWideCredentialCount: num(blast.estateWideCredentialCount),
    estimatedCount: num(blast.estimatedCount),
    top: Array.isArray(blast.top)
      ? blast.top.slice(0, 20).map((r) => ({
          ruleId: String(r?.ruleId ?? ""),
          score: num(r?.score),
          tier: String(r?.tier ?? "contained").slice(0, 20),
        }))
      : [],
  };
}

// Store an analysis built by the admin's browser from an exported rule file.
//
// The site's rules are not reachable from the backend yet: the Automation API needs scopes
// this app does not hold, and adding them requires the admin to re-consent. Meanwhile the
// same export file already gets produced weekly for the committed rule snapshot, so this
// takes the analysis the browser derived from that file. The whole 9 MB export never
// crosses the invoke boundary -- only the bounded document, around 130 KB.
//
// The payload is admin-supplied and therefore validated, not trusted. An admin can already
// read everything in it, so the risk is not disclosure; it is a malformed or oversized
// document wedging the tab for everyone, or a client-side cap regression quietly writing a
// value too large for KVS to hold. Caps are re-applied here rather than assumed.
export async function saveAutomationAnalysis({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const document = payload?.analysis;

    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("analysis must be an object");
    }
    if (document.schemaVersion !== 1) {
      throw new Error(`unsupported analysis schemaVersion: ${document.schemaVersion}`);
    }
    if (!document.estate || typeof document.estate !== "object") {
      throw new Error("analysis.estate is required");
    }

    const preview = Array.isArray(document.findingsPreview) ? document.findingsPreview : [];
    const cascades = Array.isArray(document.cascades) ? document.cascades : [];

    const stored = {
      schemaVersion: 1,
      // Server clock, not the browser's. A workstation with a skewed clock would otherwise
      // stamp an analysis as hours old or hours in the future, and the staleness warning
      // this drives is the reason anyone trusts the numbers.
      refreshedAt: Date.now(),
      source: typeof document.source === "string" ? document.source.slice(0, 64) : "unknown",
      estate: document.estate,
      // A short preview for the overview only; the full list lives under its own part.
      findingsPreview: preview.slice(0, MAX_PREVIEW_FINDINGS),
      // Totals describe the estate, not the truncated list, so they are taken from the
      // payload rather than recomputed from what survived slicing.
      findingsTotal: Number(document.findingsTotal) || preview.length,
      cascades: cascades.slice(0, MAX_STORED_CASCADES),
      cascadesTotal: Number(document.cascadesTotal) || cascades.length,
      selfTriggeringTotal: Number(document.selfTriggeringTotal) || 0,
      // The three cross-rule checks. These were computed by the analysis and then dropped
      // here, so the tab's tiles read 0 on every site whatever the rules did.
      ...storedCrossRule(document),
      // The blast-radius rollup: a tier histogram and the two health inputs. Small, and read
      // on first paint, so it rides here rather than costing a SQL round trip. The per-rule
      // scores are shredded into automation_rule_blast by the "blast" index part.
      blast: sanitizeBlastSummary(document.blast),
    };

    await writeAutomationAnalysis(installationKey, stored);

    logger.info("automation.analysis_saved", {
      installationKey,
      ruleCount: stored.estate?.ruleCount ?? null,
      findingsTotal: stored.findingsTotal,
      source: stored.source,
    });

    return { saved: true, refreshedAt: stored.refreshedAt };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("saveAutomationAnalysis failed:", error);
    throw error;
  }
}

// Store one of the supporting index documents: the field index, the status index, or the
// rule directory.
//
// Written separately from the analysis, and deliberately BEFORE it. The analysis document
// is what getAutomationInsights checks to decide whether anything has been built, so
// writing it last makes it the commit point: if the browser fails partway through an
// import, the tab keeps showing its empty state rather than an estate summary whose Fields
// section is missing or belongs to a previous build.
export async function saveAutomationIndex({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const part = payload?.part;
    const document = payload?.document;

    // The analysis has its own resolver, with its own validation and the server clock
    // stamp. Routing it through here would bypass both.
    if (part === "analysis" || !isAutomationIndexPart(part)) {
      throw new Error(`unknown automation index part: ${part}`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("document must be an object");
    }
    if (document.schemaVersion !== 1) {
      throw new Error(`unsupported index schemaVersion: ${document.schemaVersion}`);
    }

    // SQL-only parts skip the KVS copy entirely. Cascades are the reason that distinction
    // exists: 1,457 edges is precisely the shape that does not belong in a document with a
    // 240 KB ceiling, and the cap that ceiling forced is what this whole change removes.
    if (!SQL_ONLY_AUTOMATION_PARTS.has(part)) {
      await writeAutomationPart(installationKey, part, document);
    }

    // Also shred into SQL, where the caps do not apply and the cross-pillar join is a real
    // indexed query rather than a string match over a loaded document.
    //
    // The KVS write stays for now: the tab still reads documents, and keeping both means
    // this can land without a coordinated UI change. Best-effort by design -- a SQL failure
    // must not fail the import, because the KVS copy already succeeded and is what the UI
    // currently renders. It is logged rather than swallowed silently.
    let rowsWritten = null;
    try {
      if (part === "fields" || part === "statuses") {
        const other = part === "fields" ? "statuses" : "fields";
        const existing = await readAutomationPart(installationKey, other);
        rowsWritten = await replaceAutomationReferences(installationKey, {
          fields: part === "fields" ? document : existing,
          statuses: part === "statuses" ? document : existing,
        });
      } else if (part === "directory") {
        rowsWritten = await replaceAutomationRules(installationKey, document);
      } else if (part === "findings") {
        rowsWritten = await replaceAutomationFindings(installationKey, document);
      } else if (part === "cascades") {
        rowsWritten = await replaceAutomationCascades(installationKey, document);
      } else if (part === "blast") {
        rowsWritten = await replaceAutomationBlast(installationKey, document);
      }
    } catch (sqlError) {
      logger.warn("automation.sql_index_failed", {
        installationKey,
        part,
        error: String(sqlError?.message || sqlError),
      });
      // For the document-backed parts a SQL failure is recoverable: the KVS copy succeeded
      // and is what the tab currently renders. For a SQL-only part there is no second copy,
      // so swallowing it would leave the estate summary claiming cascades that were never
      // written and a Cascades section that is silently empty.
      if (SQL_ONLY_AUTOMATION_PARTS.has(part)) throw sqlError;
    }

    return { saved: true, part, rowsWritten };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("saveAutomationIndex failed:", error);
    throw error;
  }
}

// Parts that are written to SQL and nowhere else.
//
// Everything in AUTOMATION_PARTS has a KVS document behind it; cascades deliberately do not.
// Kept as its own set rather than a flag on the parts map so the map keeps meaning exactly
// "these have a storage key".
export const SQL_ONLY_AUTOMATION_PARTS = new Set(["cascades", "blast"]);

export function isAutomationIndexPart(part) {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_PARTS, part)
    || SQL_ONLY_AUTOMATION_PARTS.has(part);
}

// A page of cascades, filtered.
//
// The tab used to render whatever survived MAX_STORED_CASCADES -- 150 of this site's 1,457
// -- grouped in the browser. That grouping was only correct because the stored set WAS the
// whole page; grouping a page of a larger set splits one relationship across a page boundary
// and renders it twice. So both the filtering and the grouping happen in SQL, and the total
// counts groups rather than edges so a reader is never paged toward a number they cannot
// reach.
export async function getAutomationCascades({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const page = Math.max(1, Math.trunc(Number(payload?.page)) || 1);
    const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(payload?.pageSize)) || 50));

    const [summary, result] = await Promise.all([
      loadCascadeSummary(installationKey),
      loadCascades(installationKey, {
        search: String(payload?.search ?? "").slice(0, 200),
        kind: ["all", "self", "cross"].includes(payload?.kind) ? payload.kind : "all",
        ruleId: payload?.ruleId ? String(payload.ruleId) : null,
        direction: payload?.direction === "target" ? "target" : "source",
        field: payload?.field ? String(payload.field) : null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    ]);

    return {
      // Zero edges and no analysis are different states. A site whose rules genuinely
      // cascade nowhere should read as clean, not as unbuilt.
      available: summary.edges > 0,
      summary,
      cascades: result.cascades,
      total: result.total,
      page,
      pageSize,
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationCascades failed:", error);
    throw error;
  }
}

// The multi-rule picture: loops, and the chains that are not loops.
//
// This is what the cap made impossible rather than merely incomplete. A chain A -> B -> C is
// found by walking the edge set, and walking a set truncated at 150 finds chains that stop
// where the truncation did -- so the answer was not "fewer chains", it was "wrong chains".
//
// Computed on demand rather than stored. The walk is a few milliseconds over this site's
// 1,143 unique edges, and storing its output would mean a second thing to keep in step with
// the edges: a stored chain list and a re-imported estate can disagree, and a derived one
// cannot.
export async function getCascadeGraph({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const maxDepth = Math.max(2, Math.min(MAX_CHAIN_DEPTH, Math.trunc(Number(payload?.maxDepth)) || MAX_CHAIN_DEPTH));

    const edges = await loadCascadeEdges(installationKey);
    if (!edges.length) return { available: false, reason: "no-cascades" };

    // Names are attached after the walk rather than carried through it. The graph only needs
    // ids, and joining 1,457 rows to the directory to compute something that uses ids would
    // be paying for names on every edge to render them on a few hundred.
    const analysis = analyzeCascadeGraph(edges, { maxDepth });
    const involved = new Set([
      ...analysis.loops.flatMap((loop) => loop.ruleIds),
      ...analysis.chains.flatMap((chain) => chain.ruleIds),
    ]);
    const directory = await loadRuleDirectoryFor(installationKey, [...involved]);

    const hydrate = (step) => ({
      ...step,
      name: directory.get(String(step.id))?.name ?? step.name,
      enabled: directory.get(String(step.id))?.enabled ?? null,
    });

    return {
      available: true,
      ruleCount: analysis.ruleCount,
      edgeCount: analysis.edgeCount,
      rulesInLoops: analysis.rulesInLoops,
      deepestChain: analysis.deepestChain,
      // Reported, never silent. A truncated answer presented as complete is worse than a
      // smaller one that says what it left out.
      truncated: analysis.truncated,
      maxDepth,
      loops: analysis.loops.map((loop) => ({
        ...loop,
        ruleNames: loop.ruleIds.map((id) => directory.get(String(id))?.name ?? id),
        path: loop.path.map(hydrate),
      })),
      chains: analysis.chains.map((chain) => ({ ...chain, steps: chain.steps.map(hydrate) })),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getCascadeGraph failed:", error);
    throw error;
  }
}

// One page of rules ordered by blast radius, most first.
//
// The overview shows the tier histogram from the analysis document; this backs the
// sortable list and carries the factor breakdown so the drawer can explain a score without
// the raw rules it was built from.
export async function getAutomationBlast({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const page = Math.max(1, Math.trunc(Number(payload?.page)) || 1);
    const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(payload?.pageSize)) || 50));
    const tier = typeof payload?.tier === "string" ? payload.tier : null;
    const search = typeof payload?.search === "string" ? payload.search : "";

    const { rules, total } = await loadBlastRules(installationKey, {
      tier,
      search,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    return { available: total > 0 || page > 1, rules, total, page, pageSize };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationBlast failed:", error);
    throw error;
  }
}

// Which rules reference one status, by direction.
//
// The Workflows tab has been able to say "17 rules" against an unreachable status since the
// references moved to SQL, and a count is where the question starts rather than where it
// ends: an admin looking at a status they want to delete needs the rule names, and needs to
// know whether a rule TRANSITIONS INTO it -- which keeps it alive -- or merely reads it in a
// condition, which does not.
export async function getStatusAutomationUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const statusName = String(payload?.statusName ?? "").trim();
    if (!statusName) throw new Error("statusName is required");

    const hit = await loadAutomationReferencesFor(installationKey, "status", statusName)
      .catch(fallbackOn("automation.sql_status_reference_read_failed", () => null, { installationKey }));

    // No analysis and no references are different answers. "No rule touches this status" is
    // permission to delete it; "we have not looked" is not, and this pillar exists because
    // the two used to be indistinguishable.
    if (!hit) return { available: false, reason: "no-analysis", label: statusName };

    const group = (direction) => {
      const rows = hit.references.filter((r) => r.direction === direction);
      return {
        count: rows.length,
        rules: rows.map((r) => ({
          id: r.rule_id,
          name: r.name ?? `Rule ${r.rule_id}`,
          enabled: r.enabled === null || r.enabled === undefined ? null : r.enabled === 1,
        })),
      };
    };

    return {
      available: true,
      label: statusName,
      referenced: hit.total > 0,
      ruleCount: hit.ruleCount,
      // Direction is the whole point. A rule that transitions INTO a status keeps it in use;
      // one that reads it in a condition breaks if it disappears but does not keep it alive.
      write: group("write"),
      read: group("read"),
      trigger: group("trigger"),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getStatusAutomationUsage failed:", error);
    throw error;
  }
}

// A rule that creates an issue of a type, or scopes its trigger to one, names that type by
// numeric id -- only conditions and JQL carry the display name. So the issue-type index
// arrives labelled with a mix of ids and names, and the tab was rendering "10022" where the
// Issue Types tab says "Incident". Resolved here, against the issue-type inventory, rather
// than in the browser-side analysis: the id -> name map is the inventory's to own, and the
// analysis pipeline is shared with the backend importer which has no reason to load it.
//
// Relabelling can collide -- one rule referencing a type by id and another by name produces
// two entries that are the same type -- so entries that land on the same name are merged.
// Swap each entry's id label for a human name from `nameById`, merging any entries that
// land on the same name (an issue type a rule referenced by id AND another by name; two
// accounts that share a display name). Shared by the issue-type and user index resolvers.
export function relabelIndexEntries(entries, nameById) {
  if (!nameById.size) return entries;
  const merged = new Map();
  for (const entry of entries) {
    const label = nameById.get(String(entry.label)) ?? entry.label;
    const key = String(label).toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry, label });
      continue;
    }
    for (const dir of ["write", "read", "trigger"]) {
      existing[dir] = [...new Set([...(existing[dir] ?? []), ...(entry[dir] ?? [])])].slice(0, 50);
      existing[`${dir}Count`] = (existing[`${dir}Count`] ?? 0) + (entry[`${dir}Count`] ?? 0);
    }
    existing.total = existing.writeCount + existing.readCount + existing.triggerCount;
    existing.ruleCount = new Set([...existing.write, ...existing.read, ...existing.trigger]).size;
    existing.enabledRules = (existing.enabledRules ?? 0) + (entry.enabledRules ?? 0);
    existing.disabledRules = (existing.disabledRules ?? 0) + (entry.disabledRules ?? 0);
  }
  return [...merged.values()].sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
}

export async function resolveIssueTypeIndexLabels(installationKey, entries) {
  const meta = await readIssueTypeSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return entries;
  const types = await loadIssueTypes(installationKey, meta.version).catch(() => []);
  const nameById = new Map(types.map((t) => [String(t.id), t.name]).filter(([, name]) => name));
  return relabelIndexEntries(entries, nameById);
}

// An automation user index arrives keyed by accountId. Resolve those to display names from
// the licensed-user roster; an id with no roster row (a deleted or unlicensed account) is
// left as the id and reads as an orphaned reference.
export async function resolveUserIndexLabels(installationKey, entries) {
  const meta = await readUserSnapshotMeta(installationKey).catch(() => null);
  if (!meta?.version) return entries;
  const users = await loadUsers(installationKey, meta.version).catch(() => []);
  const nameById = new Map(users.map((u) => [String(u.accountId), u.displayName]).filter(([, name]) => name));
  return relabelIndexEntries(entries, nameById);
}

// Fetch a supporting index on demand. The field index is ~116 KB; sending it with the
// first paint would slow the tab for every visit that never opens the Fields section.
export async function getAutomationIndex({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const part = payload?.part;
    if (part === "analysis" || !Object.prototype.hasOwnProperty.call(AUTOMATION_PARTS, part)) {
      throw new Error(`unknown automation index part: ${part}`);
    }

    const document = await readAutomationPart(installationKey, part);
    if (!document) return { available: false, part, reason: "no-index" };

    const rawEntries = document.entries ?? [];
    const entries = part === "issueTypes"
      ? await resolveIssueTypeIndexLabels(installationKey, rawEntries)
      : part === "users"
        ? await resolveUserIndexLabels(installationKey, rawEntries)
        : rawEntries;

    return {
      available: true,
      part,
      total: entries === rawEntries ? (document.total ?? 0) : entries.length,
      entries,
      rules: document.rules ?? [],
      // Sent whole rather than paged. All 675 on the reference site are 144 KB in compact
      // form, which is one fetch the section already pays for; paging server-side would
      // mean a round trip per page and would make client-side filtering impossible without
      // re-querying on every keystroke.
      findings: document.findings ?? [],
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationIndex failed:", error);
    throw error;
  }
}

// Which automation rules touch one field.
//
// This is the join the whole automation pillar exists for. The Field Browser's other
// sections describe how a field is configured and how many issues carry a value; none of
// them can tell you that deleting it will break a rule. Answering that per field is what
// turns "735 fields are referenced" into something a person can act on.
//
// Resolved server-side rather than by shipping the field index to the browser: the index is
// 131 KB, the Field Browser shows ten fields a page, and only the expanded one needs an
// answer.
export async function getAutomationFieldUsage({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const fieldName = String(payload?.fieldName ?? "").trim();
    const fieldId = String(payload?.fieldId ?? "").trim();
    if (!fieldName && !fieldId) throw new Error("fieldName or fieldId is required");

    // SQL first. This is the read the move to rows was for: one indexed query returning
    // the references for this field, instead of loading a ~131 KB index plus a ~129 KB
    // directory and matching a lowercased string in memory -- the same cost whether the
    // question was about one field or all of them.
    //
    // Falls back to the documents when SQL has no rows for the label. An install that
    // imported before the tables existed still has its KVS copies and no rows, and would
    // otherwise be told "not referenced" -- the exact false reassurance this pillar exists
    // to prevent. The fallback goes when a re-import is guaranteed, not before.
    const sqlHit = await loadAutomationReferencesFor(installationKey, "field", fieldName || fieldId)
      .catch(fallbackOn("automation.sql_reference_read_failed", () => null, { installationKey }));

    if (sqlHit?.total > 0) {
      const group = (direction) => {
        const rows = sqlHit.references.filter((r) => r.direction === direction);
        return {
          count: rows.length,
          rules: rows.map((r) => ({
            id: r.rule_id,
            name: r.name ?? `Rule ${r.rule_id}`,
            enabled: r.enabled === null || r.enabled === undefined ? null : r.enabled === 1,
            triggerType: null,
          })),
        };
      };
      return {
        available: true,
        referenced: true,
        source: "sql",
        label: fieldName || fieldId,
        write: group("write"),
        read: group("read"),
        trigger: group("trigger"),
      };
    }

    const [index, directory] = await Promise.all([
      readAutomationPart(installationKey, "fields"),
      readAutomationPart(installationKey, "directory"),
    ]);

    // Distinct from "no rule touches this field". Saying "not referenced" with no analysis
    // behind it is exactly the false reassurance this pillar was built to stop.
    if (!index) return { available: false, reason: "no-analysis" };

    // Extraction records a name or an id depending on how the rule addressed the field, so
    // both are matched. Names are compared case-insensitively because rules are written by
    // hand and casing drifts.
    const wantedName = fieldName.toLowerCase();
    const entry = (index.entries ?? []).find((e) => {
      const label = String(e.label ?? "");
      return (wantedName && label.toLowerCase() === wantedName) || (fieldId && label === fieldId);
    });

    if (!entry) return { available: true, referenced: false };

    const byId = new Map(
      (directory?.rules ?? []).map(([id, name, enabled, triggerType]) => [
        id,
        { id, name, enabled: enabled === 1, triggerType: triggerType || null },
      ])
    );
    // A rule missing from the directory still counts. Dropping it would understate the
    // dependency, which is the one direction this must never err in.
    const expand = (ids = [], count = 0) => ({
      count,
      rules: ids.map((id) => byId.get(id) ?? { id, name: `Rule ${id}`, enabled: null, triggerType: null }),
    });

    return {
      available: true,
      referenced: true,
      source: "kvs",
      label: entry.label,
      write: expand(entry.write, entry.writeCount),
      read: expand(entry.read, entry.readCount),
      trigger: expand(entry.trigger, entry.triggerCount),
    };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationFieldUsage failed:", error);
    throw error;
  }
}

// Automation rule counts for a page of fields, in one call.
//
// The Field Browser shows ten fields at a time and the counts sit on the collapsed header,
// so they are needed for every row before anyone expands anything. Ten separate lookups
// would each re-read the same 131 KB index; this reads it once and answers for the page.
//
// Only counts come back. The rule names belong to getAutomationFieldUsage, which runs when
// a card is actually expanded.
export const MAX_BATCH_FIELDS = 100;

export async function getAutomationFieldCounts({ payload, context }) {
  incrMetric(METRIC_NAMES.resolver);
  try {
    const installationKey = getInstallationKey(context);
    const requested = Array.isArray(payload?.fields) ? payload.fields.slice(0, MAX_BATCH_FIELDS) : [];
    if (requested.length === 0) return { available: true, counts: {} };

    const index = await readAutomationPart(installationKey, "fields");
    if (!index) return { available: false, reason: "no-analysis", counts: {} };

    // One pass over the index rather than a scan per field: the page asks about ten fields
    // and the index holds hundreds.
    const byLabel = new Map();
    for (const entry of index.entries ?? []) {
      byLabel.set(String(entry.label ?? "").toLowerCase(), entry);
    }

    const counts = {};
    for (const field of requested) {
      const id = String(field?.id ?? "");
      const name = String(field?.name ?? "");
      if (!id && !name) continue;
      const entry = byLabel.get(name.toLowerCase()) ?? byLabel.get(id.toLowerCase());
      // Keyed on the field id the caller sent, so the client does not have to re-match.
      counts[id || name] = entry
        ? {
            enabled: entry.enabledRules ?? 0,
            disabled: entry.disabledRules ?? 0,
            total: entry.ruleCount ?? 0,
          }
        : { enabled: 0, disabled: 0, total: 0 };
    }

    return { available: true, counts };
  } catch (error) {
    incrMetric(METRIC_NAMES.resolverFailed);
    console.error("getAutomationFieldCounts failed:", error);
    throw error;
  }
}

export async function probeAutomationApi({ context }) {
  incrMetric(METRIC_NAMES.resolver);
  const installationKey = getInstallationKey(context);

  // One real project id, because the legacy rule endpoint is project-scoped.
  let projectId = null;
  try {
    const projects = await getAllJiraProjects();
    projectId = projects?.[0]?.id ? String(projects[0].id) : null;
  } catch (error) {
    logger.warn("automation-probe.project_lookup_failed", { error: String(error?.message || error) });
  }

  // Both scopes are probed, because rules live in two places and the goal is to extract
  // the JSON for all of them. GLOBAL is a pseudo-project id in the legacy Code Barrel
  // scheme -- global rules are addressed as if they belonged to a project called GLOBAL.
  const candidates = [
    { scope: "global", path: "/rest/cb-automation/latest/project/GLOBAL/rule" },
    { scope: "global", path: "/rest/cb-automation/latest/rule" },
    { scope: "global", path: "/rest/api/3/automation/rule" },
    ...(projectId
      ? [{ scope: "project", path: `/rest/cb-automation/latest/project/${projectId}/rule` }]
      : []),
  ];

  // The automation API lives on api.atlassian.com, not on the site. Every site-relative
  // path returned 401 because it was asked of the wrong server -- requestJira cannot reach
  // the gateway, so those go through Stargate instead.
  const cloudId = getCloudId(context);
  if (cloudId) {
    candidates.push(
      { scope: "global", via: "stargate", path: `https://api.atlassian.com/automation/public/jira/${cloudId}/rest/v1/rule` },
      { scope: "global", via: "stargate", path: `https://api.atlassian.com/automation/public/jira/${cloudId}/rest/v1/rule/search` },
      // Gateway-relative as well, in case Stargate prefixes the host itself. One of the
      // two forms will be accepted and the other will say why it was not.
      { scope: "global", via: "stargate", path: `/automation/public/jira/${cloudId}/rest/v1/rule` },
    );
  }

  const results = [];
  for (const { scope, path, via } of candidates) {
    const result = via === "stargate" ? await probeStargateEndpoint(path) : await probeEndpoint(path);
    // A 200 is not the same as usable JSON -- Jira can answer with an HTML login page or
    // an error envelope. Record whether the body actually looks like a rule collection.
    const looksLikeRules = /"(rules|values|id)"\s*:/.test(result.sample || "");
    results.push({ ...result, scope, via: via || "site", looksLikeRules });
    logger.info("automation-probe.result", {
      scope, via: via || "site", path: result.path, status: result.status,
      ok: result.ok, ms: result.ms, looksLikeRules, sample: result.sample,
    });
  }

  const reachable = results.filter((r) => r.ok && r.looksLikeRules);
  logger.info("automation-probe.summary", {
    installationKey,
    probed: results.length,
    reachable: reachable.length,
    reachablePaths: reachable.map((r) => r.path),
  });

  return { projectId, cloudId, results, reachable: reachable.map((r) => r.path) };
}

// ── Rovo: automation expert ──────────────────────────────────────────────────
//
// The agent answers only from the stored analysis. It has no route to the live rules, so
// every path here reports the analysis's own staleness and returns an explicit
// "analysis-unavailable" rather than an empty result -- an agent that says "no rules use
// that field" when nothing has been analyzed is worse than one that says it does not know,
// because the user acts on the first and asks again after the second.

export async function loadAutomationForAgent(installationKey) {
  const [analysis, fields, statuses, directory, findings, config] = await Promise.all([
    readAutomationAnalysis(installationKey),
    readAutomationPart(installationKey, "fields"),
    readAutomationPart(installationKey, "statuses"),
    readAutomationPart(installationKey, "directory"),
    readAutomationPart(installationKey, "findings"),
    // The staleness threshold travels with the data, so no caller can forget to apply it.
    readAdminConfig().catch(() => null),
  ]);
  const staleAfterDays = Number(config?.automationStaleAfterDays) || DEFAULT_ANALYSIS_STALE_AFTER_DAYS;
  return { analysis, fields, statuses, directory, findings, staleAfterDays };
}

export function ruleDirectoryMap(directory) {
  return new Map(
    (directory?.rules ?? []).map(([id, name, enabled, triggerType, projectCount]) => [
      id,
      { id, name, enabled: enabled === 1, triggerType: triggerType || null, projectCount },
    ])
  );
}
