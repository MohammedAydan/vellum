import * as React from "react";
import { ChevronRight } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/breadcrumb.js";

export interface OrgProjectBreadcrumbProps {
  orgId?: string;
  orgName?: string;
  projectId?: string;
  projectName?: string;
  onSelectOrg?: () => void;
  onSelectProject?: () => void;
}

interface Crumb {
  key: string;
  label: string;
  id: string | undefined;
  onSelect: (() => void) | undefined;
}

export function OrgProjectBreadcrumb({
  orgId,
  orgName,
  projectId,
  projectName,
  onSelectOrg,
  onSelectProject,
}: OrgProjectBreadcrumbProps): React.JSX.Element {
  const crumbs: Crumb[] = [];
  if (orgName) {
    crumbs.push({ key: "org", label: orgName, id: orgId, onSelect: onSelectOrg });
  }
  if (projectName) {
    crumbs.push({
      key: "project",
      label: projectName,
      id: projectId,
      onSelect: onSelectProject,
    });
  }
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => (
          <React.Fragment key={crumb.key}>
            {index > 0 ? (
              <BreadcrumbSeparator>
                <ChevronRight className="size-3.5 rtl:rotate-180" aria-hidden="true" />
              </BreadcrumbSeparator>
            ) : null}
            <BreadcrumbItem className="min-w-0">
              {crumb.onSelect ? (
                <BreadcrumbLink asChild>
                  <button
                    onClick={crumb.onSelect}
                    data-entity-id={crumb.id}
                    className="max-w-28 truncate transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-56"
                  >
                    {crumb.label}
                  </button>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage data-entity-id={crumb.id} className="max-w-28 truncate sm:max-w-56">
                  {crumb.label}
                </BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
