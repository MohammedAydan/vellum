import * as React from "react";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { Route as authRoute } from "../_auth.js";
import { apiFetch } from "../../lib/api.js";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Label,
  Alert,
  AlertDescription,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  useI18n,
} from "@vellum/ui";

export const Route = createRoute({
  getParentRoute: () => authRoute,
  path: "/mfa",
  component: MfaPage,
});

function MfaPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [code, setCode] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch<{ enabled: true }>("/v1/auth/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      await navigate({ to: "/app" });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("auth.invalidCode"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="shadow-lg border-border/80">
      <CardHeader className="space-y-1">
        <CardTitle className="text-xl">{t("auth.mfaTitle")}</CardTitle>
        <CardDescription>{t("auth.mfaDescription")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col items-center space-y-3">
            <Label htmlFor="code" className="text-xs text-muted-foreground">
              {t("auth.mfaCodeLabel")}
            </Label>
            <InputOTP
              id="code"
              maxLength={6}
              value={code}
              onChange={(value) => setCode(value)}
              autoFocus
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
              </InputOTPGroup>
            </InputOTP>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-3">
          <Button type="submit" className="w-full" disabled={code.length < 6 || submitting}>
            {submitting ? t("auth.mfaVerifying") : t("auth.mfaVerify")}
          </Button>
          <Link to="/login" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            {t("auth.mfaBack")}
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
