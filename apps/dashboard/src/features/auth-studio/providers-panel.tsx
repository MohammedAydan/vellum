import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getApiBaseUrl } from "../../lib/api.js";
import {
  LoadingState,
  ErrorState,
  ConsoleDetailSheet,
  ConsoleCopyableField,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Input,
  Label,
  Badge,
  Switch,
  Alert,
  AlertTitle,
  AlertDescription,
  Separator,
  useI18n,
} from "@vellum/ui";
import { ShieldAlert, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import type { UnknownRecord, AuthConfigView, OAuthDraft } from "./types.js";
import { asRecord, asBoolean, errorMessage, readAllowPollSignIn, readOAuthDraft, readRedirectUris } from "./helpers.js";

export function ProvidersPanel({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [oauthTarget, setOauthTarget] = React.useState<string | null>(null);
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

  const patchConfig = async (patch: UnknownRecord, successMessage: string) => {
    setSaving(true);
    try {
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      toast.success(successMessage);
      await refetch();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.providers.saveFailed")));
    } finally {
      setSaving(false);
    }
  };


  const toggle = (key: keyof AuthConfigView, value: boolean) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  if (isLoading) return <LoadingState rows={6} columns={3} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={errorMessage(error, t("authStudio.providers.loadFailed"))}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      {config?.authServiceSuspended ? (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle className="text-xs font-semibold">{t("authStudio.policies.suspension")}</AlertTitle>
          <AlertDescription className="text-xs">{config.suspensionReason ?? t("authStudio.policies.suspendedWarning")}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("authStudio.providers.title")}</CardTitle>
          <CardDescription className="text-xs">{t("authStudio.providers.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {draft ? (
            <>
              {([
                ["enableEmailPassword", t("authStudio.providers.emailPassword"), t("authStudio.providers.emailPasswordDesc")],
                ["enableAnonymousAuth", t("authStudio.providers.anonymous"), t("authStudio.providers.anonymousDesc")],
                ["enableTotpMfa", t("authStudio.providers.totpMfa"), t("authStudio.providers.totpMfaDesc")],
                ["requireEmailVerification", t("authStudio.providers.requireVerification"), t("authStudio.providers.requireVerificationDesc")],
              ] as const).map(([key, label, description]) => {
                const value = draft[key];
                return (
                  <div key={key} className="flex items-center justify-between gap-4 rounded-lg border border-transparent px-2 py-3 hover:bg-muted/30">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{description}</p>
                    </div>
                    <Switch checked={value === true} onCheckedChange={(checked) => toggle(key, checked)} />
                  </div>
                );
              })}
              <MagicLinkRow
                draft={draft}
                enabled={asBoolean(asRecord(draft.oauthProviders?.["magicLink"])["enabled"])}
                onToggle={(value) => {
                  setDraft({
                    ...draft,
                    oauthProviders: { ...draft.oauthProviders, magicLink: { ...asRecord(draft.oauthProviders?.["magicLink"]), enabled: value } },
                  });
                }}
                t={t}
              />
              <Separator className="my-2" />
              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  disabled={saving}
                  onClick={() => void patchConfig({
                    enableEmailPassword: draft.enableEmailPassword,
                    enableAnonymousAuth: draft.enableAnonymousAuth,
                    enableTotpMfa: draft.enableTotpMfa,
                    requireEmailVerification: draft.requireEmailVerification,
                    oauthProviders: { magicLink: asRecord(draft.oauthProviders?.["magicLink"]) },
                  }, t("authStudio.providers.saveToast"))}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {saving ? t("authStudio.providers.saving") : t("authStudio.providers.save")}
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <SmtpCard config={config} saving={saving} onPatch={patchConfig} t={t} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">{t("authStudio.providers.oauthTitle")}</CardTitle>
          <CardDescription className="text-xs">{t("authStudio.providers.oauthDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">{t("authStudio.providers.callbackDescription")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["google", "github", "apple"] as const).map((provider) => {
              const oauth = readOAuthDraft(config, provider);
              const configured = Boolean(oauth.clientId && oauth.hasSecret);
              return (
                <div key={provider} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold capitalize">{t(`authStudio.providers.${provider}`)}</p>
                    <Badge
                      variant={configured && oauth.enabled ? "secondary" : "outline"}
                      className={`mt-1 font-mono text-[10px] uppercase ${configured && oauth.enabled ? "text-success" : "text-muted-foreground"}`}
                    >
                      {configured && oauth.enabled ? t("authStudio.providers.configured") : t("authStudio.providers.notConfigured")}
                    </Badge>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setOauthTarget(provider)}>
                    {t("authStudio.providers.configure")}
                  </Button>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <PollSignInCard
        projectId={projectId}
        enabled={readAllowPollSignIn(config)}
        onSaved={async () => { await refetch(); }}
      />

      <RedirectUrisCard
        projectId={projectId}
        uris={readRedirectUris(config)}
        onSaved={async () => { await refetch(); }}
      />

      {oauthTarget ? (
        <OAuthConnectionDialog
          projectId={projectId}
          provider={oauthTarget}
          config={config ?? null}
          onClose={() => setOauthTarget(null)}
          onSaved={async () => {
            setOauthTarget(null);
            await refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function MagicLinkRow({
  draft,
  enabled,
  onToggle,
  t,
}: {
  draft: AuthConfigView;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-transparent px-2 py-3 hover:bg-muted/30">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{t("authStudio.providers.magicLink")}</p>
        <p className="text-[11px] text-muted-foreground">{t("authStudio.providers.magicLinkDesc")}</p>
      </div>
      <Switch checked={enabled} onCheckedChange={onToggle} disabled={!draft.enableEmailPassword} />
    </div>
  );
}

function OAuthConnectionDialog({
  projectId,
  provider,
  config,
  onClose,
  onSaved,
}: {
  projectId: string;
  provider: string;
  config: AuthConfigView | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const initial = React.useMemo(() => readOAuthDraft(config, provider), [config, provider]);
  const [draft, setDraft] = React.useState<OAuthDraft>(initial);
  const [saving, setSaving] = React.useState(false);
  const callbackUrl = `${getApiBaseUrl()}/v1/projects/${encodeURIComponent(projectId)}/auth/oauth/${provider}/callback`;

  React.useEffect(() => setDraft(initial), [initial]);

  const save = async () => {
    const appleMissing = provider === "apple" && (!draft.teamId.trim() || !draft.keyId.trim());
    if (!draft.clientId.trim() || (!draft.clientSecret.trim() && !draft.hasSecret) || appleMissing) {
      toast.error(t("authStudio.providers.providerSaveFailed"));
      return;
    }
    setSaving(true);
    try {
      // Only this provider is sent. A blank secret keeps the stored one (the server merges).
      const extraIds = draft.additionalClientIds.split(/\s+/).map((v) => v.trim()).filter(Boolean);
      const oauthProviders: Record<string, unknown> = {
        [provider]: {
          enabled: draft.enabled,
          clientId: draft.clientId.trim(),
          ...(draft.clientSecret.trim() ? { clientSecret: draft.clientSecret.trim() } : {}),
          ...(provider === "google" || provider === "apple" ? { additionalClientIds: extraIds } : {}),
          ...(provider === "apple" ? { teamId: draft.teamId.trim(), keyId: draft.keyId.trim() } : {}),
        },
      };
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`,
        { method: "PATCH", body: JSON.stringify({ oauthProviders }) }
      );
      toast.success(t("authStudio.providers.providerSavedToast", { provider: t(`authStudio.providers.${provider}`) }));
      await onSaved();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.providers.providerSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConsoleDetailSheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t("authStudio.providers.oauthDrawerTitle", { provider: t(`authStudio.providers.${provider}`) })}
      description={t("authStudio.providers.oauthDescription")}
      footer={
        <>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
            {t("authStudio.common.cancel")}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => void save()} disabled={saving}>
            {t("authStudio.providers.saveProvider")}
          </Button>
        </>
      }
    >
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={draft.enabled} onCheckedChange={(value) => setDraft({ ...draft, enabled: value })} />
            <span>{t("authStudio.providers.oauthEnabled")}</span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="oauth-client-id" className="text-xs">{provider === "apple" ? t("authStudio.providers.appleServicesId") : t("authStudio.providers.clientId")}</Label>
            <Input
              id="oauth-client-id"
              value={draft.clientId}
              onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}
              className="h-8 font-mono text-xs"
            />
          </div>
          {provider === "apple" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="oauth-apple-team" className="text-xs">{t("authStudio.providers.appleTeamId")}</Label>
                  <Input id="oauth-apple-team" value={draft.teamId} maxLength={10} onChange={(event) => setDraft({ ...draft, teamId: event.target.value })} className="h-8 font-mono text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="oauth-apple-key" className="text-xs">{t("authStudio.providers.appleKeyId")}</Label>
                  <Input id="oauth-apple-key" value={draft.keyId} maxLength={10} onChange={(event) => setDraft({ ...draft, keyId: event.target.value })} className="h-8 font-mono text-xs" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="oauth-client-secret" className="text-xs">{t("authStudio.providers.applePrivateKey")}</Label>
                <textarea
                  id="oauth-client-secret"
                  value={draft.clientSecret}
                  onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
                  placeholder={draft.hasSecret ? t("authStudio.providers.clientSecretKeep") : "-----BEGIN PRIVATE KEY-----"}
                  rows={4}
                  className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[11px] text-muted-foreground">{t("authStudio.providers.applePrivateKeyHelp")}</p>
              </div>
            </>
          ) : (
          <div className="space-y-1.5">
            <Label htmlFor="oauth-client-secret" className="text-xs">{t("authStudio.providers.clientSecret")}</Label>
            <Input
              id="oauth-client-secret"
              type="password"
              value={draft.clientSecret}
              onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })}
              placeholder={draft.hasSecret ? t("authStudio.providers.clientSecretKeep") : t("authStudio.providers.clientSecretPlaceholder")}
              className="h-8 font-mono text-xs"
              autoComplete="off"
            />
          </div>
          )}
          {provider === "google" || provider === "apple" ? (
            <div className="space-y-1.5">
              <Label htmlFor="oauth-extra-ids" className="text-xs">{provider === "apple" ? t("authStudio.providers.appleBundleIds") : t("authStudio.providers.extraClientIds")}</Label>
              <textarea
                id="oauth-extra-ids"
                value={draft.additionalClientIds}
                onChange={(event) => setDraft({ ...draft, additionalClientIds: event.target.value })}
                rows={3}
                className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{provider === "apple" ? t("authStudio.providers.appleBundleIdsHelp") : t("authStudio.providers.extraClientIdsHelp")}</p>
            </div>
          ) : null}
          <ConsoleCopyableField
            label={t("authStudio.providers.callbackUrl")}
            value={callbackUrl}
          />
          <p className="text-[11px] text-muted-foreground">{t(`authStudio.providers.${provider}Setup`)}</p>
        </div>
    </ConsoleDetailSheet>
  );
}

function PollSignInCard({
  projectId,
  enabled,
  onSaved,
}: {
  projectId: string;
  enabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = React.useState(false);

  const toggle = async (value: boolean) => {
    setSaving(true);
    try {
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`,
        { method: "PATCH", body: JSON.stringify({ oauthProviders: { __settings: { allowPollSignIn: value } } }) }
      );
      toast.success(t("authStudio.providers.pollSignInSaved"));
      await onSaved();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.providers.pollSignInFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{t("authStudio.providers.pollSignInTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("authStudio.providers.pollSignInDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={enabled} disabled={saving} onCheckedChange={(value) => void toggle(value)} />
          <span>{t("authStudio.providers.pollSignInToggle")}</span>
        </label>
        <p className="text-[11px] text-muted-foreground">{t("authStudio.providers.pollSignInRisk")}</p>
      </CardContent>
    </Card>
  );
}

function RedirectUrisCard({
  projectId,
  uris,
  onSaved,
}: {
  projectId: string;
  uris: string[];
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const joined = uris.join("\n");
  const [text, setText] = React.useState(joined);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setText(joined), [joined]);

  const save = async () => {
    const redirectUris = text.split(/\s+/).map((v) => v.trim()).filter(Boolean);
    setSaving(true);
    try {
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/config`,
        { method: "PATCH", body: JSON.stringify({ oauthProviders: { __settings: { redirectUris } } }) }
      );
      toast.success(t("authStudio.providers.redirectUrisSaved"));
      await onSaved();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.providers.redirectUrisFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{t("authStudio.providers.redirectUrisTitle")}</CardTitle>
        <CardDescription className="text-xs">{t("authStudio.providers.redirectUrisDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          aria-label={t("authStudio.providers.redirectUrisTitle")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          placeholder={"https://app.example.com/login\nmyapp://auth-callback"}
          className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
        />
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={() => void save()}>
            {t("authStudio.providers.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SmtpCard({
  config,
  saving,
  onPatch,
  t,
}: {
  config: AuthConfigView | undefined;
  saving: boolean;
  onPatch: (patch: UnknownRecord, successMessage: string) => Promise<void>;
  t: (key: string) => string;
}) {
  const current = config?.customSmtp ?? null;
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState("587");
  const [user, setUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [from, setFrom] = React.useState("");

  React.useEffect(() => {
    setHost(current?.host ?? "");
    setPort(String(current?.port ?? 587));
    setUser(current?.user ?? "");
    setFrom(current?.from ?? "");
    setPass("");
  }, [current?.host, current?.port, current?.user, current?.from]);

  const save = () => {
    const smtp: UnknownRecord = { host: host.trim(), port: Number(port) || 587 };
    if (user.trim()) smtp["user"] = user.trim();
    if (from.trim()) smtp["from"] = from.trim();
    if (pass) smtp["pass"] = pass;
    void onPatch({ customSmtp: smtp }, t("authStudio.smtp.saveToast"));
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{t("authStudio.smtp.title")}</CardTitle>
        <CardDescription className="text-xs">{t("authStudio.smtp.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("authStudio.smtp.host")}</Label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("authStudio.smtp.port")}</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("authStudio.smtp.user")}</Label>
            <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("authStudio.smtp.password")}</Label>
            <Input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="new-password"
              placeholder={current?.hasPassword ? t("authStudio.smtp.passwordKept") : ""}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">{t("authStudio.smtp.from")}</Label>
            <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="no-reply@example.com" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {current ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={saving}
              onClick={() => void onPatch({ customSmtp: null }, t("authStudio.smtp.removeToast"))}
            >
              {t("authStudio.smtp.remove")}
            </Button>
          ) : null}
          <Button size="sm" className="h-8 text-xs" disabled={saving || !host.trim()} onClick={save}>
            {t("authStudio.smtp.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
