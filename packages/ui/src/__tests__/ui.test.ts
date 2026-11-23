import { describe, it, expect } from "vitest";
import { cn } from "../lib/cn.js";
import { buttonVariants } from "../components/button.js";
import { badgeVariants } from "../components/badge.js";
import { toggleVariants } from "../components/toggle.js";

describe("@vellum/ui - Utilities & Design Tokens", () => {
  it("merges class names correctly with twMerge", () => {
    expect(cn("px-2 py-1", "bg-red-500")).toBe("px-2 py-1 bg-red-500");
    expect(cn("p-4", "p-2")).toBe("p-2");
    const isHidden = false;
    expect(cn("text-red-500", isHidden ? "hidden" : null, null, undefined, "font-bold")).toBe(
      "text-red-500 font-bold"
    );
  });

  it("produces correct button variants for all semantic roles", () => {
    const defaultBtn = buttonVariants({ variant: "default" });
    expect(defaultBtn).toContain("bg-primary");

    const destructiveBtn = buttonVariants({ variant: "destructive" });
    expect(destructiveBtn).toContain("bg-destructive");

    const outlineBtn = buttonVariants({ variant: "outline" });
    expect(outlineBtn).toContain("border-border");

    const secondaryBtn = buttonVariants({ variant: "secondary" });
    expect(secondaryBtn).toContain("bg-secondary");

    const ghostBtn = buttonVariants({ variant: "ghost" });
    expect(ghostBtn).toContain("hover:bg-muted");

    const linkBtn = buttonVariants({ variant: "link" });
    expect(linkBtn).toContain("underline-offset-4");

    const smBtn = buttonVariants({ size: "sm" });
    expect(smBtn).toContain("h-7");

    const lgBtn = buttonVariants({ size: "lg" });
    expect(lgBtn).toContain("h-9");
  });

  it("produces correct badge variants for semantic status indicators", () => {
    const defaultBadge = badgeVariants({ variant: "default" });
    expect(defaultBadge).toContain("bg-primary");

    const solidBadge = badgeVariants({ variant: "solid" });
    expect(solidBadge).toContain("bg-primary");

    const successBadge = badgeVariants({ variant: "success" });
    expect(successBadge).toContain("bg-success-500/10");
    expect(successBadge).toContain("text-success-700");
    expect(successBadge).toContain("dark:text-success-300");

    const warningBadge = badgeVariants({ variant: "warning" });
    expect(warningBadge).toContain("bg-warning-500/12");
    expect(warningBadge).toContain("text-warning-700");

    const dangerBadge = badgeVariants({ variant: "danger" });
    expect(dangerBadge).toContain("bg-danger-500/10");
    expect(dangerBadge).toContain("text-danger-700");

    const infoBadge = badgeVariants({ variant: "info" });
    expect(infoBadge).toContain("bg-info-500/10");
    expect(infoBadge).toContain("text-info-700");
  });

  it("produces correct toggle variants and sizes", () => {
    const defaultToggle = toggleVariants({ variant: "default" });
    expect(defaultToggle).toContain("hover:bg-muted");

    const outlineToggle = toggleVariants({ variant: "outline" });
    expect(outlineToggle).toContain("border border-input");

    const smToggle = toggleVariants({ size: "sm" });
    expect(smToggle).toContain("h-8");
  });
});

describe("@vellum/ui - Component Exports Verification", () => {
  it("exports all required foundation and composed components", async () => {
    const ui = await import("../index.js");

    // Utilities & Hooks
    expect(ui.cn).toBeDefined();
    expect(ui.useTheme).toBeDefined();
    expect(ui.useToast).toBeDefined();
    expect(ui.useMediaQuery).toBeDefined();

    // Foundation
    expect(ui.Button).toBeDefined();
    expect(ui.Input).toBeDefined();
    expect(ui.Textarea).toBeDefined();
    expect(ui.Select).toBeDefined();
    expect(ui.Checkbox).toBeDefined();
    expect(ui.RadioGroup).toBeDefined();
    expect(ui.RadioGroupItem).toBeDefined();
    expect(ui.Switch).toBeDefined();
    expect(ui.Slider).toBeDefined();
    expect(ui.Label).toBeDefined();
    expect(ui.Form).toBeDefined();
    expect(ui.Card).toBeDefined();
    expect(ui.Separator).toBeDefined();
    expect(ui.ScrollArea).toBeDefined();
    expect(ui.ResizablePanelGroup).toBeDefined();
    expect(ui.AspectRatio).toBeDefined();
    expect(ui.Dialog).toBeDefined();
    expect(ui.Sheet).toBeDefined();
    expect(ui.AlertDialog).toBeDefined();
    expect(ui.Drawer).toBeDefined();
    expect(ui.Popover).toBeDefined();
    expect(ui.HoverCard).toBeDefined();
    expect(ui.Tooltip).toBeDefined();
    expect(ui.DropdownMenu).toBeDefined();
    expect(ui.ContextMenu).toBeDefined();
    expect(ui.Menubar).toBeDefined();
    expect(ui.NavigationMenu).toBeDefined();
    expect(ui.Alert).toBeDefined();
    expect(ui.Skeleton).toBeDefined();
    expect(ui.Progress).toBeDefined();
    expect(ui.Spinner).toBeDefined();
    expect(ui.Sonner).toBeDefined();
    expect(ui.Toaster).toBeDefined();
    expect(ui.Badge).toBeDefined();
    expect(ui.Avatar).toBeDefined();
    expect(ui.Calendar).toBeDefined();
    expect(ui.DatePicker).toBeDefined();
    expect(ui.Table).toBeDefined();
    expect(ui.Tabs).toBeDefined();
    expect(ui.Accordion).toBeDefined();
    expect(ui.Collapsible).toBeDefined();
    expect(ui.Toggle).toBeDefined();
    expect(ui.ToggleGroup).toBeDefined();
    expect(ui.Breadcrumb).toBeDefined();
    expect(ui.Pagination).toBeDefined();
    expect(ui.Command).toBeDefined();
    expect(ui.Carousel).toBeDefined();
    expect(ui.CodeEditor).toBeDefined();
    expect(ui.JsonViewer).toBeDefined();
    expect(ui.ThemeProvider).toBeDefined();

    // Composed Primitives
    expect(ui.AppShell).toBeDefined();
    expect(ui.Sidebar).toBeDefined();
    expect(ui.SidebarSection).toBeDefined();
    expect(ui.SidebarItem).toBeDefined();
    expect(ui.Topbar).toBeDefined();
    expect(ui.PageHeader).toBeDefined();
    expect(ui.PageContent).toBeDefined();
    expect(ui.DataGrid).toBeDefined();
    expect(ui.EmptyState).toBeDefined();
    expect(ui.ErrorState).toBeDefined();
    expect(ui.LoadingState).toBeDefined();
    expect(ui.StatCard).toBeDefined();
    expect(ui.KpiRow).toBeDefined();
    expect(ui.CopyButton).toBeDefined();
    expect(ui.ConfirmDialog).toBeDefined();
    expect(ui.KeyValueList).toBeDefined();
    expect(ui.PropertyList).toBeDefined();
    expect(ui.FieldTypeBadge).toBeDefined();
    expect(ui.TimestampDisplay).toBeDefined();
    expect(ui.TruncatedText).toBeDefined();
    expect(ui.CommandPalette).toBeDefined();
    expect(ui.ThemeToggle).toBeDefined();
    expect(ui.BadgeGroup).toBeDefined();

    // Domain Components
    expect(ui.DocumentTree).toBeDefined();
    expect(ui.DocumentCard).toBeDefined();
    expect(ui.QueryBuilderRow).toBeDefined();
    expect(ui.QueryBuilderGroup).toBeDefined();
    expect(ui.OrderByRow).toBeDefined();
    expect(ui.RulesEditor).toBeDefined();
    expect(ui.RulesSimulator).toBeDefined();
    expect(ui.IndexFieldsRow).toBeDefined();
    expect(ui.ApiKeyCard).toBeDefined();
    expect(ui.ApiKeyRevealDialog).toBeDefined();
    expect(ui.UsageChart).toBeDefined();
    expect(ui.QuotaBar).toBeDefined();
    expect(ui.ClusterHealthCard).toBeDefined();
    expect(ui.AuditLogRow).toBeDefined();
    expect(ui.TenantCard).toBeDefined();
    // Importing the whole barrel pulls in CodeMirror/Recharts/Radix graphs.
    // Under CI load this can approach the default 5s Vitest timeout, so give
    // the dynamic-import assertion an explicit, generous budget.
  }, 30_000);
});
