import React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { getBreadcrumbFromPath } from "@/config/navigation";

export default function AppBreadcrumb() {
  const location = useLocation();
  const segments = getBreadcrumbFromPath(location.pathname, location.search?.replace(/^\?/, "") || "");

  if (segments.length === 0) return null;

  return (
    <Breadcrumb className="hidden sm:block">
      <BreadcrumbList>
        {segments.map((seg, i) => (
          <React.Fragment key={seg.path}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {i === segments.length - 1 ? (
                <BreadcrumbPage>{seg.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={seg.path}>{seg.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
