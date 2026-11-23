import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { getStoredSession } from "../lib/auth.js";
import { Layers3, ShieldCheck, Radio } from "lucide-react";
import { AuthShell, useI18n } from "@vellum/ui";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "_auth",
  beforeLoad: ({ location }) => {
    // The login/signup screens are for anonymous visitors only. The MFA
    // challenge screen must stay reachable while signed in: the account
    // menu's "Two-Factor Authentication" item deep-links here, and a blanket
    // redirect made that item silently bounce back to /app (looking broken).
    if (location.pathname === "/mfa") return;
    const session = getStoredSession();
    if (session) {
      throw redirect({ to: "/app" });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { t } = useI18n();
  const capabilities = [
    {
      icon: Layers3,
      title: t("auth.cap.exploreTitle"),
      detail: t("auth.cap.exploreDetail"),
    },
    {
      icon: ShieldCheck,
      title: t("auth.cap.rulesTitle"),
      detail: t("auth.cap.rulesDetail"),
    },
    {
      icon: Radio,
      title: t("auth.cap.realtimeTitle"),
      detail: t("auth.cap.realtimeDetail"),
    },
  ];

  return (
    <AuthShell
      brand={t("auth.brandFull")}
      eyebrow={t("auth.brandTagline")}
      title={t("auth.heroTitle")}
      description={t("auth.heroDescription")}
      features={capabilities}
      footer="PostgreSQL · JSONB · LISTEN/NOTIFY"
    >
      <Outlet />
    </AuthShell>
  );
}
