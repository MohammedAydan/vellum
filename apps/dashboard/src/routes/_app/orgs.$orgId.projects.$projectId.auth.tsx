import { createRoute, useParams } from "@tanstack/react-router";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";
import { PageContent, ConfigurablePageHeader, Tabs, TabsList, TabsTrigger, TabsContent, useI18n } from "@vellum/ui";
import { Users, KeyRound, ShieldCheck } from "lucide-react";
import { UsersDirectory } from "../../features/auth-studio/users-directory.js";
import { ProvidersPanel } from "../../features/auth-studio/providers-panel.js";
import { PoliciesPanel } from "../../features/auth-studio/policies-panel.js";

export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "auth",
  component: AuthStudioPage,
});

function AuthStudioPage() {
  const { projectId } = useParams({ from: Route.id });
  const { t } = useI18n();

  return (
    <PageContent>
      <ConfigurablePageHeader title={t("authStudio.title")} description={t("authStudio.description")} />

      <Tabs variant="underline" defaultValue="users" className="w-full space-y-4">
        <TabsList className="h-10 w-full justify-start overflow-x-auto">
          <TabsTrigger value="users" className="gap-2 text-xs font-medium">
            <Users className="h-3.5 w-3.5" />
            {t("authStudio.tab.users")}
          </TabsTrigger>
          <TabsTrigger value="providers" className="gap-2 text-xs font-medium">
            <KeyRound className="h-3.5 w-3.5" />
            {t("authStudio.tab.providers")}
          </TabsTrigger>
          <TabsTrigger value="policies" className="gap-2 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("authStudio.tab.policies")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" forceMount className="data-[state=inactive]:hidden">
          <UsersDirectory projectId={projectId} />
        </TabsContent>
        <TabsContent value="providers" forceMount className="data-[state=inactive]:hidden">
          <ProvidersPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="policies" forceMount className="data-[state=inactive]:hidden">
          <PoliciesPanel projectId={projectId} />
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}
