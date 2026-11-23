import * as React from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Route as authRoute } from "../_auth.js";
import { useAdminAuth } from "../../providers/auth-provider.js";
import { adminFetch } from "../../lib/api.js";
import { getSafeRedirectFromSearch } from "../../lib/auth.js";
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Input,
  Label,
  Badge,
  Alert,
  AlertDescription,
  useI18n,
} from "@vellum/ui";
import { ArrowRight, Lock, KeyRound, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createRoute({
  getParentRoute: () => authRoute,
  path: "/login",
  component: AdminLoginPage,
});

interface SetupStatusResponse {
  initialized: boolean;
  ownerCount: number;
  requiresSetup: boolean;
  totalUsers: number;
  tokenRequired: boolean;
}

interface AdminAuthResponse {
  success: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    platformRole: "owner" | "admin" | "support_readonly";
  };
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: string;
}

function AdminLoginPage() {
  const navigate = useNavigate();
  const { login } = useAdminAuth();
  const { t } = useI18n();

  const [isCheckingSetup, setIsCheckingSetup] = React.useState(true);
  const [requiresSetup, setRequiresSetup] = React.useState(false);
  const [tokenRequired, setTokenRequired] = React.useState(false);
  const [statusFailed, setStatusFailed] = React.useState(false);

  // Setup form states — data defaults, intentionally not translated.
  const [setupName, setSetupName] = React.useState("Platform Master Owner");
  const [setupEmail, setSetupEmail] = React.useState("owner@example.com");
  const [setupPassword, setSetupPassword] = React.useState("");
  const [setupToken, setSetupToken] = React.useState("");

  // Login form states
  const [email, setEmail] = React.useState("owner@example.com");
  const [password, setPassword] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);

  // Check setup status on load
  React.useEffect(() => {
    let mounted = true;
    async function checkStatus() {
      try {
        const res = await adminFetch<SetupStatusResponse>("/v1/admin/setup-status");
        if (mounted) {
          // Trust the server only. A failed/ambiguous probe must never open the
          // one-time owner setup to an anonymous visitor.
          setRequiresSetup(res.requiresSetup === true);
          setTokenRequired(res.tokenRequired === true);
        }
      } catch {
        // Fail closed: show the normal login form plus a clear error instead
        // of silently granting access to the master-owner bootstrap screen.
        if (mounted) setStatusFailed(true);
      } finally {
        if (mounted) setIsCheckingSetup(false);
      }
    }
    void checkStatus();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSetupOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupName.trim() || !setupEmail.trim()) {
      toast.error(t("admin.login.setupRequiredFields"));
      return;
    }
    if (tokenRequired && !setupToken.trim()) {
      toast.error(t("admin.login.setupTokenRequired"));
      return;
    }
    setIsLoading(true);

    try {
      const res = await adminFetch<AdminAuthResponse>("/v1/admin/setup-owner", {
        method: "POST",
        ...(tokenRequired ? { headers: { "x-setup-token": setupToken.trim() } } : {}),
        body: JSON.stringify({
          name: setupName.trim(),
          email: setupEmail.trim().toLowerCase(),
          password: setupPassword,
        }),
      });

      login({
        user: res.user,
        token: res.accessToken ?? res.token ?? "",
        refreshToken: res.refreshToken ?? res.accessToken ?? "",
        expiresAt: res.expiresAt,
      });

      toast.success(t("admin.login.setupSuccess"));
      const target = getSafeRedirectFromSearch(undefined, "/");
      await navigate({ to: target as "/" });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("admin.login.setupError"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      toast.error(t("admin.login.emailRequired"));
      return;
    }
    setIsLoading(true);

    try {
      const res = await adminFetch<AdminAuthResponse>("/v1/admin/login", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      login({
        user: res.user,
        token: res.accessToken ?? res.token ?? "",
        refreshToken: res.refreshToken ?? res.accessToken ?? "",
        expiresAt: res.expiresAt,
      });

      toast.success(t("admin.login.welcome", {
        name: res.user.name,
        role: res.user.platformRole,
      }));
      const target = getSafeRedirectFromSearch(undefined, "/");
      await navigate({ to: target as "/" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("admin.login.authFailed");
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  if (isCheckingSetup) {
    return (
      <>
        <Card className="auth-card p-8 text-center">
          <div className="flex flex-col items-center justify-center space-y-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-xs text-muted-foreground font-mono">{t("admin.login.verifying")}</p>
          </div>
        </Card>
      </>
    );
  }

  // 1. First-Time Setup Screen
  if (requiresSetup) {
    return (
      <>
        <Card className="auth-card">
          <CardHeader className="auth-form-heading">
            <h1 className="auth-form-title">{t("admin.login.setupTitle")}</h1>
            <CardDescription className="text-sm text-muted-foreground">
              {t("admin.login.setupDesc")}
            </CardDescription>
            <div className="auth-form-footer">
              <Badge
                variant="outline"
                className="auth-context-badge"
              >
                <KeyRound className="h-3 w-3" />
                {t("admin.login.initialProvisioning")}
              </Badge>
            </div>
          </CardHeader>
          <form onSubmit={handleSetupOwner}>
            <CardContent className="space-y-4">
              <Alert className="border-amber-500/20 bg-amber-500/5 text-amber-800 dark:text-amber-300 py-2.5">
                <CheckCircle2 className="h-4 w-4" />
                <h2 className="mb-1 text-xs font-semibold">{t("admin.login.oneTimeSetup")}</h2>
                <AlertDescription className="text-[11px] leading-tight mt-0.5">
                  {t("admin.login.oneTimeSetupPrefix")}
                  <strong>{t("admin.login.ownerRole")}</strong>
                  {t("admin.login.oneTimeSetupMiddle")}
                  <code>control_db</code>
                  {t("admin.login.oneTimeSetupSuffix")}
                </AlertDescription>
              </Alert>

              <div className="space-y-1.5">
                <Label htmlFor="setupName" className="text-xs font-medium">{t("admin.login.masterFullName")}</Label>
                <Input
                  id="setupName"
                  autoComplete="name"
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  placeholder={t("admin.login.masterNamePlaceholder")}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setupEmail" className="text-xs font-medium">{t("admin.login.masterEmail")}</Label>
                <Input
                  id="setupEmail"
                  dir="ltr"
                  autoComplete="email"
                  type="email"
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  placeholder="owner@example.com"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="setupPassword" className="text-xs font-medium">{t("admin.login.masterSecret")}</Label>
                <Input
                  id="setupPassword"
                  autoComplete="new-password"
                  type="password"
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  placeholder="••••••••••••"
                />
              </div>
              {tokenRequired && (
                <div className="space-y-1.5">
                  <Label htmlFor="setupToken" className="text-xs font-medium">{t("admin.login.setupToken")}</Label>
                  <Input
                    id="setupToken"
                    type="password"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder={t("admin.login.setupTokenPlaceholder")}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">{t("admin.login.setupTokenHint")}</p>
                </div>
              )}
            </CardContent>
            <CardFooter className="auth-form-footer">
              <Button
                type="submit"
                className="auth-submit"
                disabled={isLoading}
              >
                <span>{isLoading ? t("admin.login.initializing") : t("admin.login.initializeOwner")}</span>
                <ArrowRight className="h-4 w-4 ms-1.5 rtl:rotate-180" />
              </Button>
            </CardFooter>
          </form>
        </Card>
      </>
    );
  }

  // 2. Returning Operator Login Screen
  return (
    <>
      <Card className="auth-card">
        <CardHeader className="auth-form-heading">
          <h1 className="auth-form-title">{t("admin.login.title")}</h1>
          <CardDescription className="text-sm text-muted-foreground">
            {t("admin.login.description")}
          </CardDescription>
          <div className="auth-form-footer">
            <Badge
              variant="outline"
              className="auth-context-badge"
            >
              <Lock className="h-3 w-3" />
              {t("admin.login.privacyEnforced")}
            </Badge>
          </div>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent className="space-y-4">
            {statusFailed && (
              <Alert className="border-rose-500/20 bg-rose-500/5 text-rose-600 dark:text-rose-400 py-2.5">
                <AlertDescription className="text-[11px] leading-tight">
                  {t("admin.login.setupStatusFailed")}
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-medium">{t("admin.login.operatorEmail")}</Label>
              <Input
                id="email"
                dir="ltr"
                autoComplete="username"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@example.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-medium">{t("admin.login.operatorPassword")}</Label>
              <Input
                id="password"
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>
          </CardContent>
          <CardFooter className="auth-form-footer">
            <Button
              type="submit"
              className="auth-submit"
              disabled={isLoading}
            >
              <span>{isLoading ? t("admin.login.authenticating") : t("admin.login.authenticate")}</span>
              <ArrowRight className="h-4 w-4 ms-1.5 rtl:rotate-180" />
            </Button>
          </CardFooter>
        </form>
      </Card>
    </>
  );
}
