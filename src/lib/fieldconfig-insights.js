// Analysis over the field behaviour model (fieldconfig-engine.js), run once at build time and
// stored, so no resolver ever re-reads every item row. Pure functions: no I/O, no Forge SQL.
//
// What it finds, in both models unless noted:
//
//   unused          a non-default scheme no project uses; a legacy field configuration no
//                   used scheme maps to. Configuration nobody sees, still maintained.
//   duplicate       a scheme or configuration identical to another. Every change has to be
//                   made twice, and the second one is forgotten.
//   required-hidden legacy only: a field both required and hidden in one configuration. No
//                   one can fill it in, so every create or edit through that configuration
//                   fails. Field schemes cannot express this, which is part of why they exist.
//   inconsistent    a field required in some places and optional in others. Not scored --
//                   sometimes deliberate -- but the first thing to check when "it's required
//                   in one project and not the other" is the complaint.
//
// An owner (scheme or configuration) whose fields were not read is "unmeasured": it is left
// out of every rate that needs its contents, never counted as clean.

export const SOURCE_LABEL = {
  "field-schemes": "Field schemes",
  "field-configurations": "Field configurations (legacy)",
};

// FNV-1a over a string: stable, cheap, and plenty for grouping identical item sets.
export function fingerprint(parts) {
  let h = 0x811c9dc5;
  const text = parts.join("\n");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${parts.length}:${h.toString(16)}`;
}

function itemKey(item) {
  return [
    item.fieldId,
    item.workTypeId,
    item.hidden ? "H" : "",
    item.required ? "R" : "",
    item.renderer || "",
    item.description || "",
    (item.restrictedTo || []).slice().sort().join(","),
  ].join("|");
}

function groupDuplicates(owners) {
  const byPrint = new Map();
  for (const owner of owners) {
    if (!owner.print) continue;
    if (!byPrint.has(owner.print)) byPrint.set(owner.print, []);
    byPrint.get(owner.print).push(owner);
  }
  return [...byPrint.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = group
        .slice()
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (b.projectCount || 0) - (a.projectCount || 0));
      return { key: sorted[0].id, keep: sorted[0].id, members: sorted.map((o) => o.id) };
    });
}

export function analyzeFieldBehaviour({
  source,
  schemes = [],
  schemeProjects = [],
  configs = [],
  mappings = [],
  items = [],
} = {}) {
  const legacy = source === "field-configurations";
  const itemsByOwner = new Map();
  for (const item of items) {
    const key = `${item.ownerKind}:${item.ownerId}`;
    if (!itemsByOwner.has(key)) itemsByOwner.set(key, []);
    itemsByOwner.get(key).push(item);
  }
  const ownerItems = (kind, id) => itemsByOwner.get(`${kind}:${id}`) || [];

  const projectCount = new Map();
  for (const row of schemeProjects) projectCount.set(row.schemeId, (projectCount.get(row.schemeId) || 0) + 1);
  const usedSchemes = new Set([...projectCount.keys()]);

  // ── Configurations (legacy) ──
  const usedConfigs = new Set(mappings.filter((m) => usedSchemes.has(m.schemeId)).map((m) => m.configId));
  const configRows = configs.map((config) => {
    const own = ownerItems("config", config.id);
    const requiredHidden = config.itemsRead ? own.filter((i) => i.required && i.hidden).map((i) => i.fieldId) : [];
    return {
      ...config,
      used: usedConfigs.has(config.id),
      requiredCount: own.filter((i) => i.required).length,
      hiddenCount: own.filter((i) => i.hidden).length,
      requiredHidden,
      print: config.itemsRead ? fingerprint(own.map(itemKey).sort()) : null,
    };
  });
  const configDupes = groupDuplicates(configRows);
  const configGroupOf = new Map();
  for (const group of configDupes) for (const id of group.members) configGroupOf.set(id, group.key);

  // ── Schemes ──
  const mappingsByScheme = new Map();
  for (const m of mappings) {
    if (!mappingsByScheme.has(m.schemeId)) mappingsByScheme.set(m.schemeId, []);
    mappingsByScheme.get(m.schemeId).push(m);
  }
  const configById = new Map(configRows.map((c) => [c.id, c]));

  const schemeRows = schemes.map((scheme) => {
    const used = usedSchemes.has(scheme.id);
    let print = null;
    let measured;
    if (legacy) {
      // A legacy scheme only routes; two schemes routing every work type to identical
      // configurations are the same scheme, so a configuration counts by its duplicate group.
      const routes = mappingsByScheme.get(scheme.id) || [];
      measured = routes.every((m) => configById.get(m.configId)?.itemsRead);
      print =
        routes.length && measured
          ? fingerprint(routes.map((m) => `${m.workTypeId}->${configGroupOf.get(m.configId) || m.configId}`).sort())
          : null;
    } else {
      measured = Boolean(scheme.fieldsRead);
      print = measured ? fingerprint(ownerItems("scheme", scheme.id).map(itemKey).sort()) : null;
    }
    const own = legacy ? [] : ownerItems("scheme", scheme.id);
    return {
      ...scheme,
      projectCount: projectCount.get(scheme.id) || 0,
      used,
      measured,
      requiredCount: own.filter((i) => i.workTypeId === "*" && i.required).length,
      restrictedCount: own.filter((i) => i.workTypeId === "*" && (i.restrictedTo || []).length > 0).length,
      print,
    };
  });
  const schemeDupes = groupDuplicates(schemeRows);

  const dupOf = (groups) => {
    const out = new Map();
    for (const g of groups) for (const id of g.members) if (id !== g.keep) out.set(id, g.keep);
    return out;
  };
  const schemeDupOf = dupOf(schemeDupes);
  const configDupOf = dupOf(configDupes);

  const findingsFor = (row, kind) => {
    const codes = [];
    if (!row.isDefault && !row.used) codes.push("unused");
    const dupOfId = (kind === "scheme" ? schemeDupOf : configDupOf).get(row.id);
    if (dupOfId) codes.push("duplicate");
    if (kind === "config" && row.requiredHidden.length) codes.push("required-hidden");
    if (kind === "config" ? !row.itemsRead : !row.measured) codes.push("unmeasured");
    return { codes, duplicateOf: dupOfId || null };
  };

  const finalSchemes = schemeRows.map((row) => ({ ...row, ...findingsFor(row, "scheme") }));
  const finalConfigs = configRows.map((row) => ({ ...row, ...findingsFor(row, "config") }));

  // ── Inconsistent requiredness, across what projects actually use ──
  const requiredIn = new Map();
  const optionalIn = new Map();
  const note = (map, fieldId, owner) => {
    if (!map.has(fieldId)) map.set(fieldId, new Set());
    map.get(fieldId).add(owner);
  };
  if (legacy) {
    const readUsed = finalConfigs.filter((c) => c.used && c.itemsRead);
    const requiredByConfig = new Map(
      readUsed.map((c) => [
        c.id,
        new Set(
          ownerItems("config", c.id)
            .filter((i) => i.required)
            .map((i) => i.fieldId),
        ),
      ]),
    );
    const anyRequired = new Set([...requiredByConfig.values()].flatMap((s) => [...s]));
    for (const fieldId of anyRequired) {
      for (const [configId, set] of requiredByConfig)
        note(set.has(fieldId) ? requiredIn : optionalIn, fieldId, configId);
    }
  } else {
    for (const scheme of finalSchemes.filter((s) => s.used && s.measured)) {
      for (const item of ownerItems("scheme", scheme.id).filter((i) => i.workTypeId === "*")) {
        note(item.required ? requiredIn : optionalIn, item.fieldId, scheme.id);
      }
    }
  }
  const inconsistentRequired = [...requiredIn.keys()]
    .filter((fieldId) => optionalIn.has(fieldId))
    .map((fieldId) => ({ fieldId, requiredIn: requiredIn.get(fieldId).size, optionalIn: optionalIn.get(fieldId).size }))
    .sort((a, b) => b.requiredIn + b.optionalIn - (a.requiredIn + a.optionalIn));

  const nonDefaultSchemes = finalSchemes.filter((s) => !s.isDefault);
  const nonDefaultConfigs = finalConfigs.filter((c) => !c.isDefault);
  const measuredOwners = [...finalSchemes.filter((s) => s.measured), ...finalConfigs.filter((c) => c.itemsRead)];

  const summary = {
    source,
    schemeCount: finalSchemes.length,
    configCount: finalConfigs.length,
    // Usage: judged on every non-default scheme and configuration -- contents not needed.
    usageJudged: nonDefaultSchemes.length + nonDefaultConfigs.length,
    unusedSchemes: nonDefaultSchemes.filter((s) => !s.used).length,
    unusedConfigs: nonDefaultConfigs.filter((c) => !c.used).length,
    // Duplicates: judged only where contents were read.
    duplicateJudged: measuredOwners.length,
    duplicateGroups: schemeDupes.length + configDupes.length,
    reducible: schemeDupOf.size + configDupOf.size,
    // Required-and-hidden: legacy only; null on field schemes, which cannot express it.
    conflictJudged: legacy ? finalConfigs.filter((c) => c.itemsRead).length : null,
    requiredHiddenConfigs: legacy ? finalConfigs.filter((c) => c.requiredHidden.length).length : null,
    requiredHiddenPairs: legacy ? finalConfigs.reduce((n, c) => n + c.requiredHidden.length, 0) : null,
    unmeasured: finalSchemes.filter((s) => !s.measured).length + finalConfigs.filter((c) => !c.itemsRead).length,
    inconsistentRequiredFields: inconsistentRequired.length,
  };

  return {
    schemes: finalSchemes,
    configs: finalConfigs,
    duplicateGroups: { schemes: schemeDupes, configs: configDupes },
    inconsistentRequired: inconsistentRequired.slice(0, 200),
    summary,
  };
}

// The Overview/health input from a stored summary. `available` false when no build has
// completed, so the dimensions say so rather than scoring a site nobody has looked at.
export function summarizeFieldConfigHealth(meta, summary) {
  if (!meta?.version || !summary) return { available: false };
  return { available: true, refreshedAt: meta.refreshedAt || null, ...summary };
}
