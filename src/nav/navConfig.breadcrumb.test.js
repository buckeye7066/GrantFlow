import { describe, expect, it } from "vitest";
import { getBreadcrumbSegments } from "./navConfig";

const labels = (pathname) => getBreadcrumbSegments(pathname).map((s) => s.label);

describe("getBreadcrumbSegments", () => {
  it('does not duplicate "Home" for routes in the home group (Calendar)', () => {
    // Regression: Calendar lives in the "home" group (label "Home"), which used to
    // render "Home > Home > Calendar". The home group must be collapsed into the
    // fixed first crumb.
    expect(labels("/Calendar")).toEqual(["Home", "Calendar"]);
  });

  it("shows a single Home crumb for the Dashboard route", () => {
    expect(labels("/Dashboard")).toEqual(["Home"]);
  });

  it("keeps the group crumb for non-home multi-item groups", () => {
    // Pipeline is in the "Work" group — that middle crumb is meaningful and stays.
    expect(labels("/Pipeline")).toEqual(["Home", "Work", "Pipeline"]);
  });

  it("collapses single-item groups (Help Center)", () => {
    expect(labels("/Help")).toEqual(["Home", "Help Center"]);
  });
});
