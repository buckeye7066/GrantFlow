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
import { useLanguage } from "@/i18n";

export default function AppBreadcrumb() {
  const location = useLocation();
  const { t } = useLanguage();
  const search = location.search?.replace(/^\?/, "") || "";
  const segments = getBreadcrumbSegments(location.pathname, search);

  // Translate each crumb label when it carries an i18n key; fall back to the
  // raw English label so unmapped routes still render correctly.
  const labelFor = (seg) => (seg.labelI18nKey ? t(seg.labelI18nKey) : seg.label);

  if (segments.length === 0) return null;

  return (
    <Breadcrumb className="hidden sm:block">
      <BreadcrumbList>
        {segments.map((seg, i) => (
          <React.Fragment key={seg.path + seg.label + i}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {seg.isCurrent || i === segments.length - 1 ? (
                <BreadcrumbPage>{labelFor(seg)}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={seg.path}>{labelFor(seg)}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
