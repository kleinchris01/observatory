export function getFieldNumericId(fieldId) {
  const match = String(fieldId || "").match(/customfield_(\d+)/);
  return match ? match[1] : null;
}

export function getFieldTypeLabel(field = {}) {
  const customType = field.schema?.custom;
  const primitiveType = field.schema?.type;
  const systemKey = field.schema?.system;

  if (customType) {
    const suffix = customType.split(":").pop() || customType;
    return suffix.replace(/-/g, " ");
  }

  if (systemKey) {
    return systemKey.charAt(0).toUpperCase() + systemKey.slice(1);
  }

  return primitiveType || "unknown";
}

export function buildFieldJql(fieldId, projectKey) {
  const numericId = getFieldNumericId(fieldId);
  const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
  const safeProjectKey = String(projectKey || "").replace(/"/g, '\\"');
  return `project = "${safeProjectKey}" AND ${fieldSelector} is not EMPTY`;
}

export function buildOverallFieldJql(fieldId) {
  const numericId = getFieldNumericId(fieldId);
  const fieldSelector = numericId ? `cf[${numericId}]` : fieldId;
  return `${fieldSelector} is not EMPTY`;
}

export function summarizeContexts({
  contexts = [],
  projectMappings = [],
  issueTypeMappings = [],
  projectLookup = new Map(),
}) {
  const byContextId = new Map();

  for (const context of contexts) {
    byContextId.set(String(context.id), {
      id: String(context.id),
      name: context.name || `Context ${context.id}`,
      description: context.description || "",
      isGlobalContext: Boolean(context.isGlobalContext),
      isAnyIssueType: Boolean(context.isAnyIssueType),
      projectIds: [],
      projects: [],
      issueTypeIds: [],
      projectCount: 0,
      issueTypeCount: 0,
    });
  }

  for (const mapping of projectMappings) {
    const bucket = byContextId.get(String(mapping.contextId));
    if (!bucket) continue;

    if (mapping.projectId) {
      const project = projectLookup.get(String(mapping.projectId));
      bucket.projectIds.push(String(mapping.projectId));
      bucket.projects.push({
        id: String(mapping.projectId),
        key: project?.key || "UNKNOWN",
        name: project?.name || "Unknown project",
      });
    } else if (mapping.isGlobalContext) {
      bucket.isGlobalContext = true;
    }
  }

  for (const mapping of issueTypeMappings) {
    const bucket = byContextId.get(String(mapping.contextId));
    if (!bucket) continue;
    if (mapping.issueTypeId) {
      bucket.issueTypeIds.push(String(mapping.issueTypeId));
    } else if (mapping.isAnyIssueType) {
      bucket.isAnyIssueType = true;
    }
  }

  return Array.from(byContextId.values())
    .map((context) => ({
      ...context,
      projectCount: context.isGlobalContext ? context.projectIds.length : context.projects.length,
      issueTypeCount: context.isAnyIssueType ? 0 : context.issueTypeIds.length,
    }))
    .sort((left, right) => {
      if (left.isGlobalContext !== right.isGlobalContext) {
        return left.isGlobalContext ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

export function extractLatestFieldChange(changelogPayload, fieldId) {
  const numericId = getFieldNumericId(fieldId);
  let latest = null;

  function visit(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (typeof node !== "object") return;

    if (Array.isArray(node.items) && node.created) {
      const matches = node.items.some(
        (item) =>
          item?.fieldId === fieldId ||
          item?.fieldId === numericId ||
          item?.field === fieldId ||
          item?.field === numericId,
      );

      if (matches) {
        const createdAt = new Date(node.created).toISOString();
        if (!latest || createdAt > latest) latest = createdAt;
      }
    }

    for (const value of Object.values(node)) visit(value);
  }

  visit(changelogPayload);
  return latest;
}

export function buildProjectUsageRecord({ project, fieldId, issueCount, latestFieldChangeAt, latestIssue }) {
  return {
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    issueCount,
    jql: buildFieldJql(fieldId, project.key),
    latestFieldChangeAt: latestFieldChangeAt || latestIssue?.updated || null,
    latestIssueKey: latestIssue?.key || null,
    latestIssueUpdatedAt: latestIssue?.updated || null,
  };
}
