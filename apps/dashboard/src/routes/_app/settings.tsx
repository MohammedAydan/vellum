import * as React from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Route as appRoute } from "../_app.js";
import { apiFetch } from "../../lib/api.js";
import {
  ConfigurablePageHeader,
  ConsoleCopyableField,
  PageContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
  Alert,
  AlertTitle,
  AlertDescription,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  Input,
  LoadingState,
  ErrorState,
  KeyValueRow,
  CopyButton,
  useI18n,
} from "@vellum/ui";
import { ShieldCheck, Smartphone, KeyRound, Lock } from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app/settings",
  component: SettingsPage,
});

interface MfaStatus {
  enabled: boolean;
}

interface MfaSetup {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

type Step = "idle" | "setup" | "verify" | "enabled" | "disable";

function SettingsPage() {
  const { t } = useI18n();
  const [step, setStep] = React.useState<Step>("idle");
  const [setup, setSetup] = React.useState<MfaSetup | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    data: status,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["mfa", "status"],
    queryFn: () => apiFetch<MfaStatus>("/v1/auth/mfa/status"),
  });

  React.useEffect(() => {
    if (status && step === "idle") setStep(status.enabled ? "enabled" : "idle");
  }, [status, step]);

  const handleBeginSetup = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<MfaSetup>("/v1/auth/mfa/setup", { method: "POST" });
      setSetup(res);
      setCode("");
      setStep("setup");
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : t("settings.setupFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6) {
      setFormError(t("settings.codePrompt"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await apiFetch<{ enabled: true }>("/v1/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setStep("enabled");
      setSetup(null);
      setCode("");
      await refetch();
      toast.success(t("settings.mfaEnabledToast"));
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : t("auth.invalidCode"));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (code.length < 6) {
      setFormError(t("settings.disableCodePrompt"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await apiFetch<{ enabled: false }>("/v1/auth/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setStep("idle");
      setCode("");
      await refetch();
      toast.success(t("settings.mfaDisabledToast"));
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : t("settings.disableFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <LoadingState rows={4} columns={2} />;
  if (isError) {
    return (
      <ErrorState
        title={t("common.errorTitle")}
        message={error instanceof Error ? error.message : t("settings.loadFailed")}
        onRetry={() => void refetch()}
      />
    );
  }

  const enabled = step === "enabled" || status?.enabled === true;

  return (
    <PageContent>
      <ConfigurablePageHeader
        title={t("settings.title")}
        description={t("settings.description")}
        actions={
          <Badge variant={enabled ? "secondary" : "outline"} className="gap-1 font-mono text-[10px]">
            <ShieldCheck className="h-3 w-3" />
            {t("settings.mfaStatus", { state: enabled ? t("common.enabled") : t("common.disabled") })}
          </Badge>
        }
      />

      <Card className="max-w-2xl">
        <CardHeader className="border-b">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">{t("menu.twoFactor")}</CardTitle>
          </div>
          <CardDescription className="text-xs">
            {t("settings.mfaDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          {formError && (
            <Alert variant="destructive">
              <AlertTitle>{t("settings.formErrorTitle")}</AlertTitle>
              <AlertDescription className="text-xs">{formError}</AlertDescription>
            </Alert>
          )}

          {step === "idle" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t("settings.notEnabled")}
              </p>
              <Button onClick={() => void handleBeginSetup()} disabled={busy}>
                <ShieldCheck className="size-4 me-2" />
                {busy ? t("settings.preparing") : t("settings.enableMfa")}
              </Button>
            </div>
          )}

          {step === "setup" && setup && (
            <div className="space-y-4">
              <Alert>
                <AlertTitle className="text-xs font-semibold">{t("settings.step1")}</AlertTitle>
                <AlertDescription className="text-xs">
                  {t("settings.step1Description")}
                </AlertDescription>
              </Alert>
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <ConsoleCopyableField label={t("settings.totpSecret")} value={setup.secret} />
                <KeyValueRow
                  label="otpauth URI"
                  value={
                    <div className="flex items-center gap-2">
                      <a
                        href={setup.otpauthUri}
                        className="font-mono text-[11px] text-primary hover:underline truncate max-w-sm"
                      >
                        {setup.otpauthUri}
                      </a>
                      <CopyButton value={setup.otpauthUri} successMessage={t("common.copied")} title={t("common.copyToClipboard")} />
                    </div>
                  }
                />
              </div>

              <div className="space-y-2">
                <span className="text-xs font-semibold">{t("settings.step2")}</span>
                <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
                  {setup.recoveryCodes.map((rc) => (
                    <code key={rc} className="font-mono text-xs">{rc}</code>
                  ))}
                </div>
                <CopyButton value={setup.recoveryCodes.join("\n")} successMessage={t("common.copied")} title={t("common.copyToClipboard")} />
              </div>

              <div className="space-y-2 border-t pt-4">
                <span className="text-xs font-semibold">{t("settings.step3")}</span>
                <InputOTP maxLength={6} value={code} onChange={setCode}>
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
                  </InputOTPGroup>
                </InputOTP>
                <Button onClick={() => void handleVerify()} disabled={busy || code.length !== 6}>
                  {busy ? t("auth.mfaVerifying") : t("settings.verifyEnable")}
                </Button>
              </div>
            </div>
          )}

          {step === "enabled" && (
            <div className="space-y-4">
              <Alert>
                <ShieldCheck className="h-4 w-4 text-success" />
                <AlertTitle className="text-xs font-semibold text-success-600 dark:text-success-400">
                  {t("settings.mfaActive")}
                </AlertTitle>
                <AlertDescription className="text-xs">
                  {t("settings.mfaActiveDescription")}
                </AlertDescription>
              </Alert>
              <div className="space-y-2 border-t pt-4">
                <span className="text-xs font-semibold flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" /> {t("settings.disableLabel")}
                </span>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  placeholder={t("settings.codePlaceholder")}
                  className="font-mono text-xs max-w-xs"
                />
                <Button variant="destructive" onClick={() => void handleDisable()} disabled={busy || code.length < 6}>
                  <Lock className="size-3.5 me-1.5" />
                  {busy ? t("settings.disabling") : t("settings.disableMfa")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="border-t text-[11px] text-muted-foreground">
          {t("settings.footer")}
        </CardFooter>
      </Card>
    </PageContent>
  );
}
