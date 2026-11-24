import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { LegalPage } from "../features/legal/legal-page.js";

/** Public pages: reachable whether or not a session exists. */
export const PrivacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: () => <LegalPage kind="privacy" />,
});

export const TermsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: () => <LegalPage kind="terms" />,
});
