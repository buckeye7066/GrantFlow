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

export default function AppBreadcrumb({ endUserGroups = null }) {
  const location = useLocation();
  const { t } = useLanguage();
  const search = location.search?.replace(/^\?/, "") || "";
  const route = location.pathname.split('/')[1] || 'Dashboard';
  const item = endUserGroups?.flatMap((group) => group.items).find((entry) => entry.routeName === route);
  const existing = getBreadcrumbSegments(location.pathname, search);
  const segments = endUserGroups ? (route === 'Dashboard' ? [existing[0]] : [existing[0], {
    path: location.pathname + location.search,
    label: item?.title || existing.at(-1)?.label || route,
    labelI18nKey: item?.i18nKey,
    isCurrent: true,
  }]) : existing;

  // Translate each crumb label when it carries an i18n key; fall back to the
  // raw English label so unmapped routes still render correctly.
  const labelFor = (seg) => (seg.labelI18nKey ? t(seg.labelI18nKey) : seg.label);

  if (segments.length === 0) return null;

  return (
    <Breadcrumb className={endUserGroups ? "block" : "hidden sm:block"}>
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
