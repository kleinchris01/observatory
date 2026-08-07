import React from "react";
import { invoke } from "@forge/bridge";
import { EmptyState } from "../components/ui";

// Per-project field usage view.

const ProjectsTabView = React.lazy(() => import("../components/ProjectsTab").then((m) => ({ default: m.ProjectsTabView })));

export function ProjectUsageTab({ siteOrigin }) {
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
      if (!cancelled) {
        setData(result);
        if (result?.selectedProject?.projectId && result.selectedProject.projectId !== selectedProjectId) {
          setSelectedProjectId(result.selectedProject.projectId);
        }
      }
    }).catch((err) => {
      if (!cancelled) setLoadError(err.message || "Failed to load project usage.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, deferredProjectQuery, deferredFieldQuery, fieldType, fieldSort, page]);

  function handleSelectProject(projectId) {
    setSelectedProjectId(projectId);
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
        />
      </React.Suspense>
    </>
  );
}
