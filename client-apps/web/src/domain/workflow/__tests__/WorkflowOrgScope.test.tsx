/**
 * Pins how the web workflow pages name organizations: the list, the
 * executions list, the new-workflow editor and the detail page's viewer org
 * all use the active organization's id, the way the server names every org;
 * a list row's Organization column shows the stored org id through
 * OrgSlugText; and a row's "Copy reference" copies `<org slug>/<slug>`.
 * The views and the workbench are pinned in @stigmer/react.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

interface Row {
  id: string;
  org: string;
  slug: string;
  name: string;
}

interface WorkbenchProps {
  org: string | null;
  columns: Array<{ id: string; cell: (item: Row) => ReactNode }>;
  renderItemAction?: (item: Row) => ReactNode;
}

const ROW: Row = {
  id: "wfl_1",
  org: "org_acme",
  slug: "nightly",
  name: "Nightly",
};

const page = vi.hoisted(() => ({
  workbench: [] as WorkbenchProps[],
  props: new Map<string, Record<string, unknown>>(),
  architectOrg: [] as Array<string | null>,
  executionListOrg: [] as Array<string | null>,
  instancesOrg: [] as string[],
}));

vi.mock("@stigmer/react", () => {
  const capture = (name: string) => (props: Record<string, unknown>) => {
    page.props.set(name, props);
    return null;
  };
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  );
  const ActionMenu = Object.assign(Passthrough, {
    Trigger: () => null,
    Content: Passthrough,
    Separator: () => null,
    Item: ({
      children,
      onSelect,
    }: {
      children?: ReactNode;
      onSelect: () => void;
    }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
  });
  const workflow = {
    list: async () => ({ items: [] }),
    delete: async () => undefined,
  };
  return {
    ResourceWorkbench: (props: WorkbenchProps) => {
      page.workbench.push(props);
      return (
        <div>
          {props.columns.map((column) => (
            <div key={column.id} data-column={column.id}>
              {column.cell(ROW)}
            </div>
          ))}
          {props.renderItemAction?.(ROW)}
        </div>
      );
    },
    ActionMenu,
    ApplyManifestDialog: () => null,
    ConfirmDialog: () => null,
    Button: Passthrough,
    WorkflowExecutionPhaseBadge: () => null,
    // A stand-in that shows which org id the column handed it.
    OrgSlugText: ({ orgId }: { orgId: string }) => <span>slug of {orgId}</span>,
    WorkflowEditorView: capture("WorkflowEditorView"),
    WorkflowArchitectDialog: () => null,
    WorkflowTemplateGallery: () => null,
    WorkflowDetailView: capture("WorkflowDetailView"),
    WorkflowRunDialog: () => null,
    CreateWorkflowInstanceDialog: () => null,
    STARTER_WORKFLOW_YAML: "document: {}",
    WORKFLOW_TEMPLATES: [],
    useStigmer: () => ({ workflow }),
    useActiveOrgId: () => "org_acme",
    // The person's organizations: org_acme reads "acme".
    useOrgSlugForId: () => (id: string) => (id === "org_acme" ? "acme" : id),
    useConfirmAction: () => ({
      confirmState: null,
      confirm: async () => false,
      handleConfirm: () => undefined,
      handleCancel: () => undefined,
    }),
    useBreadcrumbOverride: () => ({ setLabel: () => undefined }),
    useElkLayoutEngine: () => undefined,
    useWorkflowArchitect: (org: string | null) => {
      page.architectOrg.push(org);
      return { availability: "unavailable" };
    },
    useWorkflowExecutionList: ({ org }: { org: string | null }) => {
      page.executionListOrg.push(org);
      return {
        executions: [],
        isLoading: false,
        error: null,
        hasMore: false,
        loadMore: () => undefined,
        isLoadingMore: false,
        loadMoreError: null,
      };
    },
    useWorkflow: () => ({ workflow: { metadata: { id: "wfl_1" } } }),
    useWorkflowYaml: () => ({ yaml: null }),
    useWorkflowInstances: (_workflowId: string | undefined, org: string) => {
      page.instancesOrg.push(org);
      return { instances: [], refetch: () => undefined };
    },
    useCopyResource: () => ({
      copyId: () => undefined,
      copyQualifiedSlug: () => undefined,
    }),
    useDeleteResource: () => ({
      deleteResource: async () => undefined,
      isDeleting: false,
    }),
    useDeleteWorkflowInstance: () => ({
      deleteInstance: async () => undefined,
    }),
    useExportResource: () => ({
      copyYaml: () => undefined,
      copyJson: () => undefined,
      downloadYaml: () => undefined,
    }),
    toast: { success: () => undefined, error: () => undefined },
  };
});

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

vi.mock("@/domain/library/library-navigation", () => ({
  useLibraryNavigation: () => ({ navigateToDetail: () => undefined }),
  useRouteDetailYieldsToOverlay: () => false,
}));

vi.mock("@/domain/library/full-viewport-layout", () => ({
  useRequestFullViewport: () => undefined,
}));

vi.mock("@/domain/workflow/execution-navigation", () => ({
  useExecutionNavigation: () => ({ navigateToExecution: () => undefined }),
}));

import { WorkflowListPage } from "../WorkflowListPage";
import { WorkflowNewPage } from "../WorkflowNewPage";
import { WorkflowDetailPageInner } from "../WorkflowDetailPage";
import { WorkflowExecutionListPage } from "../WorkflowExecutionListPage";

let copied: string[] = [];

beforeEach(() => {
  page.workbench.length = 0;
  page.props.clear();
  page.architectOrg.length = 0;
  page.executionListOrg.length = 0;
  page.instancesOrg.length = 0;
  copied = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    async (text: string) => {
      copied.push(text);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web WorkflowListPage", () => {
  it("lists the active org by its id", () => {
    render(<WorkflowListPage />);

    expect(page.workbench.at(-1)?.org).toBe("org_acme");
  });

  it("shows a row's org through OrgSlugText, from the id the row names it by", () => {
    render(<WorkflowListPage />);

    expect(document.querySelector('[data-column="org"]')?.textContent).toBe(
      "slug of org_acme",
    );
  });

  it("copies the row's reference under its org's slug", () => {
    render(<WorkflowListPage />);

    fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));

    expect(copied).toEqual(["acme/nightly"]);
  });
});

describe("web WorkflowNewPage", () => {
  it("asks for the architect and edits the new workflow in the active org id", () => {
    render(<WorkflowNewPage />);

    expect(page.architectOrg).toContain("org_acme");
    fireEvent.click(screen.getByRole("button", { name: /Visual Editor/ }));
    expect(page.props.get("WorkflowEditorView")?.org).toBe("org_acme");
  });
});

describe("web WorkflowDetailPageInner", () => {
  it("shows the workflow where it lives and scopes the viewer and instances to the active org id", () => {
    render(<WorkflowDetailPageInner org="other" slug="nightly" />);

    expect(page.props.get("WorkflowDetailView")).toMatchObject({
      org: "other",
      slug: "nightly",
      viewerOrg: "org_acme",
    });
    expect(page.instancesOrg.at(-1)).toBe("org_acme");
  });
});

describe("web WorkflowExecutionListPage", () => {
  it("lists the active org's executions by its id", () => {
    render(<WorkflowExecutionListPage />);

    expect(page.executionListOrg.at(-1)).toBe("org_acme");
  });
});
