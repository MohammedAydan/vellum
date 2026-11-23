import * as React from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Route as appRoute } from "../_app.js";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ConfigurablePageHeader,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
  Input,
  Label,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  EmptyState,
  LoadingState,
  ErrorState,
  useI18n,
} from "@vellum/ui";
import { Building2, Plus, ArrowRight, Users, FolderKanban } from "lucide-react";
import { apiFetch } from "../../lib/api.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "../../lib/zod-resolver.js";
import { z } from "zod";
import { toast } from "sonner";

interface OrganizationItem {
  id: string;
  slug: string;
  name: string;
  billingEmail: string;
  plan?: string;
  membersCount?: number;
  projectsCount?: number;
}

function makeCreateOrgSchema(t: (key: string) => string) {
  return z.object({
    slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, t("orgs.slugValidation")),
    name: z.string().min(2, t("auth.validationName")),
    billingEmail: z.string().email(t("orgs.emailValidation")),
  });
}

type CreateOrgFormData = z.infer<ReturnType<typeof makeCreateOrgSchema>>;

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app",
  component: OrgSelectorPage,
});

function OrgSelectorPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const schema = React.useMemo(() => makeCreateOrgSchema(t), [t]);

  // Fetch Organizations
  const {
    data: orgs = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => {
      const res = await apiFetch<unknown>("/v1/console/organizations");
      return Array.isArray(res)
        ? (res as OrganizationItem[])
        : ((res as { organizations?: OrganizationItem[] })?.organizations ?? []);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrgFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      slug: "",
      name: "",
      billingEmail: "",
    },
  });

  const createOrgMutation = useMutation({
    mutationFn: async (data: CreateOrgFormData) => {
      return await apiFetch<OrganizationItem>("/v1/organizations", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: (newOrg) => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setIsDialogOpen(false);
      reset();
      toast.success(t("toast.orgCreated", { name: newOrg.name }));
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : t("toast.orgCreateFailed"));
    },
  });

  if (isLoading) {
    return <LoadingState rows={3} columns={3} />;
  }

  if (isError) {
    return <ErrorState title={t("common.errorTitle")} message={error instanceof Error ? error.message : t("common.error")} onRetry={() => refetch()} />;
  }

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("orgs.selectTitle")}
        description={t("orgs.selectDescription")}
        actions={
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4 me-2" />
                {t("orgs.newOrg")}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("orgs.createOrg")}</DialogTitle>
                <DialogDescription>
                  {t("orgs.createOrgDescription")}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit((d) => createOrgMutation.mutate(d))}>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="slug">{t("orgs.slug")}</Label>
                    <Input id="slug" placeholder="acme-corp" {...register("slug")} />
                    {errors.slug && <p className="text-xs text-destructive">{errors.slug.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">{t("orgs.displayName")}</Label>
                    <Input id="name" placeholder="Acme Corporation" {...register("name")} />
                    {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="billingEmail">{t("orgs.billingEmail")}</Label>
                    <Input id="billingEmail" type="email" placeholder="billing@acme.com" {...register("billingEmail")} />
                    {errors.billingEmail && <p className="text-xs text-destructive">{errors.billingEmail.message}</p>}
                  </div>
                </div>
                <DialogFooter className="mt-4">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" disabled={isSubmitting || createOrgMutation.isPending}>
                    {createOrgMutation.isPending ? t("orgs.creating") : t("orgs.createOrg")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      {orgs.length === 0 ? (
        <EmptyState
          icon={<Building2 className="h-10 w-10 text-muted-foreground/60" />}
          title={t("orgs.emptyTitle")}
          description={t("orgs.emptyDescription")}
          action={
            <Button onClick={() => setIsDialogOpen(true)}>
              <Plus className="size-4 me-1.5" />
              {t("orgs.createOrg")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <Card
              key={org.id}
              className="flex flex-col justify-between hover:border-primary/50 transition-colors"
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {org.slug}
                  </Badge>
                  <Badge variant="secondary">{org.plan ?? t("orgs.planFree")}</Badge>
                </div>
                <CardTitle className="text-lg mt-2">{org.name}</CardTitle>
                <CardDescription className="text-xs">{org.billingEmail}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <div className="flex items-center space-x-2">
                  <Users className="h-3.5 w-3.5" />
                  <span>{t("orgs.members", { count: org.membersCount ?? 1 })}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <FolderKanban className="h-3.5 w-3.5" />
                  <span>{t("orgs.projects", { count: org.projectsCount ?? 0 })}</span>
                </div>
              </CardContent>
              <CardFooter className="pt-2 border-t">
                <Button
                  variant="ghost"
                  className="w-full justify-between text-xs"
                  onClick={() => navigate({ to: `/app/orgs/${org.id}` })}
                >
                  <span>{t("orgs.openConsole")}</span>
                  <ArrowRight className="size-3.5 ms-1" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </PageContent>
  );
}
