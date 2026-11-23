import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api.js";
import {
  LoadingState,
  ErrorState,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Label,
  Switch,
  Separator,
  useI18n,
} from "@vellum/ui";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import type { AuthConfigView } from "./types.js";
import { asNumber, errorMessage } from "./helpers.js";
import { ReadOnlyMetric } from "./read-only-metric.js";

export function PoliciesPanel({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState<AuthConfigView | null>(null);
  const [saving, setSaving] = React.useState(false);

  const {
    data: config,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["auth-studio-config", projectId],
    queryFn: () => apiFetch<AuthConfigView>(
      `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`
    ),
  });

  React.useEffect(() => {
    if (config) setDraft({ ...config });
  }, [config]);

  const save = async () => {
    if (!draft) return;
    if (draft.passwordMinLength < 6 || draft.passwordMinLength > 128) {
      toast.error(t("authStudio.policies.invalidMinLength"));
      return;
    }
    if (draft.accessTokenTtlSeconds < 60 || draft.accessTokenTtlSeconds > 86400 ||
        draft.refreshTokenTtlDays < 1 || draft.refreshTokenTtlDays > 365) {
      toast.error(t("authStudio.policies.invalidTtl"));
      return;
    }
    if (!draft.projectionCollectionPath.trim()) {
      toast.error(t("authStudio.policies.invalidPath"));
      return;
    }
    setSaving(true);
    try {
      // Only keys accepted by AuthConfigPatchSchema / applyAuthConfigPatch.
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`,
        {
          method: "PATCH",
          body: JSON.stringify({
            passwordMinLength: draft.passwordMinLength,
            passwordRequireUppercase: draft.passwordRequireUppercase,
            passwordRequireNumber: draft.passwordRequireNumber,
            passwordRequireSymbol: draft.passwordRequireSymbol,
            accessTokenTtlSeconds: draft.accessTokenTtlSeconds,
            refreshTokenTtlDays: draft.refreshTokenTtlDays,
            enableUserProjection: draft.enableUserProjection,
            projectionCollectionPath: draft.projectionCollectionPath.trim(),
          }),
        }
      );
      toast.success(t("authStudio.policies.saveToast"));
      await refetch();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.policies.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <LoadingState rows={6} columns={3} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={errorMessage(error, t("authStudio.policies.loadFailed"))}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("authStudio.policies.title")}</CardTitle>
          <CardDescription className="text-xs">{t("authStudio.policies.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {draft ? (
            <>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("authStudio.policies.sectionPassword")}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="policy-min-length" className="text-xs">{t("authStudio.policies.passwordMinLength")}</Label>
                    <Input
                      id="policy-min-length"
                      type="number"
                      min={6}
                      max={128}
                      value={draft.passwordMinLength}
                      onChange={(event) => setDraft({ ...draft, passwordMinLength: Number(event.target.value) })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="flex flex-col justify-end gap-2 pb-1">
                    {([
                      ["passwordRequireUppercase", t("authStudio.policies.passwordRequireUppercase")],
                      ["passwordRequireNumber", t("authStudio.policies.passwordRequireNumber")],
                      ["passwordRequireSymbol", t("authStudio.policies.passwordRequireSymbol")],
                    ] as const).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={draft[key]}
                          onCheckedChange={(value) => setDraft({ ...draft, [key]: value })}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("authStudio.policies.sectionTokens")}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="policy-access-ttl" className="text-xs">{t("authStudio.policies.accessTtl")}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="policy-access-ttl"
                        type="number"
                        min={60}
                        max={86400}
                        value={draft.accessTokenTtlSeconds}
                        onChange={(event) => setDraft({ ...draft, accessTokenTtlSeconds: Number(event.target.value) })}
                        className="h-8 text-xs"
                      />
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{t("authStudio.policies.accessTtlUnit")}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="policy-refresh-ttl" className="text-xs">{t("authStudio.policies.refreshTtl")}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="policy-refresh-ttl"
                        type="number"
                        min={1}
                        max={365}
                        value={draft.refreshTokenTtlDays}
                        onChange={(event) => setDraft({ ...draft, refreshTokenTtlDays: Number(event.target.value) })}
                        className="h-8 text-xs"
                      />
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{t("authStudio.policies.refreshTtlUnit")}</span>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("authStudio.policies.sectionProjection")}</h3>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={draft.enableUserProjection}
                    onCheckedChange={(value) => setDraft({ ...draft, enableUserProjection: value })}
                  />
                  <span>{t("authStudio.policies.projectionEnabled")}</span>
                </label>
                <div className="space-y-1.5">
                  <Label htmlFor="policy-projection-path" className="text-xs">{t("authStudio.policies.projectionPath")}</Label>
                  <Input
                    id="policy-projection-path"
                    value={draft.projectionCollectionPath}
                    onChange={(event) => setDraft({ ...draft, projectionCollectionPath: event.target.value })}
                    placeholder={t("authStudio.policies.projectionPathPlaceholder")}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("authStudio.policies.sectionRuntime")}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <ReadOnlyMetric label={t("authStudio.policies.maxUsers")} value={asNumber(config?.maxUsersQuota, 0).toLocaleString()} />
                  <ReadOnlyMetric label={t("authStudio.policies.maxSignups")} value={asNumber(config?.maxSignupsPerHour, 0).toLocaleString()} />
                  <ReadOnlyMetric
                    label={t("authStudio.policies.suspension")}
                    value={config?.authServiceSuspended ? t("authStudio.common.disabled") : t("authStudio.common.enabled")}
                  />
                  <ReadOnlyMetric label={t("authStudio.policies.jwtKeyId")} value={config?.jwtKeyId ?? "-"} mono />
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void save()} disabled={saving}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {saving ? t("authStudio.policies.saving") : t("authStudio.policies.save")}
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
