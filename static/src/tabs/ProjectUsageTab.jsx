import React from "react";
import { invoke } from "@forge/bridge";
import { EmptyState } from "../components/ui";
import { useNavIntent } from "../hooks";

// Per-project field usage view.

const ProjectsTabView = React.lazy(() => import("../components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView })));

export function ProjectUsageTab({ siteOrigin, intent = null, onBuildFieldReport }) {
  const [projectQuery, setProjectQuery] = React.useState("");
  const [deferredProjectQuery, setDeferredProjectQuery] = React.useState("");
  const [fieldQuery, setFieldQuery] = React.useState("");
  const [deferredFieldQuery, setDeferredFieldQuery] = React.useState("");
  const [fieldType, setFieldType] = React.useState("all");
  const [fieldSort, setFieldSort] = React.useState("issues-desc");
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  // Which finding the reader arrived from. Applied to the rail rather than to the query:
  // the rail already holds every project the reader may browse, and the thresholds are a
  // function of that list.
  const [projectFilter, setProjectFilter] = React.useState("all");

  useNavIntent(intent, (nav) => {
    setProjectFilter(nav.filter ?? "all");
    setProjectQuery("");
  });

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredProjectQuery(projectQuery); }, 350);
    return () => clearTimeout(t);
  }, [projectQuery]);

  React.useEffect(() => {
    const t = setTimeout(() => { setDeferredFieldQuery(fieldQuery); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [fieldQuery]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    invoke("getProjectsView", {
      projectId: selectedProjectId,
      projectQuery: deferredProjectQuery,
      fieldQuery: deferredFieldQuery,
      fieldType,
      sortBy: fieldSort,
      page,
    }).then((result) => {
      // No auto-adopt: the old rail always had a project selected, so the resolver returns a
      // default one and the container used to sync to it. With the browse list, "" (nothing
      // expanded) is a real state -- adopting the default here reopened a card the moment the
      // user closed it.
      if (!cancelled) setData(result);
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load project usage.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, deferredProjectQuery, deferredFieldQuery, fieldType, fieldSort, page]);


  // Everything that touches the selected project, across every pillar. Its own call rather
  // than folded into getProjectsView: that resolver pages a field list and is re-run on
  // every keystroke of the field search, and none of those re-runs change the pillars.
  const [overview, setOverview] = React.useState(null);
  const [overviewLoading, setOverviewLoading] = React.useState(false);
  const selectedProjectKey = data?.selectedProject?.projectId === selectedProjectId
    ? data?.selectedProject?.projectKey
    : null;

  React.useEffect(() => {
    if (!selectedProjectId) return undefined;
    let cancelled = false;
    setOverviewLoading(true);
    invoke("getProjectOverview", { projectId: selectedProjectId, projectKey: selectedProjectKey || undefined })
      .then((result) => { if (!cancelled) setOverview(result); })
      .catch(() => { if (!cancelled) setOverview(null); })
      .finally(() => { if (!cancelled) setOverviewLoading(false); });
    return () => { cancelled = true; };
  }, [selectedProjectId, selectedProjectKey]);

  // "" collapses the open card. The browse list is always visible now, so selecting nothing
  // is a real state rather than the old "nothing in the right pane".
  function handleSelectProject(projectId) {
    setSelectedProjectId(projectId || "");
    setPage(1);
  }

  return (
    <>
      {loadError && <div className="error-banner">{loadError}</div>}
      <React.Suspense fallback={<EmptyState>Loading…</EmptyState>}>
        <ProjectsTabView
          data={data}
          loading={loading}
          siteOrigin={siteOrigin}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          projectQuery={projectQuery}
          onProjectQueryChange={setProjectQuery}
          fieldQuery={fieldQuery}
          onFieldQueryChange={(v) => { setFieldQuery(v); }}
          fieldType={fieldType}
          onFieldTypeChange={(v) => { setFieldType(v); setPage(1); }}
          fieldSort={fieldSort}
          onFieldSortChange={(v) => { setFieldSort(v); setPage(1); }}
          onChangePage={setPage}
          overview={overview}
          overviewLoading={overviewLoading}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          onBuildFieldReport={onBuildFieldReport}
        />
      </React.Suspense>
    </>
  );
}
