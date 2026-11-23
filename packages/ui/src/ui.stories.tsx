import * as React from "react";
import type { ReactElement } from "react";
import {
  Activity,
  AlertCircle,
  Database,
  Key,
  Layers,
  Plus,
  Shield,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./components/accordion.js";
import { Alert, AlertDescription, AlertTitle } from "./components/alert.js";
import { AspectRatio } from "./components/aspect-ratio.js";
import { Avatar, AvatarFallback, AvatarImage } from "./components/avatar.js";
import { Badge } from "./components/badge.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./components/breadcrumb.js";
import { Button } from "./components/button.js";
import { Calendar } from "./components/calendar.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/card.js";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./components/carousel.js";
import { Checkbox } from "./components/checkbox.js";
import { CodeEditor } from "./components/code-editor.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/collapsible.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./components/command.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./components/context-menu.js";
import { DatePicker } from "./components/date-picker.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/dialog.js";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./components/drawer.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/dropdown-menu.js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./components/hover-card.js";
import { Input } from "./components/input.js";
import { JsonViewer } from "./components/json-viewer.js";
import { Label } from "./components/label.js";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "./components/menubar.js";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "./components/navigation-menu.js";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "./components/pagination.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/popover.js";
import { Progress } from "./components/progress.js";
import { RadioGroup, RadioGroupItem } from "./components/radio-group.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/resizable.js";
import { ScrollArea } from "./components/scroll-area.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/select.js";
import { Separator } from "./components/separator.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/sheet.js";
import { Skeleton } from "./components/skeleton.js";
import { Slider } from "./components/slider.js";
import { Spinner } from "./components/spinner.js";
import { Switch } from "./components/switch.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/table.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs.js";
import { Textarea } from "./components/textarea.js";
import { Toggle } from "./components/toggle.js";
import { ToggleGroup, ToggleGroupItem } from "./components/toggle-group.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/tooltip.js";

// Composed Primitives
import {
  AppShell,
  KpiRow,
  PageContent,
  PageHeader,
  Sidebar,
  SidebarItem,
  SidebarSection,
  StatCard,
  ThemeToggle,
  Topbar,
} from "./primitives/app-shell.js";
import { BadgeGroup } from "./primitives/badge-group.js";
import { ConfirmDialog } from "./primitives/confirm-dialog.js";
import { CopyButton } from "./primitives/copy-button.js";
import { DataGrid } from "./primitives/data-grid.js";
import { EmptyState } from "./primitives/empty-state.js";
import { ErrorState } from "./primitives/error-state.js";
import { AsyncRegion } from "./patterns/data/feedback.js";
import { FieldTypeBadge } from "./primitives/field-badge.js";
import { LoadingState } from "./primitives/loading-state.js";
import {
  KeyValueList,
  KeyValueRow,
  PropertyItem,
  PropertyList,
} from "./primitives/property-list.js";
import { TimestampDisplay } from "./primitives/timestamp-display.js";
import { TruncatedText } from "./primitives/truncated-text.js";

// Domain-Specific Components
import { ApiKeyCard, ApiKeyRevealDialog } from "./domain/api-key.js";
import { AuditLogRow } from "./domain/audit-log.js";
import { ClusterHealthCard } from "./domain/cluster-health.js";
import { DocumentCard } from "./domain/document-card.js";
import { DocumentTree } from "./domain/document-tree.js";
import { IndexFieldsRow } from "./domain/index-fields-row.js";
import {
  QueryBuilderGroup,
} from "./domain/query-builder.js";
import { QuotaBar } from "./domain/quota-bar.js";
import { RulesEditor, RulesSimulator } from "./domain/rules-editor.js";
import { TenantCard } from "./domain/tenant-card.js";
import { UsageChart } from "./domain/usage-chart.js";

const meta = {
  title: "Design System/Foundations & Domain",
  component: Button,
  parameters: { layout: "centered" },
};
export default meta;

type Story = {
  args?: Record<string, unknown>;
  render?: () => ReactElement;
  parameters?: Record<string, unknown>;
};

// --- BUTTONS ---
export const ButtonDefault: Story = { args: { children: "Create document" } };
export const ButtonSecondary: Story = {
  args: { variant: "secondary", children: "Secondary action" },
};
export const ButtonOutline: Story = {
  args: { variant: "outline", children: "Outline action" },
};
export const ButtonGhost: Story = {
  args: { variant: "ghost", children: "Ghost action" },
};
export const ButtonDestructive: Story = {
  args: { variant: "destructive", children: "Delete document" },
};
export const ButtonSmall: Story = { args: { size: "sm", children: "Small" } };
export const ButtonLarge: Story = { args: { size: "lg", children: "Large" } };
export const ButtonDisabled: Story = {
  args: { disabled: true, children: "Disabled" },
};

// --- BADGES ---
export const BadgeDefault: Story = { render: () => <Badge>Production</Badge> };
export const BadgeSuccess: Story = {
  render: () => <Badge variant="success">Healthy</Badge>,
};
export const BadgeWarning: Story = {
  render: () => <Badge variant="warning">Degraded</Badge>,
};
export const BadgeDanger: Story = {
  render: () => <Badge variant="danger">Failed</Badge>,
};
export const BadgeInfo: Story = {
  render: () => <Badge variant="info">Staging</Badge>,
};

// --- CARDS ---
export const CardDefault: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Tenant Storage</CardTitle>
        <CardDescription>
          Real-time disk consumption across replicas.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">42.8 GB</p>
      </CardContent>
    </Card>
  ),
};


// --- FORMS & INPUTS ---
export const InputDefault: Story = {
  render: () => <Input placeholder="Search documents…" />,
};
export const InputDisabled: Story = {
  render: () => <Input disabled placeholder="Disabled" />,
};
export const TextareaDefault: Story = {
  render: () => <Textarea placeholder="Enter query string…" />,
};
export const SelectDefault: Story = {
  render: () => (
    <Select defaultValue="users">
      <SelectTrigger className="w-48">
        <SelectValue placeholder="Collection" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="users">users</SelectItem>
        <SelectItem value="orders">orders</SelectItem>
        <SelectItem value="products">products</SelectItem>
      </SelectContent>
    </Select>
  ),
};
export const CheckboxDefault: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" defaultChecked />
      <Label htmlFor="terms">Enforce Row-Level Security</Label>
    </div>
  ),
};
export const RadioGroupDefault: Story = {
  render: () => (
    <RadioGroup defaultValue="development">
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="development" id="r1" />
        <Label htmlFor="r1">Development</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="staging" id="r2" />
        <Label htmlFor="r2">Staging</Label>
      </div>
      <div className="flex items-center space-x-2">
        <RadioGroupItem value="production" id="r3" />
        <Label htmlFor="r3">Production</Label>
      </div>
    </RadioGroup>
  ),
};
export const SwitchDefault: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="realtime" defaultChecked />
      <Label htmlFor="realtime">Realtime Change Streams</Label>
    </div>
  ),
};
export const SliderDefault: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Query Limit</span>
        <span>50</span>
      </div>
      <Slider defaultValue={[50]} max={500} step={10} />
    </div>
  ),
};

// --- TOGGLES & GROUPS ---
export const ToggleDefault: Story = {
  render: () => <Toggle aria-label="Toggle italic">Bold</Toggle>,
};
export const ToggleGroupDefault: Story = {
  render: () => (
    <ToggleGroup type="single" defaultValue="asc">
      <ToggleGroupItem value="asc">ASC</ToggleGroupItem>
      <ToggleGroupItem value="desc">DESC</ToggleGroupItem>
    </ToggleGroup>
  ),
};

// --- ACCORDION & COLLAPSIBLE ---
export const AccordionDefault: Story = {
  render: () => (
    <div className="w-80">
      <Accordion type="single" collapsible defaultValue="item-1">
        <AccordionItem value="item-1">
          <AccordionTrigger>What is Vellum dual-plane separation?</AccordionTrigger>
          <AccordionContent>
            The control plane manages organizations, projects, and security rules,
            while the data plane stores documents and customer index entries.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Are composite index locks avoided?</AccordionTrigger>
          <AccordionContent>
            Yes. All composite indexes are stored as order-preserving binary keys in
            document_index_entries without DDL locks on the shared documents table.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  ),
};
export const CollapsibleDefault: Story = {
  render: () => (
    <Collapsible className="w-80 space-y-2 border border-border rounded-md p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">Configuration</span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">Toggle</Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-1 font-mono text-xs text-muted-foreground">
        <p>CONTROL_DB_URL=postgresql://...</p>
        <p>DATA_DB_URL=postgresql://...</p>
      </CollapsibleContent>
    </Collapsible>
  ),
};

// --- ALERT & PROGRESS & SKELETON ---
export const AlertDefault: Story = {
  render: () => (
    <div className="w-96">
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Quota Exceeded</AlertTitle>
        <AlertDescription>
          Daily write quota reached (100,000 ops). Writes are throttled until midnight UTC.
        </AlertDescription>
      </Alert>
    </div>
  ),
};
export const ProgressDefault: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Index Rebuild</span>
        <span>65%</span>
      </div>
      <Progress value={65} />
    </div>
  ),
};
export const SkeletonDefault: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
};
export const SpinnerDefault: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Spinner size="sm" />
      <Spinner size="default" />
      <Spinner size="lg" />
    </div>
  ),
};

// --- AVATAR & BREADCRUMB ---
export const AvatarDefault: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarImage src="https://github.com/shadcn.png" alt="Operator" />
        <AvatarFallback>OP</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>AG</AvatarFallback>
      </Avatar>
    </div>
  ),
};
export const BreadcrumbDefault: Story = {
  render: () => (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#">Projects</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="#">Acme Corp</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Production</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
};

// --- CALENDAR & DATE PICKER ---
export const CalendarDefault: Story = {
  render: () => (
    <div className="rounded-md border border-border p-2">
      <Calendar mode="single" selected={new Date()} />
    </div>
  ),
};
export const DatePickerDefault: Story = {
  render: () => (
    <div className="w-64">
      <DatePicker date={new Date()} onSelect={() => {}} />
    </div>
  ),
};

// --- CAROUSEL & ASPECT RATIO ---
export const CarouselDefault: Story = {
  render: () => (
    <div className="w-80 px-10">
      <Carousel>
        <CarouselContent>
          <CarouselItem>
            <div className="rounded-md border border-border p-6 text-center text-sm">
              Slide 1: Dual-Plane Architecture
            </div>
          </CarouselItem>
          <CarouselItem>
            <div className="rounded-md border border-border p-6 text-center text-sm">
              Slide 2: Deterministic AST Rules
            </div>
          </CarouselItem>
          <CarouselItem>
            <div className="rounded-md border border-border p-6 text-center text-sm">
              Slide 3: Realtime Broker
            </div>
          </CarouselItem>
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  ),
};
export const AspectRatioDefault: Story = {
  render: () => (
    <div className="w-80">
      <AspectRatio ratio={16 / 9} className="bg-muted rounded-md flex items-center justify-center text-xs text-muted-foreground">
        16:9 Dashboard Hero
      </AspectRatio>
    </div>
  ),
};

// --- RESIZABLE & SCROLL AREA & SEPARATOR ---
export const ResizableDefault: Story = {
  render: () => (
    <div className="h-48 w-96 rounded-md border border-border overflow-hidden">
      <ResizablePanelGroup direction="horizontal">
        <ResizablePanel defaultSize={40} className="p-3 text-xs bg-muted/20">
          Navigation Tree
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={60} className="p-3 text-xs">
          Document Inspector
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
};
export const ScrollAreaDefault: Story = {
  render: () => (
    <ScrollArea className="h-32 w-64 rounded-md border border-border p-3 text-xs font-mono space-y-1">
      {Array.from({ length: 20 }).map((_, i) => (
        <p key={i}>users/usr_{String(i).padStart(3, "0")}</p>
      ))}
    </ScrollArea>
  ),
};
export const SeparatorDefault: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <p className="text-xs">Top section</p>
      <Separator />
      <p className="text-xs">Bottom section</p>
    </div>
  ),
};

// --- NAVIGATION & MENUS ---
export const DropdownMenuDefault: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Project Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Settings</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Manage API Keys</DropdownMenuItem>
        <DropdownMenuItem>Security Rules</DropdownMenuItem>
        <DropdownMenuItem className="text-destructive">
          Delete Project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
export const MenubarDefault: Story = {
  render: () => (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>Database</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            New Collection <MenubarShortcut>⌘N</MenubarShortcut>
          </MenubarItem>
          <MenubarItem>
            Query Explorer <MenubarShortcut>⌘Q</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem>Export Schema</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Security</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>Rules Simulator</MenubarItem>
          <MenubarItem>Audit Trail</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  ),
};
export const NavigationMenuDefault: Story = {
  render: () => (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuLink className={navigationMenuTriggerStyle()} href="#">
            Documentation
          </NavigationMenuLink>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink className={navigationMenuTriggerStyle()} href="#">
            API Reference
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  ),
};

// --- OVERLAYS, DIALOGS, SHEETS, DRAWERS ---
export const DialogDefault: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open Modal</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Composite Index</DialogTitle>
          <DialogDescription>
            Indexes accelerate multi-property queries without table locks.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-3">
          <Input placeholder="Collection path (e.g. users)" />
          <Input placeholder="Fields (e.g. status ASC, created_at DESC)" />
        </div>
        <DialogFooter>
          <Button>Build Index</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
export const SheetDefault: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open Drawer Sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Document Metadata</SheetTitle>
          <SheetDescription>
            Row-level security context and system timestamps.
          </SheetDescription>
        </SheetHeader>
        <div className="py-4 font-mono text-xs space-y-2">
          <p>Created: 2026-11-15T22:00:00Z</p>
          <p>Updated: 2026-11-15T23:30:00Z</p>
        </div>
      </SheetContent>
    </Sheet>
  ),
};
export const DrawerDefault: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Open Bottom Drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Realtime Activity Stream</DrawerTitle>
          <DrawerDescription>Subscribed to outbox channel.</DrawerDescription>
        </DrawerHeader>
        <div className="p-4 text-xs font-mono">
          Listening on project_id=live_01 channel...
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline">Close</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
};
export const PopoverDefault: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Quick Info</Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 text-xs space-y-1">
        <p className="font-semibold">Neon Connection Pool</p>
        <p className="text-muted-foreground">Direct pooling active with 10 max connections.</p>
      </PopoverContent>
    </Popover>
  ),
};
export const HoverCardDefault: Story = {
  render: () => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Button variant="link">@vellum/rules-ast</Button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-xs space-y-1">
        <p className="font-semibold">Deterministic Security Evaluator</p>
        <p className="text-muted-foreground">In-memory synchronous AST evaluation with zero eval() and maxDepth 10.</p>
      </HoverCardContent>
    </HoverCard>
  ),
};
export const TooltipDefault: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">Hover Me</Button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">PostgreSQL Row-Level Security Enabled</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
};
export const ContextMenuDefault: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-32 w-64 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
        Right click here
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Copy Path <ContextMenuShortcut>⌘C</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem>Duplicate</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive">Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};
export const ConfirmDialogDefault: Story = {
  render: () => (
    <ConfirmDialog
      open={true}
      variant="destructive"
      title="Delete Collection"
      description="Are you sure you want to delete the 'audit_logs' collection? This action is permanent and cannot be undone."
      confirmText="Delete Collection"
    />
  ),
};

// --- DATA DISPLAY & TABLES ---
export const TableDefault: Story = {
  render: () => (
    <Table className="w-[500px]">
      <TableHeader>
        <TableRow>
          <TableHead>Path</TableHead>
          <TableHead>Field Count</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-mono text-xs">users/usr_01</TableCell>
          <TableCell>14</TableCell>
          <TableCell>2m ago</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-mono text-xs">users/usr_02</TableCell>
          <TableCell>8</TableCell>
          <TableCell>1h ago</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
export const DataGridDefault: Story = {
  render: () => (
    <div className="w-[600px]">
      <DataGrid
        data={[
          { id: "usr_01", email: "alice@acme.com", role: "admin", status: "active" },
          { id: "usr_02", email: "bob@acme.com", role: "user", status: "active" },
          { id: "usr_03", email: "carol@acme.com", role: "user", status: "suspended" },
        ]}
        columns={[
          { accessorKey: "id", header: "User ID" },
          { accessorKey: "email", header: "Email" },
          { accessorKey: "role", header: "Role" },
          { accessorKey: "status", header: "Status" },
        ]}
      />
    </div>
  ),
};
export const PaginationDefault: Story = {
  render: () => (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink isActive>1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink>2</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
};
export const TabsDefault: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-80">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="text-xs text-muted-foreground p-3">
        Project metrics and active collections.
      </TabsContent>
      <TabsContent value="rules" className="text-xs text-muted-foreground p-3">
        Security rule AST definitions.
      </TabsContent>
    </Tabs>
  ),
};

// --- CODE & JSON EDITORS ---
export const CodeEditorDefault: Story = {
  render: () => (
    <div className="w-96 rounded-md border border-border overflow-hidden">
      <CodeEditor value={'{\n  "version": 1,\n  "allow": true\n}'} />
    </div>
  ),
};
export const JsonViewerDefault: Story = {
  render: () => (
    <div className="w-96 rounded-md border border-border p-3">
      <JsonViewer
        data={{
          id: "usr_42",
          name: "Alice Smith",
          roles: ["admin", "billing"],
          active: true,
        }}
      />
    </div>
  ),
};

// --- COMPOSED PRIMITIVES ---
export const PropertyListDefault: Story = {
  render: () => (
    <div className="w-96 space-y-4">
      <PropertyList>
        <PropertyItem title="RLS Enforcement" description="Fails closed if tenant context is missing">
          <Badge variant="success">Active</Badge>
        </PropertyItem>
        <PropertyItem title="Statement Timeout" description="PostgreSQL transaction deadline">
          <span className="font-mono text-xs">5000ms</span>
        </PropertyItem>
      </PropertyList>

      <KeyValueList>
        <KeyValueRow label="Project ID" value="prj_948f10" action={<CopyButton value="prj_948f10" />} />
        <KeyValueRow label="Storage Adapter" value="Neon Postgres" />
      </KeyValueList>
    </div>
  ),
};
export const BadgeGroupDefault: Story = {
  render: () => (
    <BadgeGroup
      maxCount={3}
      items={["documents:read", "documents:write", "indexes:create", "rules:publish", "admin:all"]}
    />
  ),
};
export const CopyButtonDefault: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs">pk_89a0b12389e</span>
      <CopyButton value="pk_89a0b12389e" />
    </div>
  ),
};
export const TruncatedTextDefault: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <TruncatedText text="projects/acme-prod-9812/documents/users/usr_01" maxLength={28} copyable />
    </div>
  ),
};
export const TimestampDisplayDefault: Story = {
  render: () => (
    <div className="space-y-1">
      <p className="text-xs">Relative: <TimestampDisplay date={Date.now() - 300000} /></p>
      <p className="text-xs">Absolute: <TimestampDisplay date={Date.now() - 300000} relative={false} /></p>
    </div>
  ),
};
export const EmptyStateDefault: Story = {
  render: () => (
    <EmptyState
      title="No Documents Found"
      description="Create your first document in this collection to get started."
      action={<Button size="sm"><Plus className="me-1 size-3.5" />New Document</Button>}
    />
  ),
};
export const ErrorStateDefault: Story = {
  render: () => (
    <ErrorState
      title="Connection Failed"
      message="Could not connect to the realtime outbox stream."
      onRetry={() => {}}
    />
  ),
};
export const LoadingStateDefault: Story = {
  render: () => <LoadingState rows={4} columns={3} />,
};
// P0 hard rule: every async region has three designed states. One gallery
// story shows all three side by side for the screenshot matrix.
export const AsyncRegionStates: Story = {
  parameters: { layout: "padded" },
  render: () => (
    <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Loading</p>
        <AsyncRegion status="loading" skeleton={<LoadingState rows={3} columns={2} />} />
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Error + retry</p>
        <AsyncRegion
          status="error"
          errorTitle="Couldn’t load documents"
          errorMessage="The request failed. Check your connection and try again."
          onRetry={() => {}}
        />
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Empty + action</p>
        <AsyncRegion
          status="empty"
          emptyTitle="No documents yet"
          emptyDescription="Create your first document to start storing data."
          emptyAction={<Button size="sm">New document</Button>}
        />
      </div>
    </div>
  ),
};
export const FieldTypeBadgeDefault: Story = {
  render: () => (
    <div className="flex flex-wrap gap-1.5">
      <FieldTypeBadge type="string" />
      <FieldTypeBadge type="number" />
      <FieldTypeBadge type="boolean" />
      <FieldTypeBadge type="timestamp" />
      <FieldTypeBadge type="reference" />
      <FieldTypeBadge type="geopoint" />
      <FieldTypeBadge type="bytes" />
      <FieldTypeBadge type="map" />
      <FieldTypeBadge type="array" />
    </div>
  ),
};
export const CommandDefault: Story = {
  render: () => (
    <div className="w-96 rounded-md border border-border shadow-md">
      <Command>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Suggestions">
            <CommandItem>Search Documents <CommandShortcut>⌘D</CommandShortcut></CommandItem>
            <CommandItem>View Indexes <CommandShortcut>⌘I</CommandShortcut></CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem>Manage API Keys</CommandItem>
            <CommandItem>Manage Project</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
};

// --- APP SHELL & NAVIGATION ---
export const AppShellDefault: Story = {
  render: () => (
    <AppShell
      sidebar={
        <Sidebar>
          <SidebarSection label="Database">
            <SidebarItem active icon={<Database className="size-4" />}>
              Explorer
            </SidebarItem>
            <SidebarItem icon={<Layers className="size-4" />}>Indexes</SidebarItem>
            <SidebarItem icon={<Shield className="size-4" />}>Security Rules</SidebarItem>
          </SidebarSection>
          <SidebarSection label="Platform">
            <SidebarItem icon={<Key className="size-4" />}>API Keys</SidebarItem>
            <SidebarItem icon={<Activity className="size-4" />}>Usage & Metrics</SidebarItem>
          </SidebarSection>
        </Sidebar>
      }
      topbar={
        <Topbar
          breadcrumbs={<span className="font-medium">Acme Corp / Project</span>}
          actions={
            <div className="flex items-center gap-2">
              <ThemeToggle />
            </div>
          }
        />
      }
    >
      <PageContent>
        <PageHeader
          title="Document Database"
          description="High-performance multi-tenant document storage with strict RLS isolation."
          actions={<Button><Plus className="me-1 size-4" />New Document</Button>}
        />
        <KpiRow>
          <StatCard label="Total Documents" value="482,910" delta="+8.2% this month" trend="up" />
          <StatCard label="Storage Allocated" value="38.4 GB" delta="42% of tier quota" />
          <StatCard label="Read Operations" value="1.84M" delta="99.98% cache hit" trend="up" />
          <StatCard label="Outbox Lag" value="38 ms" delta="Optimal realtime broker" trend="up" />
        </KpiRow>
      </PageContent>
    </AppShell>
  ),
  parameters: { layout: "fullscreen" },
};

// --- DOMAIN COMPONENTS ---
export const DocumentTreeDefault: Story = {
  render: () => (
    <div className="w-80">
      <DocumentTree
        selectedPath="users/usr_01"
        data={[
          {
            id: "users",
            name: "users",
            path: "users",
            type: "collection",
            count: 42,
            children: [
              { id: "usr_01", name: "usr_01", path: "users/usr_01", type: "document" },
              { id: "usr_02", name: "usr_02", path: "users/usr_02", type: "document" },
            ],
          },
          {
            id: "orders",
            name: "orders",
            path: "orders",
            type: "collection",
            count: 128,
            children: [
              { id: "ord_101", name: "ord_101", path: "orders/ord_101", type: "document" },
            ],
          },
        ]}
      />
    </div>
  ),
};

export const DocumentCardDefault: Story = {
  render: () => (
    <div className="w-96">
      <DocumentCard
        id="usr_92a7f10b"
        path="tenants/org_42/users/usr_92a7f10b"
        version={3}
        updatedAt={Date.now() - 3600000}
        fields={[
          { name: "displayName", type: "string", preview: '"Alice Smith"' },
          { name: "loginCount", type: "number", preview: "42" },
          { name: "isVerified", type: "boolean", preview: "true" },
          { name: "metadata", type: "map", preview: "{ tier: 'pro' }" },
        ]}
      />
    </div>
  ),
};

export const QueryBuilderDefault: Story = {
  render: () => (
    <div className="w-[640px]">
      <QueryBuilderGroup
        filters={[
          { id: "f1", field: "status", op: "==", value: "'active'" },
          { id: "f2", field: "score", op: ">=", value: "85" },
        ]}
        onFiltersChange={() => {}}
        orders={[{ id: "o1", field: "score", direction: "desc" }]}
        onOrdersChange={() => {}}
        fieldOptions={["status", "score", "createdAt", "email", "tier"]}
      />
    </div>
  ),
};

export const RulesEditorDefault: Story = {
  render: () => (
    <div className="w-[640px]">
      <RulesEditor
        value={JSON.stringify(
          {
            rules: [
              {
                match: "users/{userId}",
                allow: {
                  read: "request.auth != null",
                  write: "request.auth.uid == userId",
                },
              },
            ],
          },
          null,
          2
        )}
        onChange={() => {}}
      />
    </div>
  ),
};

export const RulesSimulatorDefault: Story = {
  render: () => (
    <div className="w-[640px]">
      <RulesSimulator
        onSimulate={({ authUid, path }) => ({
          allowed: path.includes(authUid),
          reason: path.includes(authUid)
            ? "Rule 'request.auth.uid == userId' evaluated to TRUE"
            : "Rule evaluated to FALSE: caller UID does not match document owner",
          evaluatedNodes: 4,
          durationMs: 0.14,
        })}
      />
    </div>
  ),
};

export const IndexFieldsRowDefault: Story = {
  render: () => (
    <div className="w-[480px] space-y-2">
      <IndexFieldsRow
        field={{ id: "f1", fieldPath: "tenantId", order: "ASC" }}
        onChange={() => {}}
        onRemove={() => {}}
      />
      <IndexFieldsRow
        field={{ id: "f2", fieldPath: "createdAt", order: "DESC" }}
        onChange={() => {}}
        onRemove={() => {}}
      />
    </div>
  ),
};

export const ApiKeyCardDefault: Story = {
  render: () => (
    <div className="w-96">
      <ApiKeyCard
        id="key_01"
        name="Backend Service Key"
        keyPrefix="sk_948f..."
        scopes={["documents:read", "documents:write", "indexes:manage"]}
        createdAt={Date.now() - 86400000 * 14}
        lastUsedAt={Date.now() - 120000}
        onRevoke={() => {}}
      />
    </div>
  ),
};

export const ApiKeyRevealDialogDefault: Story = {
  render: () => (
    <ApiKeyRevealDialog
      open={true}
      onOpenChange={() => {}}
      name="Worker Secret"
      apiKey="sk_example_0000000000000000000000000000"
    />
  ),
};

export const UsageChartDefault: Story = {
  render: () => (
    <div className="w-[640px]">
      <UsageChart
        title="Database Throughput (Last 7 Days)"
        data={[
          { timestamp: "Mon", reads: 12000, writes: 3400 },
          { timestamp: "Tue", reads: 18500, writes: 4200 },
          { timestamp: "Wed", reads: 24000, writes: 5100 },
          { timestamp: "Thu", reads: 22000, writes: 4900 },
          { timestamp: "Fri", reads: 31000, writes: 6800 },
          { timestamp: "Sat", reads: 28000, writes: 6200 },
          { timestamp: "Sun", reads: 35000, writes: 7400 },
        ]}
      />
    </div>
  ),
};

export const QuotaBarDefault: Story = {
  render: () => (
    <div className="w-80 space-y-4">
      <QuotaBar label="Storage Usage" current={420} max={1024} unit=" MB" />
      <QuotaBar label="Monthly Writes" current={89000} max={100000} />
      <QuotaBar label="Concurrent WebSockets" current={48} max={50} />
    </div>
  ),
};

export const ClusterHealthCardDefault: Story = {
  render: () => (
    <div className="w-96">
      <ClusterHealthCard />
    </div>
  ),
};

export const AuditLogRowDefault: Story = {
  render: () => (
    <div className="w-[640px] space-y-2">
      <AuditLogRow
        event={{
          id: "evt_01",
          timestamp: Date.now() - 180000,
          actor: { type: "user", id: "usr_alice", label: "alice@acme.com" },
          action: "security_rules.publish",
          resource: "projects/prj_live",
          status: "success",
          ipAddress: "192.0.2.42",
        }}
      />
      <AuditLogRow
        event={{
          id: "evt_02",
          timestamp: Date.now() - 3600000,
          actor: { type: "api_key", id: "key_sk_99", label: "Backend Scraper" },
          action: "document.delete",
          resource: "documents/tenants/t1/users/u12",
          status: "denied",
          ipAddress: "198.51.100.7",
        }}
      />
    </div>
  ),
};

export const TenantCardDefault: Story = {
  render: () => (
    <div className="w-96">
      <TenantCard
        id="org_globex_9821"
        name="Globex Corporation"
        plan="enterprise"
        documentCount={124890}
        storageMb={14200}
        monthlySpend={1240.5}
        onManage={() => {}}
      />
    </div>
  ),
};
