import type { ReactNode, ComponentType } from "react";
import { ThemeToggle as ConsoleThemeToggle, LocaleToggle } from "../patterns/shell/controls.js";
import { VellumLogo } from "./vellum-logo.js";

interface AuthShellProps {
  brand: string;
  eyebrow: string;
  title: string;
  description: string;
  features: { icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; title: string; detail: string }[];
  footer: string;
  children: ReactNode;
}

/** Shared presentation only. Each app owns its routes, forms and auth state. */
export function AuthShell({ brand, eyebrow, title, description, features, footer, children }: AuthShellProps) {
  return (
    <div className="auth-shell">
      <header className="auth-shell-header">
        <div className="auth-brand"><VellumLogo size={30} /><span className="auth-brand-full">{brand}</span><span className="auth-brand-short" aria-hidden="true">Vellum</span></div>
        <div className="auth-controls"><ConsoleThemeToggle /><LocaleToggle /></div>
      </header>
      <div className="auth-shell-body">
        <aside className="auth-story" aria-label={eyebrow}>
          <div className="auth-story-copy">
            <p className="auth-eyebrow"><span aria-hidden="true" />{eyebrow}</p>
            <h2>{title}</h2>
            <p className="auth-story-description">{description}</p>
          </div>
          <div className="auth-features">
            {features.map(({ icon: Icon, title: featureTitle, detail }) => (
              <div className="auth-feature" key={featureTitle}>
                <span className="auth-feature-icon"><Icon className="size-4" aria-hidden={true} /></span>
                <div><p>{featureTitle}</p><span>{detail}</span></div>
              </div>
            ))}
          </div>
          <p className="auth-story-footer">{footer}</p>
        </aside>
        <main className="auth-main"><div className="auth-form">{children}</div></main>
      </div>
    </div>
  );
}
