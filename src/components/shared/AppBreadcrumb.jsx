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
import { getBreadcrumbSegments } from "@/nav/navConfig";

export default function AppBreadcrumb() {
  const location = useLocation();
  const search = location.search?.replace(/^\?/, "") || "";
  const segments = getBreadcrumbSegments(location.pathname, search);

  if (segments.length === 0) return null;

  return (
    <Breadcrumb className="hidden sm:block">
      <BreadcrumbList>
        {segments.map((seg, i) => (
          <React.Fragment key={seg.path + seg.label + i}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {seg.isCurrent || i === segments.length - 1 ? (
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
