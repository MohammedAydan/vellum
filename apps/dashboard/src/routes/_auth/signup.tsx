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

function makeSignupSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(2, t("auth.validationName")),
    email: z.string().email(t("auth.validationEmail")),
    password: z.string().min(6, t("auth.validationPassword")),
  });
}

type SignupFormData = z.infer<ReturnType<typeof makeSignupSchema>>;

export const Route = createRoute({
  getParentRoute: () => authRoute,
  path: "/signup",
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { t } = useI18n();
  const [error, setError] = React.useState<string | null>(null);
  const schema = React.useMemo(() => makeSignupSchema(t), [t]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: SignupFormData) => {
    setError(null);
    try {
      const res = await apiFetch<{
        user: { id: string; email: string; name: string };
        token?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresAt: string;
      }>("/v1/auth/sign-up/email", {
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
      setError(err instanceof Error ? err.message : t("auth.signupError"));
    }
  };

  return (
    <Card className="auth-card">
      <CardHeader className="auth-form-heading">
        <h1 className="auth-form-title">{t("auth.signupTitle")}</h1>
        <CardDescription>{t("auth.signupDescription")}</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="name">{t("auth.fullName")}</Label>
            <Input
              id="name"
              autoComplete="name"
              placeholder={t("auth.namePlaceholder")}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "name-error" : undefined}
              {...register("name")}
            />
            {errors.name && (
              <p id="name-error" role="alert" className="text-xs text-destructive">
                {errors.name.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              dir="ltr"
              type="email"
              autoComplete="email"
              placeholder="alice@example.com"
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
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
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
            {isSubmitting ? t("auth.creatingAccount") : t("auth.createAccount")}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t("legal.signupConsentPrefix")}{" "}
            <Link to="/terms" className="text-primary hover:underline">{t("legal.terms")}</Link>{" "}
            {t("legal.and")}{" "}
            <Link to="/privacy" className="text-primary hover:underline">{t("legal.privacy")}</Link>.
          </p>
          <div className="text-center text-xs text-muted-foreground">
            {t("auth.alreadyAccount")}{" "}
            <Link to="/login" className="text-primary hover:underline font-medium">
              {t("auth.signInLink")}
            </Link>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
