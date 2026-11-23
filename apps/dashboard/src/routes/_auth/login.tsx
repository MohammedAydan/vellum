import * as React from "react";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { Route as authRoute } from "../_auth.js";
import { useForm } from "react-hook-form";
import { zodResolver } from "../../lib/zod-resolver.js";
import { z } from "zod";
import {
  Card,
  CardHeader,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Input,
  Label,
  Alert,
  AlertDescription,
  useI18n,
} from "@vellum/ui";
import { useAuth } from "../../providers/auth-provider.js";
import { apiFetch } from "../../lib/api.js";
import { getSafeRedirectFromSearch } from "../../lib/auth.js";

/** Validation messages are built from the active locale so inline errors flip with the UI. */
function makeLoginSchema(t: (key: string) => string) {
  return z.object({
    email: z.string().email(t("auth.validationEmail")),
    password: z.string().min(6, t("auth.validationPassword")),
  });
}

type LoginFormData = z.infer<ReturnType<typeof makeLoginSchema>>;

export const Route = createRoute({
  getParentRoute: () => authRoute,
  path: "/login",
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const schema = React.useMemo(() => makeLoginSchema(t), [t]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    try {
      const res = await apiFetch<{
        user: { id: string; email: string; name: string };
        token?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresAt: string;
      }>("/v1/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify(data),
      });

      login({
        user: res.user,
        token: res.accessToken ?? res.token ?? "",
        refreshToken: res.refreshToken ?? res.accessToken ?? "",
        expiresAt: res.expiresAt,
      });

      const target = getSafeRedirectFromSearch(undefined, "/app");
      await navigate({ to: target as "/app" });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("auth.signInError"));
    }
  };

  return (
    <Card className="auth-card">
      <CardHeader className="auth-form-heading">
        <h1 className="auth-form-title">{t("auth.signInTitle")}</h1>
        <CardDescription>{t("auth.signInDescription")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              dir="ltr"
              type="email"
              autoComplete="email"
              placeholder="developer@example.com"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              {...register("email")}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="text-xs text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t("auth.password")}</Label>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : undefined}
              {...register("password")}
            />
            {errors.password && (
              <p id="password-error" role="alert" className="text-xs text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>
        </CardContent>
        <CardFooter className="auth-form-footer">
          <Button type="submit" className="auth-submit" disabled={isSubmitting}>
            {isSubmitting ? t("auth.signingIn") : t("auth.signIn")}
          </Button>
          <div className="text-center text-xs text-muted-foreground">
            {t("auth.noAccount")}{" "}
            <Link to="/signup" className="text-primary hover:underline font-medium">
              {t("auth.createAccountLink")}
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
