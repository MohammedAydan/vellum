import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api.js";
import {
  LoadingState,
  ErrorState,
  EmptyState,
  ConsoleDetailSheet,
  JsonInspector,
  ConfirmDangerDialog,
  Button,
  Input,
  Label,
  Badge,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Alert,
  AlertTitle,
  AlertDescription,
  useI18n,
} from "@vellum/ui";
import { Trash2, RefreshCw, Fingerprint, MonitorSmartphone, ShieldAlert, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import type { UnknownRecord, UserDetail } from "./types.js";
import { errorMessage, formatDate } from "./helpers.js";

export function UserInspector({
  projectId,
  uid,
  onClose,
  onChanged,
}: {
  projectId: string;
  uid: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const base = `/v1/projects/${encodeURIComponent(projectId)}/auth/admin`;
  const [profile, setProfile] = React.useState<{
    email: string;
    displayName: string;
    photoUrl: string;
    phoneNumber: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    isDisabled: boolean;
    isAnonymous: boolean;
    password: string;
  } | null>(null);
  const [claimsText, setClaimsText] = React.useState("");
  const [claimsError, setClaimsError] = React.useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = React.useState(false);
  const [mfaResetOpen, setMfaResetOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const {
    data: detail,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["auth-studio-user-detail", projectId, uid],
    queryFn: () => apiFetch<UserDetail>(`${base}/users/${encodeURIComponent(uid)}`),
  });

  const user = detail?.user;

  React.useEffect(() => {
    if (!user) return;
    setProfile({
      email: user.email ?? "",
      displayName: user.displayName ?? "",
      photoUrl: user.photoUrl ?? "",
      phoneNumber: user.phoneNumber ?? "",
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      isDisabled: user.isDisabled,
      isAnonymous: user.isAnonymous,
      password: "",
    });
    setClaimsText(JSON.stringify(user.customClaims ?? {}, null, 2));
    setClaimsError(null);
  }, [user?.id, user?.updatedAt]);

  const refreshAll = () => {
    void refetch();
    onChanged();
  };

  const saveProfile = async () => {
    if (!user || !profile) return;
    const patch: UnknownRecord = {};
    if (profile.email !== (user.email ?? "")) patch["email"] = profile.email.trim().toLowerCase();
    if (profile.displayName !== (user.displayName ?? "")) patch["displayName"] = profile.displayName.trim() || null;
    if (profile.photoUrl !== (user.photoUrl ?? "")) patch["photoUrl"] = profile.photoUrl.trim() || null;
    if (profile.phoneNumber !== (user.phoneNumber ?? "")) patch["phoneNumber"] = profile.phoneNumber.trim() || null;
    if (profile.emailVerified !== user.emailVerified) patch["emailVerified"] = profile.emailVerified;
    if (profile.phoneVerified !== user.phoneVerified) patch["phoneVerified"] = profile.phoneVerified;
    if (profile.isDisabled !== user.isDisabled) patch["isDisabled"] = profile.isDisabled;
    if (profile.isAnonymous !== user.isAnonymous) patch["isAnonymous"] = profile.isAnonymous;
    if (profile.password) patch["password"] = profile.password;
    if (Object.keys(patch).length === 0) return;
    try {
      await apiFetch(`${base}/users/${encodeURIComponent(uid)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      toast.success(t("authStudio.detail.profileSavedToast"));
      refreshAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.detail.profileSaveFailed")));
    }
  };

  const saveClaims = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(claimsText);
    } catch {
      setClaimsError(t("authStudio.detail.claimsInvalidJson"));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setClaimsError(t("authStudio.detail.claimsInvalidObject"));
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 1000) {
      setClaimsError(t("authStudio.detail.claimsTooLarge"));
      return;
    }
    setClaimsError(null);
    try {
      await apiFetch(`${base}/users/${encodeURIComponent(uid)}/claims`, {
        method: "PUT",
        body: JSON.stringify({ claims: parsed }),
      });
      toast.success(t("authStudio.detail.claimsSavedToast"));
      refreshAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.detail.claimsSaveFailed")));
    }
  };

  const revokeAll = async () => {
    try {
      await apiFetch(`${base}/users/${encodeURIComponent(uid)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: "admin_revocation" }),
      });
      toast.success(t("authStudio.detail.revokeAllToast", { count: detail?.sessions.length ?? 0 }));
      refreshAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.detail.revokeFailed")));
    }
  };

  const resetMfa = async () => {
    try {
      await apiFetch(`${base}/users/${encodeURIComponent(uid)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: "mfa_reset" }),
      });
      if (user) {
        await apiFetch(`${base}/users/${encodeURIComponent(uid)}`, {
          method: "PATCH",
          body: JSON.stringify({
            metadata: { ...(user.metadata ?? {}), mfaResetAt: new Date().toISOString() },
          }),
        });
      }
      toast.success(t("authStudio.detail.mfaResetToast"));
      refreshAll();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.detail.mfaResetFailed")));
    }
  };

  const deleteUser = async () => {
    try {
      await apiFetch(`${base}/users/${encodeURIComponent(uid)}`, { method: "DELETE" });
      toast.success(t("authStudio.users.deletedToast"));
      onClose();
      onChanged();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.users.deleteFailed")));
    }
  };

  return (
    <ConsoleDetailSheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={user?.displayName || user?.email || t("authStudio.users.inspect")}
      description={uid}
      footer={
        <>
          <ConfirmDangerDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t("authStudio.users.deleteTitle")}
            description={t("authStudio.users.deleteDescription", { email: user?.email ?? uid })}
            confirmLabel={t("authStudio.users.deleteConfirm")}
            onConfirm={() => void deleteUser()}
          />
          <Button variant="destructive" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("authStudio.users.delete")}
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
            {t("authStudio.common.close")}
          </Button>
        </>
      }
    >
        <div className="min-h-0 flex-1">
          {isLoading ? (
            <LoadingState rows={6} columns={3} />
          ) : isError ? (
            <ErrorState
              title={t("common.errorTitle")}
              message={errorMessage(error, t("authStudio.detail.loadFailed"))}
              onRetry={() => void refetch()}
            />
          ) : !user ? null : (
            <Tabs defaultValue="profile" className="w-full">
              {/* Five tabs never fit the drawer's width: keep them on one
                  horizontally scrollable row instead of wrapping into a
                  ragged second line. */}
              <TabsList className="w-full flex-wrap justify-start">
                <TabsTrigger value="profile" className="shrink-0 text-[11px]">{t("authStudio.detail.tabProfile")}</TabsTrigger>
                <TabsTrigger value="claims" className="shrink-0 text-[11px]">{t("authStudio.detail.tabClaims")}</TabsTrigger>
                <TabsTrigger value="identities" className="shrink-0 text-[11px]">{t("authStudio.detail.tabIdentities")}</TabsTrigger>
                <TabsTrigger value="sessions" className="shrink-0 text-[11px]">{t("authStudio.detail.tabSessions")}</TabsTrigger>
                <TabsTrigger value="mfa" className="shrink-0 text-[11px]">{t("authStudio.detail.tabMfa")}</TabsTrigger>
              </TabsList>

              <TabsContent value="profile" forceMount className="space-y-3 pt-3 data-[state=inactive]:hidden">
                <p className="text-xs text-muted-foreground">{t("authStudio.detail.profileDescription")}</p>
                {profile ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="detail-email" className="text-xs">{t("authStudio.users.fieldEmail")}</Label>
                        <Input id="detail-email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} className="h-8 text-xs" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="detail-name" className="text-xs">{t("authStudio.users.fieldDisplayName")}</Label>
                        <Input id="detail-name" value={profile.displayName} onChange={(event) => setProfile({ ...profile, displayName: event.target.value })} className="h-8 text-xs" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="detail-photo" className="text-xs">{t("authStudio.users.fieldPhotoUrl")}</Label>
                        <Input id="detail-photo" value={profile.photoUrl} onChange={(event) => setProfile({ ...profile, photoUrl: event.target.value })} className="h-8 text-xs" />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="detail-phone" className="text-xs">{t("authStudio.users.fieldPhone")}</Label>
                        <Input id="detail-phone" value={profile.phoneNumber} onChange={(event) => setProfile({ ...profile, phoneNumber: event.target.value })} className="h-8 text-xs" />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label htmlFor="detail-password" className="text-xs">{t("authStudio.users.fieldPassword")}</Label>
                        <Input
                          id="detail-password"
                          type="password"
                          value={profile.password}
                          onChange={(event) => setProfile({ ...profile, password: event.target.value })}
                          placeholder={t("authStudio.users.passwordPlaceholder")}
                          className="h-8 text-xs"
                          autoComplete="new-password"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      {([
                        [t("authStudio.users.fieldEmailVerified"), profile.emailVerified, "emailVerified"],
                        [t("authStudio.users.fieldPhoneVerified"), profile.phoneVerified, "phoneVerified"],
                        [t("authStudio.users.fieldAnonymous"), profile.isAnonymous, "isAnonymous"],
                        [t("authStudio.users.fieldDisabled"), profile.isDisabled, "isDisabled"],
                      ] as const).map(([label, checked, key]) => (
                        <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            checked={checked}
                            onCheckedChange={(value) => setProfile({ ...profile, [key]: value })}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                    <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void saveProfile()}>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("authStudio.detail.saveProfile")}
                    </Button>
                  </div>
                ) : null}
              </TabsContent>

              <TabsContent value="claims" forceMount className="space-y-3 pt-3 data-[state=inactive]:hidden">
                <p className="text-xs text-muted-foreground">{t("authStudio.detail.claimsDescription")}</p>
                <JsonInspector
                  value={user?.customClaims ?? {}}
                  editable
                  initialText={claimsText}
                  onChange={(next) => { setClaimsText(next); setClaimsError(null); }}
                  minRows={10}
                />
                {claimsError ? (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription className="text-xs">{claimsError}</AlertDescription>
                  </Alert>
                ) : null}
                <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void saveClaims()}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("authStudio.detail.saveClaims")}
                </Button>
              </TabsContent>

              <TabsContent value="identities" forceMount className="space-y-3 pt-3 data-[state=inactive]:hidden">
                <p className="text-xs text-muted-foreground">{t("authStudio.detail.identitiesDescription")}</p>
                {(detail?.identities.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={<Fingerprint className="h-8 w-8 text-muted-foreground/60" />}
                    title={t("authStudio.detail.noIdentities")}
                  />
                ) : (
                  <div className="space-y-2">
                    {detail?.identities.map((identity) => (
                      <div key={identity.id} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant="outline" className="font-mono text-[10px] uppercase">{identity.provider}</Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{formatDate(identity.lastSignInAt)}</span>
                        </div>
                        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                          <span className="text-muted-foreground">{t("authStudio.detail.identityUserId")}</span>
                          <span className="break-all font-mono">{identity.providerUserId}</span>
                          <span className="text-muted-foreground">{t("authStudio.users.colCreated")}</span>
                          <span className="font-mono">{formatDate(identity.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="sessions" forceMount className="space-y-3 pt-3 data-[state=inactive]:hidden">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{t("authStudio.detail.sessionsDescription")}</p>
                  <ConfirmDangerDialog
                    open={revokeOpen}
                    onOpenChange={setRevokeOpen}
                    title={t("authStudio.detail.revokeAllTitle")}
                    description={t("authStudio.detail.revokeAllDescription")}
                    confirmLabel={t("authStudio.detail.revokeAllConfirm")}
                    onConfirm={() => void revokeAll()}
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    disabled={(detail?.sessions.length ?? 0) === 0}
                    onClick={() => setRevokeOpen(true)}
                  >
                    <RefreshCw className="h-3 w-3" />
                    {t("authStudio.detail.revokeAll")}
                  </Button>
                </div>
                {(detail?.sessions.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={<MonitorSmartphone className="h-8 w-8 text-muted-foreground/60" />}
                    title={t("authStudio.detail.noSessions")}
                  />
                ) : (
                  <div className="space-y-2">
                    {detail?.sessions.map((session) => (
                      <div key={session.id} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px]">{session.id.slice(0, 12)}...</span>
                          <Badge
                            variant={session.revoked || new Date(session.expiresAt).getTime() < Date.now() ? "destructive" : "secondary"}
                            className="font-mono text-[10px] uppercase"
                          >
                            {session.revoked || new Date(session.expiresAt).getTime() < Date.now()
                              ? t("authStudio.detail.sessionRevoked")
                              : t("authStudio.detail.sessionActive")}
                          </Badge>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
                          <div><span className="text-muted-foreground">{t("authStudio.detail.sessionCreated")}: </span><span className="font-mono">{formatDate(session.createdAt)}</span></div>
                          <div><span className="text-muted-foreground">{t("authStudio.detail.sessionExpires")}: </span><span className="font-mono">{formatDate(session.expiresAt)}</span></div>
                          <div><span className="text-muted-foreground">{t("authStudio.detail.sessionLastUsed")}: </span><span className="font-mono">{formatDate(session.lastUsedAt)}</span></div>
                          <div><span className="text-muted-foreground">{t("authStudio.detail.sessionRotation")}: </span><span className="font-mono">{session.rotationCounter}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="mfa" forceMount className="space-y-3 pt-3 data-[state=inactive]:hidden">
                <Alert>
                  <ShieldAlert className="h-4 w-4" />
                  <AlertTitle className="text-xs font-semibold">
                    {detail?.mfa.enabled ? t("authStudio.detail.mfaEnabled") : t("authStudio.detail.mfaDisabled")}
                  </AlertTitle>
                  <AlertDescription className="text-xs text-muted-foreground">
                    {t("authStudio.detail.mfaDescription")}
                    {detail?.mfa.factorType ? ` · ${detail.mfa.factorType}` : ""}
                  </AlertDescription>
                </Alert>
                <ConfirmDangerDialog
                  open={mfaResetOpen}
                  onOpenChange={setMfaResetOpen}
                  title={t("authStudio.detail.mfaResetTitle")}
                  description={t("authStudio.detail.mfaResetDescription")}
                  confirmLabel={t("authStudio.detail.mfaResetConfirm")}
                  onConfirm={() => void resetMfa()}
                />
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setMfaResetOpen(true)}>
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {t("authStudio.detail.mfaReset")}
                </Button>
              </TabsContent>
            </Tabs>
          )}
        </div>
    </ConsoleDetailSheet>
  );
}
