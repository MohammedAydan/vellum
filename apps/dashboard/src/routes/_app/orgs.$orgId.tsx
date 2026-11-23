import * as React from "react";
import { createRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { Route as appRoute } from "../_app.js";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ConfigurablePageHeader,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
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
  StatusBadge,
  useI18n,
} from "@vellum/ui";
import { FolderKanban, Plus, ArrowRight, ArrowLeft } from "lucide-react";
import { apiFetch } from "../../lib/api.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "../../lib/zod-resolver.js";
import { z } from "zod";
import { toast } from "sonner";

interface ProjectItem {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  status: string;
  createdAt?: string;
}

function makeCreateProjectSchema(t: (key: string) => string) {
  return z.object({
    slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, t("orgs.slugValidation")),
    name: z.string().min(2, t("auth.validationName")),
  });
}

type CreateProjectFormData = z.infer<ReturnType<typeof makeCreateProjectSchema>>;

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app/orgs/$orgId",
  component: OrgProjectsPage,
});

function OrgProjectsPage() {
  const { orgId } = useParams({ from: Route.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const schema = React.useMemo(() => makeCreateProjectSchema(t), [t]);

  const {
    data: projects = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["projects", orgId],
    queryFn: async () => {
      const res = await apiFetch<unknown>(`/v1/organizations/${orgId}/projects`);
      return Array.isArray(res)
        ? (res as ProjectItem[])
        : ((res as { projects?: ProjectItem[] })?.projects ?? []);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectFormData>({
    resolver: zodResolver(schema),
    defaultValues: { slug: "", name: "" },
  });

  const createProjMutation = useMutation({
    mutationFn: async (data: CreateProjectFormData) => {
      const res = await apiFetch<{ project: ProjectItem } | ProjectItem>(`/v1/organizations/${orgId}/projects`, {
        method: "POST",
        body: JSON.stringify(data),
      });
      return "project" in res ? res.project : res;
    },
    onSuccess: (newProj) => {
      queryClient.invalidateQueries({ queryKey: ["projects", orgId] });
      setIsDialogOpen(false);
      reset();
      toast.success(t("toast.projectCreated", { name: newProj.name }));
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : t("toast.projectCreateFailed"));
    },
  });

  if (isLoading) return <LoadingState rows={3} columns={3} />;
  if (isError) return <ErrorState title={t("common.errorTitle")} message={error instanceof Error ? error.message : t("common.error")} onRetry={() => refetch()} />;

  return (
    <PageContent>
      <div className="flex items-center space-x-2 text-xs text-muted-foreground mb-1">
        <Link to="/app" className="hover:text-foreground inline-flex items-center">
          <ArrowLeft className="size-3.5 me-1" />
          {t("projects.backAllOrgs")}
        </Link>
      </div>

      <ConfigurablePageHeader
        title={t("projects.title")}
        description={t("projects.description")}
        actions={
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4 me-2" />
                {t("projects.newProject")}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("projects.createProject")}</DialogTitle>
                <DialogDescription>
                  {t("projects.createDescription")}
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit((d) => createProjMutation.mutate(d))}>
                <div className="space-y-4 py-2">
                  <div className="space-y-2">
                    <Label htmlFor="slug">{t("projects.slug")}</Label>
                    <Input id="slug" placeholder="mobile-api" {...register("slug")} />
                    {errors.slug && <p className="text-xs text-destructive">{errors.slug.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">{t("orgs.displayName")}</Label>
                    <Input id="name" placeholder="Mobile Backend API" {...register("name")} />
                    {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
                  </div>
                </div>
                <DialogFooter className="mt-4">
                  <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" disabled={isSubmitting || createProjMutation.isPending}>
                    {createProjMutation.isPending ? t("orgs.creating") : t("projects.createProject")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-10 w-10 text-muted-foreground/60" />}
          title={t("projects.emptyTitle")}
          description={t("projects.emptyDescription")}
          action={
            <Button onClick={() => setIsDialogOpen(true)}>
              <Plus className="size-4 me-1.5" />
              {t("projects.createProject")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((proj) => (
            <Card
              key={proj.id}
              className="flex flex-col justify-between hover:border-primary/50 transition-colors"
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {proj.slug}
                  </Badge>
                  <StatusBadge
                    status={proj.status === "active" ? "active" : "suspended"}
                    label={proj.status}
                  />
                </div>
                <CardTitle className="text-lg mt-2">{proj.name}</CardTitle>
                <CardDescription className="text-xs font-mono">ID: {proj.id}</CardDescription>
              </CardHeader>
              <CardFooter className="pt-2 border-t">
                <Button
                  variant="ghost"
                  className="w-full justify-between text-xs"
                  onClick={() =>
                    navigate({
                      to: "/app/orgs/$orgId/projects/$projectId/data",
                      params: { orgId, projectId: proj.id },
                    })
                  }
                >
                  <span>{t("projects.openProject")}</span>
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
