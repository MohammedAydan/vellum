import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { getStoredAdminSession } from "../lib/auth.js";
import { AuthShell, useI18n } from "@vellum/ui";
import { Database, ScrollText, Gauge } from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "_auth",
  beforeLoad: () => {
    const session = getStoredAdminSession();
    if (session) {
      // Basepath-relative "/" => /admin/ (not the Customer Dashboard root).
      throw redirect({ to: "/" });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { t } = useI18n();

  const responsibilities = [
    { icon: Database, title: t("admin.auth.responsibility1Title"), detail: t("admin.auth.responsibility1Detail") },
    { icon: Gauge, title: t("admin.auth.responsibility2Title"), detail: t("admin.auth.responsibility2Detail") },
    { icon: ScrollText, title: t("admin.auth.responsibility3Title"), detail: t("admin.auth.responsibility3Detail") },
  ];

  return (
    <AuthShell
      brand={t("admin.brand.name")}
      eyebrow={t("admin.auth.brandPlatformOperations")}
      title={t("admin.auth.hero")}
      description={t("admin.auth.heroDesc")}
      features={responsibilities}
      footer={t("admin.auth.footer")}
    >
      <Outlet />
    </AuthShell>
  );
}
