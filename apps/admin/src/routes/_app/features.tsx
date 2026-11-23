import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { adminFetch } from "../../lib/api.js";
import { LoadingState, ErrorAlert, EmptyState, useI18n, KpiMetricCard, DataTable, StatusBadge, type DataTableColumn } from "@vellum/ui";
import {
  ConfigurablePageHeader,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Badge,
  Switch,
  Slider,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Label,
} from "@vellum/ui";
import {
  Save,
  Plus,
  SlidersHorizontal,
  Lock,
  Layers,
  Sparkles,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/features",
  component: FeatureFlagsPage,
});

interface FeatureFlagRecord {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  updatedAt: string;
  updatedBy: string | null;
}

type FlagCategory = "engine" | "realtime" | "experimental";
type FlagStage = "ga" | "beta" | "preview";

interface FeatureFlag {
  id: string;
  name: string;
  category: FlagCategory;
  description: string;
  stage: FlagStage;
  enabled: boolean;
  rolloutPercentage: number;
}

/** Category/stage are presentation-only groupings derived from live flag data. */
function decorateFlag(record: FeatureFlagRecord, defaultDescription: string): FeatureFlag {
  const key = record.key.toLowerCase();
  const category: FlagCategory = key.includes("realtime") || key.includes("outbox")
    ? "realtime"
    : key.includes("wasm") || key.includes("experimental")
      ? "experimental"
      : "engine";
  const stage: FlagStage = record.rolloutPercent >= 100 ? "ga" : record.rolloutPercent > 0 ? "beta" : "preview";
  return {
    id: record.key,
    name: record.key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    category,
    description: record.description || defaultDescription,
    stage,
    enabled: record.enabled,
    rolloutPercentage: record.rolloutPercent,
  };
}

function FeatureFlagsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const {
    data: liveRecords = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "features"],
    queryFn: () => adminFetch<FeatureFlagRecord[]>("/v1/admin/features"),
  });

  const [drafts, setDrafts] = React.useState<Record<string, number>>({});
  const flags = liveRecords.map(record => decorateFlag(record, t("admin.features.defaultDescription")));
  const [busy, setBusy] = React.useState(false);
  const locked = React.useRef(false);
  const persist = useMutation({
    mutationFn: (input: { key: string; description: string; enabled: boolean; rolloutPercent: number }) =>
      adminFetch<FeatureFlagRecord>("/v1/admin/features", {method:"POST", body:JSON.stringify(input)}),
    onSuccess: (record) => queryClient.setQueryData<FeatureFlagRecord[]>(["admin", "features"], previous =>
      [...(previous ?? []).filter(p => p.key !== record.key), record]),
  });
  const [activeCategory, setActiveCategory] = React.useState<string>("all");
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const [newFlagId, setNewFlagId] = React.useState("");
  const [newFlagDescription, setNewFlagDescription] = React.useState("");
  const filteredFlags = flags.filter(f => activeCategory === "all" || f.category === activeCategory);
  const changed = flags.filter(f => drafts[f.id] !== undefined && drafts[f.id] !== f.rolloutPercentage);

  const runWrite = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await work(); }
    catch(err) { toast.error(err instanceof Error ? err.message : t("admin.features.saveError")); }
    finally { locked.current = false; setBusy(false); }
  };
  const handleToggle = (id: string, enabled: boolean) => void runWrite(async () => {
    const target = flags.find(f=>f.id===id); if (!target) return;
    await persist.mutateAsync({key:id,description:target.description,enabled,rolloutPercent:target.rolloutPercentage});
  });
  const handleSlider = (id: string, value: number[]) => {
    if (!locked.current) setDrafts(previous=>({...previous,[id]:value[0]??0}));
  };
  const handleSave = () => void runWrite(async () => {
    if (!changed.length) return;
    // Commit only dirty rows. Confirm each success before clearing its draft,
    // so a partial failure keeps unsaved changes available for retry.
    for (const flag of changed) {
      await persist.mutateAsync({key:flag.id,description:flag.description,enabled:flag.enabled,rolloutPercent:drafts[flag.id]!});
      setDrafts(previous=>{const next={...previous};delete next[flag.id];return next;});
    }
    toast.success(t("admin.features.saveToast"));
  });
  const handleCreateFlag = (event: React.FormEvent) => {
    event.preventDefault();
    const key = newFlagId.trim().toLowerCase().replace(/\s+/g,"_");
    if (!key) return;
    if (flags.some(f=>f.id===key)) {toast.error(t("admin.truth.flagExists"));return;}
    void runWrite(async () => {
      await persist.mutateAsync({key,description:newFlagDescription,enabled:false,rolloutPercent:0});
      setIsDialogOpen(false);setNewFlagId("");setNewFlagDescription("");
      toast.success(t("admin.features.createToast",{name:key}));
    });
  };

  const gaCount = flags.filter((f) => f.stage === "ga").length;
  const betaCount = flags.filter((f) => f.stage === "beta").length;
  const previewCount = flags.filter((f) => f.stage === "preview").length;

  const matrixColumns: DataTableColumn<FeatureFlag>[] = [
    { id: "key", header: t("admin.features.thFlagKey"), mono: true, sortable: true, accessor: (flag) => <span className="font-semibold">{flag.id}</span> },
    { id: "category", header: t("admin.features.thCategory"), mono: true, accessor: (flag) => <span className="capitalize text-muted-foreground">{flag.category}</span> },
    { id: "stage", header: t("admin.features.thStage"), accessor: (flag) => <Badge variant="outline" className="font-mono text-[10px] uppercase">{flag.stage}</Badge> },
    {
      id: "status",
      header: t("admin.features.thStatus"),
      accessor: (flag) => (
        <StatusBadge
          status={flag.enabled ? "active" : "disabled"}
          label={flag.enabled ? t("admin.features.enabled") : t("admin.features.disabledWord")}
        />
      ),
    },
    { id: "rollout", header: t("admin.features.thRollout"), mono: true, align: "end", accessor: (flag) => `${flag.rolloutPercentage}%` },
  ];

  if (isLoading) return <LoadingState rows={4} columns={4} />;
  if (isError) {
    return (
      <ErrorAlert
        title={t("admin.features.title")}
        message={error instanceof Error ? error.message : t("admin.features.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }
  // Do NOT early-return an EmptyState here: it would hide the Register Flag
  // dialog, the Save Changes action, the category tabs and every other control
  // whenever the Control DB has no flags yet. Show the empty state inside the
  // flag list instead so operators can always create the first flag.
  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("admin.features.title")}
        description={t("admin.features.description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-rose-500/30 text-rose-700 dark:text-rose-400 bg-rose-500/5 gap-1 py-1"
            >
              <Lock className="h-3 w-3" />
              {t("common.privacyGuardActive")}
            </Badge>

            <Dialog open={isDialogOpen} onOpenChange={open=>{if(!busy)setIsDialogOpen(open);}}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  <span>{t("admin.features.registerFlag")}</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="text-base font-semibold">
                    {t("admin.features.registerTitle")}
                  </DialogTitle>
                  <DialogDescription className="text-xs">
                    {t("admin.features.registerDesc")}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreateFlag} className="space-y-3.5 py-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="flagId" className="text-xs">{t("admin.features.flagId")}</Label>
                    <Input
                      id="flagId"
                      placeholder={t("admin.features.flagIdPlaceholder")}
                      value={newFlagId}
                      onChange={(e) => setNewFlagId(e.target.value)}
                      required
                      className="font-mono text-xs h-8"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("admin.truth.derivedFlags")}</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="desc" className="text-xs">{t("admin.features.descriptionLabel")}</Label>
                    <Input
                      id="desc"
                      placeholder={t("admin.features.descriptionPlaceholder")}
                      value={newFlagDescription}
                      onChange={(e) => setNewFlagDescription(e.target.value)}
                      className="text-xs h-8"
                    />
                  </div>
                  <DialogFooter className="pt-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" size="sm" disabled={busy} aria-busy={busy}>
                      {t("admin.features.createFlag")}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <Button onClick={handleSave} disabled={busy || !changed.length} aria-busy={busy} size="sm" className="h-8 gap-1.5 text-xs">
              <Save className="h-3.5 w-3.5" />
              <span>{t("common.saveChanges")}</span>
            </Button>
          </div>
        }
      />

      {/* KPI metric cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <KpiMetricCard label={t("admin.features.totalFlags")} value={flags.length} icon={<SlidersHorizontal className="size-4" />} subtitle={t("admin.features.configuredInControlDb")} mono />
        <KpiMetricCard label={t("admin.features.generalAvailability")} value={gaCount} icon={<CheckCircle2 className="size-4" />} subtitle={t("admin.features.tenantRollout")} mono />
        <KpiMetricCard label={t("admin.features.betaRollouts")} value={betaCount} icon={<Layers className="size-4" />} subtitle={t("admin.features.canaryPercentageActive")} mono />
        <KpiMetricCard label={t("admin.features.previewExperiments")} value={previewCount} icon={<Sparkles className="size-4" />} subtitle={t("admin.features.gatedEarlyAdopters")} mono />
      </div>

      {/* Tabs Filter */}
      <Tabs defaultValue="all" value={activeCategory} onValueChange={setActiveCategory} className="w-full space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <TabsList className="h-9">
            <TabsTrigger value="all" className="text-xs">{t("admin.features.tabAll", { count: flags.length })}</TabsTrigger>
            <TabsTrigger value="engine" className="text-xs">{t("admin.features.engine")}</TabsTrigger>
            <TabsTrigger value="realtime" className="text-xs">{t("admin.features.realtimeOutbox")}</TabsTrigger>
            <TabsTrigger value="experimental" className="text-xs">{t("admin.features.experimental")}</TabsTrigger>
          </TabsList>

          <span className="text-xs text-muted-foreground font-mono">
            {t("admin.features.showing", { count: filteredFlags.length })}
          </span>
        </div>

        {/* The list is filtered by activeCategory via filteredFlags, so the visible panel
            must stay mounted. A fixed value keeps the "all" trigger's content id stable. */}
        <TabsContent value="all" forceMount className="space-y-4">
          {/* Card View Layout */}
          <div className="space-y-3.5">
            {filteredFlags.length === 0 ? (
              <EmptyState
                icon={<SlidersHorizontal className="h-10 w-10 text-muted-foreground/60" />}
                title={flags.length === 0 ? t("admin.features.noFlags") : t("admin.features.noFlagsInCategory")}
                description={
                  flags.length === 0
                    ? t("admin.features.noFlagsDesc")
                    : t("admin.features.noFlagsCategoryDesc")
                }
              />
            ) : (
            filteredFlags.map((flag) => (
              <Card key={flag.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap gap-3 items-center justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-sm font-semibold">{flag.name}</CardTitle>
                        <Badge
                          variant="outline"
                          className={`font-mono text-[10px] uppercase ${
                            flag.stage === "ga"
                              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                              : flag.stage === "beta"
                              ? "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30"
                              : "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30"
                          }`}
                        >
                          {flag.stage}
                        </Badge>
                        <Badge variant="secondary" className="font-mono text-[10px] text-muted-foreground">
                          {flag.id}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">{flag.description}</CardDescription>
                    </div>
                    <div className="flex items-center space-x-3">
                      <StatusBadge
                        status={flag.enabled ? "active" : "disabled"}
                        label={flag.enabled ? t("admin.features.active") : t("admin.features.disabled")}
                      />
                      <Switch
                        checked={flag.enabled}
                        disabled={busy}
                        aria-label={t("admin.truth.toggleFlag",{name:flag.name})}
                        onCheckedChange={(checked) => handleToggle(flag.id, checked)}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-2 border-t border-border/60 text-xs">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-muted-foreground font-mono">
                      <span>{t("admin.features.gradualRollout")}</span>
                      <span className="font-semibold text-foreground">{drafts[flag.id]??flag.rolloutPercentage}%{drafts[flag.id] !== undefined && drafts[flag.id] !== flag.rolloutPercentage ? ` (${t("admin.truth.unsaved")})` : ""}</span>
                    </div>
                    <Slider
                      disabled={!flag.enabled || busy}
                      aria-label={t("admin.truth.rolloutFlag",{name:flag.name,percent:drafts[flag.id]??flag.rolloutPercentage})}
                      value={[drafts[flag.id]??flag.rolloutPercentage]}
                      max={100}
                      step={5}
                      onValueChange={(val) => handleSlider(flag.id, val)}
                    />
                  </div>
                </CardContent>
              </Card>
            ))
            )}
          </div>

          {/* Table View Summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">{t("admin.features.matrixTitle")}</CardTitle>
              <CardDescription className="text-xs">
                {t("admin.features.matrixDesc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={filteredFlags}
                columns={matrixColumns}
                getRowId={(flag) => flag.id}
              />
            </CardContent>
          </Card>
        </TabsContent>
        {/* Keep the remaining triggers' aria-controls targets mounted. */}
        <TabsContent value="engine" forceMount className="hidden" />
        <TabsContent value="realtime" forceMount className="hidden" />
        <TabsContent value="experimental" forceMount className="hidden" />
      </Tabs>
    </PageContent>
  );
}
