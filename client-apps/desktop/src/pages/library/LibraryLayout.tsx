import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@stigmer/theme";
import { LibraryBreadcrumbProvider, useCanonicalOrgSlug } from "@stigmer/react";
import { LibraryBreadcrumb } from "./LibraryBreadcrumb";
import {
  FullViewportLayoutProvider,
  useFullViewportLayout,
} from "./full-viewport-layout";

export default function LibraryLayout() {
  return (
    <LibraryBreadcrumbProvider>
      <FullViewportLayoutProvider>
        <LibraryLayoutContent />
      </FullViewportLayoutProvider>
    </LibraryBreadcrumbProvider>
  );
}

/** `/library/<kind>/<org>/<slug>`: a detail route, whose org segment is a slug. */
const LIBRARY_DETAIL_RE =
  /^\/library\/(agents|skills|mcp-servers|workflows|schedules|plugins)\/([^/]+)\/([^/]+)\/?$/;

/**
 * Keeps a detail route's org segment on the org's current slug. A link
 * built from a stored org id, or one carrying a slug the org has since
 * been renamed away from, still opens the page (the server accepts
 * either); the URL is then replaced in place, with no new history entry,
 * by the one naming the current slug. The web console's library
 * navigation does the same.
 */
function useCanonicalLibraryUrl(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const [, kind = "", org = "", slug = ""] =
    location.pathname.match(LIBRARY_DETAIL_RE) ?? [];
  const canonicalOrg = useCanonicalOrgSlug(org);

  useEffect(() => {
    if (!org || !canonicalOrg || org === canonicalOrg) return;
    navigate(
      `/library/${kind}/${canonicalOrg}/${slug}${location.search}${location.hash}`,
      { replace: true },
    );
  }, [kind, org, slug, canonicalOrg, navigate, location.search, location.hash]);
}

function LibraryLayoutContent() {
  const { isFullViewport } = useFullViewportLayout();
  useCanonicalLibraryUrl();

  return (
    <div
      className={cn(
        isFullViewport
          ? "flex h-full flex-col"
          : "mx-auto max-w-4xl px-6 py-8",
      )}
    >
      {!isFullViewport && <LibraryBreadcrumb />}
      <div className={cn(isFullViewport && "flex min-h-0 flex-1 flex-col")}>
        <Outlet />
      </div>
    </div>
  );
}
