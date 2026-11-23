// Brand
export * from "./components/vellum-logo.js";

// Utility
export * from "./lib/cn.js";

// Internationalisation (English / Arabic, RTL-aware)
export * from "./i18n/index.js";

// Foundation Components
export * from "./components/button.js";
export * from "./components/input.js";
export * from "./components/textarea.js";
export * from "./components/label.js";
export * from "./components/form.js";
export * from "./components/badge.js";
export * from "./components/beta-badge.js";
export * from "./components/card.js";
export * from "./components/separator.js";
export * from "./components/scroll-area.js";
export * from "./components/resizable.js";
export * from "./components/aspect-ratio.js";
export * from "./components/dialog.js";
export * from "./components/sheet.js";
export * from "./components/alert-dialog.js";
export * from "./components/drawer.js";
export * from "./components/popover.js";
export * from "./components/hover-card.js";
export * from "./components/tooltip.js";
export * from "./components/dropdown-menu.js";
export * from "./components/context-menu.js";
export * from "./components/menubar.js";
export * from "./components/navigation-menu.js";
export * from "./components/select.js";
export * from "./components/checkbox.js";
export * from "./components/radio-group.js";
export * from "./components/switch.js";
export * from "./components/slider.js";
export * from "./components/tabs.js";
export * from "./components/accordion.js";
export * from "./components/collapsible.js";
export * from "./components/toggle.js";
export * from "./components/toggle-group.js";
export * from "./components/avatar.js";
export * from "./components/alert.js";
export * from "./components/skeleton.js";
export * from "./components/progress.js";
export * from "./components/spinner.js";
export * from "./components/sonner.js";
export * from "./components/table.js";
export * from "./components/breadcrumb.js";
export * from "./components/pagination.js";
export * from "./components/calendar.js";
export * from "./components/date-picker.js";
export * from "./components/command.js";
export * from "./components/carousel.js";
export * from "./components/code-editor.js";
export * from "./components/json-viewer.js";
export * from "./components/theme-provider.js";
export {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./components/sidebar.js";
export * from "./components/chart.js";
export * from "./components/input-otp.js";
export * from "./components/kbd.js";
export * from "./components/empty.js";
export * from "./components/button-group.js";
export * from "./components/field.js";
export * from "./components/item.js";
export * from "./components/input-group.js";

// Composed Primitives
export {
  AppShell,
  Topbar,
  PageHeader,
  PageContent,
  StatCard,
  KpiRow,
  ThemeToggle,
  SearchField,
  Divider,
  Sidebar,
  SidebarSection,
  SidebarItem,
  type AppShellProps,
  type TopbarProps,
  type PageHeaderProps,
  type StatCardProps,
  type SidebarProps,
  type SidebarSectionProps,
  type SidebarItemProps,
} from "./primitives/app-shell.js";
export * from "./primitives/data-grid.js";
export * from "./primitives/field-badge.js";
export * from "./primitives/copy-button.js";
export * from "./primitives/empty-state.js";
export * from "./primitives/loading-state.js";
export * from "./primitives/error-state.js";
export * from "./primitives/confirm-dialog.js";
export * from "./primitives/property-list.js";
export * from "./primitives/timestamp-display.js";
export * from "./primitives/truncated-text.js";
export * from "./primitives/command-palette.js";
export * from "./primitives/badge-group.js";

// Domain-Specific Components
export * from "./domain/document-tree.js";
export * from "./domain/document-card.js";
export * from "./domain/query-builder.js";
export * from "./domain/rules-editor.js";
export * from "./domain/index-fields-row.js";
export * from "./domain/api-key.js";
export * from "./domain/usage-chart.js";
export * from "./domain/quota-bar.js";
export * from "./domain/cluster-health.js";
export * from "./domain/audit-log.js";
export * from "./domain/tenant-card.js";

// Hooks
export * from "./hooks/use-theme.js";
export * from "./hooks/use-toast.js";
export * from "./hooks/use-media-query.js";
export * from "./hooks/use-mobile.js";

// Providers (theme + direction)
export * from "./providers/theme-provider.js";
export * from "./providers/direction-provider.js";

// Shared enterprise patterns (RTL-safe). Exported explicitly to resolve name
// collisions with the legacy primitives above: the legacy names keep their
// original bindings (apps depend on them), while the new canonical patterns
// are exposed with a `Console*` prefix where a name would otherwise clash.
export {
  ConsoleShell,
  type ConsoleShellProps,
  type ConsoleNavItem,
  type ConsoleNavSection,
  PageHeader as ConfigurablePageHeader,
  type PageHeaderProps as ConfigurablePageHeaderProps,
  CommandPalette as ConsoleCommandPalette,
  type CommandPaletteProps as ConsoleCommandPaletteProps,
  type CommandPaletteAction,
  useCommandPaletteShortcut,
  ThemeToggle as ConsoleThemeToggle,
  type ThemeToggleProps as ConsoleThemeToggleProps,
  LocaleToggle,
  type LocaleToggleProps,
  OrgProjectBreadcrumb,
  type OrgProjectBreadcrumbProps,
} from "./patterns/shell/index.js";
export {
  DataTable,
  type DataTableProps,
  type DataTableColumn,
  type DataTablePagination,
  KpiMetricCard,
  type KpiMetricCardProps,
  UsageProgressMeter,
  type UsageProgressMeterProps,
  StatusBadge,
  type StatusBadgeProps,
  ErrorAlert,
  type ErrorAlertProps,
  AsyncRegion,
  type AsyncRegionProps,
  DetailSheet as ConsoleDetailSheet,
  type DetailSheetProps as ConsoleDetailSheetProps,
  ConfirmDangerDialog,
  type ConfirmDangerDialogProps,
  KeyValueList as ConsoleKeyValueList,
  type KeyValueListProps as ConsoleKeyValueListProps,
  type KeyValueListItem,
} from "./patterns/data/index.js";
export {
  CodeBlock,
  type CodeBlockProps,
  type CodeBlockTab,
  CopyableField as ConsoleCopyableField,
  type CopyableFieldProps as ConsoleCopyableFieldProps,
  JsonInspector,
  type JsonInspectorProps,
  DocsShell,
  type DocsShellProps,
  DocsSidebar,
  type DocsSidebarProps,
  DocsToc,
  type DocsTocProps,
  DocsCallout,
  type DocsCalloutProps,
  HttpMethodBadge,
  type HttpMethodBadgeProps,
  DOCS_OPEN_SEARCH_EVENT,
} from "./patterns/dev/index.js";

export * from "./components/auth-shell.js";
