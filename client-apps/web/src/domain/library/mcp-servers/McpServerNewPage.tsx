"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  McpServerCreationWizard,
  CreationPicker,
  ApplyManifestDialog,
  MCP_SERVER_TEMPLATES,
  useActiveOrgId,
  useOrgSlugForId,
  useBreadcrumbOverride,
} from "@stigmer/react";
import type { CreationPath } from "@stigmer/react";
import type { McpServerWizardData } from "@stigmer/react";

type PageState =
  | { readonly phase: "picking" }
  | {
      readonly phase: "wizard";
      readonly initialData?: Partial<McpServerWizardData>;
    };

/**
 * Console page for creating a new MCP server.
 *
 * Mounted at `/library/mcp-servers/new`. Shows a creation picker
 * ("step 0") with three paths — blank, template, or import. Selecting
 * blank or a template transitions to the `McpServerCreationWizard`
 * with optional pre-filled data. Import opens the `ApplyManifestDialog`.
 */
export function McpServerNewPage() {
  const org = useActiveOrgId();
  const slugForOrg = useOrgSlugForId();
  const router = useRouter();
  const { setLabel } = useBreadcrumbOverride();

  const [state, setState] = useState<PageState>({ phase: "picking" });
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    setLabel("New MCP server");
  }, [setLabel]);

  const handlePickerSelect = useCallback((path: CreationPath) => {
    switch (path.kind) {
      case "scratch":
        setState({ phase: "wizard" });
        break;
      case "template":
        setState({
          phase: "wizard",
          initialData: path.data as Partial<McpServerWizardData>,
        });
        break;
      case "import":
        setImportOpen(true);
        break;
    }
  }, []);

  const handleWizardComplete = useCallback(
    (result: { org: string; slug: string }) => {
      router.push(`/library/mcp-servers/${slugForOrg(result.org)}/${result.slug}`);
    },
    [router, slugForOrg],
  );

  const handleCancel = useCallback(() => {
    if (state.phase === "wizard") {
      setState({ phase: "picking" });
    } else {
      router.push("/library/mcp-servers");
    }
  }, [state.phase, router]);

  if (!org) return null;

  return (
    <>
      {state.phase === "picking" ? (
        <CreationPicker
          resourceLabel="MCP server"
          templates={MCP_SERVER_TEMPLATES}
          onSelect={handlePickerSelect}
        />
      ) : (
        <McpServerCreationWizard
          org={org}
          initialData={state.initialData}
          onComplete={handleWizardComplete}
          onCancel={handleCancel}
          className="min-h-[480px]"
        />
      )}

      <ApplyManifestDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        org={org}
        onApplied={() => router.push("/library/mcp-servers")}
      />
    </>
  );
}
