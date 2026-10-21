import { createFileRoute, notFound } from "@tanstack/react-router";
import { Check, Plus } from "lucide-react";
import { useState } from "react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger, AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger, Avatar, Badge, Button, Card, CardContent,
  CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, DataTable,
  Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, Drawer, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, EmptyState, ErrorNotice, ErrorState, Field, Input, Kbd, KpiCard, LinkTabs, LoadingMark,
  Logo, Mark, NotConnected, PageHeader, Popover, PopoverContent, PopoverTrigger, Progress, RadioGroup, RadioGroupItem, SaveState,
  ScrollArea, Select, SelectItem, Separator, Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger, Skeleton, Slider,
  Stat, StatusBadge, StepBar, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Toaster, Tooltip, TooltipContent,
  TooltipProvider, TooltipTrigger, toast, useTheme, type SaveStatus, type StepBarStep,
} from "@/components/ui";
import type { ColumnDef } from "@tanstack/react-table";

export const Route = createFileRoute("/_design")({
  beforeLoad: () => { if (!import.meta.env.DEV) throw notFound(); },
  component: DesignSystemPage,
});

type ExampleRow = { id: string; name: string; status: string };
const columns: ColumnDef<ExampleRow>[] = [
  { accessorKey: "id", header: "Id", cell: ({ getValue }) => <span className="font-mono">{String(getValue())}</span>, enableSorting: true },
  { accessorKey: "name", header: "Example", enableSorting: true },
  { accessorKey: "status", header: "State", cell: ({ getValue }) => <StatusBadge status={String(getValue())} /> },
];
const specimenRows: ExampleRow[] = [
  { id: "example-01", name: "Component specimen", status: "IN_REVIEW" },
  { id: "example-02", name: "Fixture only", status: "NOT_CONNECTED" },
  { id: "example-03", name: "Second specimen", status: "APPROVED" },
];
const stepBarSteps: StepBarStep[] = [
  { id: "brief", label: "Brief", state: "done", to: "/_design" },
  { id: "plan", label: "Plan", state: "current" },
  { id: "review", label: "Review", state: "todo" },
];
const saveStatuses: SaveStatus[] = ["idle", "saving", "saved", "error"];

function DesignSystemPage() {
  const [checked, setChecked] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  return <TooltipProvider>
    <Toaster />
    <main className="mx-auto max-w-6xl space-y-12 px-4 py-8 text-fg sm:px-8">
      <PageHeader title="Design system" description="Component specimens only. Values below are not Meridian account or campaign data." breadcrumbs={[{ label: "Developer tools" }, { label: "Design system" }]} actions={<Button leftIcon={<Plus aria-hidden="true" />}>Primary action</Button>} secondaryActions={<Button variant="secondary">Secondary</Button>} />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Preview theme">
        <Button variant="secondary" size="md" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark theme</Button>
        <Button variant="secondary" size="md" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light theme</Button>
      </div>

      <section aria-labelledby="buttons-title" className="space-y-4">
        <h2 id="buttons-title" className="font-display text-section font-semibold">Buttons</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost (alias of quiet)</Button>
          <Button variant="link">Link style</Button>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button leftIcon={<Plus />} rightIcon={<Check />}>With icons</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled>Primary disabled</Button>
          <Button variant="secondary" disabled>Secondary disabled</Button>
          <Button variant="danger" disabled>Danger disabled</Button>
          <Button loading>Saving the draft</Button>
          <Button variant="secondary" loading>Loading</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Neutral</Badge>
          <Badge variant="success">Complete</Badge>
          <Badge variant="warning">Waiting</Badge>
          <Badge variant="danger">Rejected</Badge>
          <Badge variant="info">Active</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="APPROVED" />
          <StatusBadge status="IN_REVIEW" />
          <StatusBadge status="FAILED" />
          <StatusBadge status="RUNNING" />
          <StatusBadge status="NOT_CONNECTED" />
          <StatusBadge status="UNHEALTHY" />
        </div>
      </section>

      <section aria-labelledby="forms-title" className="space-y-4">
        <h2 id="forms-title" className="font-display text-section font-semibold">Form controls</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <Field label="Text field" hint="Hint text is programmatically associated." required><Input placeholder="Write a value" /></Field>
          <Field label="Text field with an error" error="Enter a value of at least three characters."><Input defaultValue="ab" /></Field>
          <Field label="Disabled field" hint="Disabled because the workspace is read only."><Input disabled defaultValue="Read only" /></Field>
          <Field label="Text area"><Textarea defaultValue="Example text" /></Field>
          <Field label="Native select"><select aria-label="Native select example" className="w-full min-h-10 rounded-sharp border border-border-strong bg-bg px-3 py-2 text-body"><option>Compatibility option</option></select></Field>
          <Select label="Styled select" defaultValue="one"><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem></Select>
          <div className="space-y-4">
            <Checkbox checked={checked} onCheckedChange={(value) => setChecked(value === true)} label="Checkbox example" hint="This is a specimen control." />
            <Checkbox checked="indeterminate" label="Indeterminate example" />
            <Switch label="Switch on" defaultChecked hint="Connected state is not inferred." />
            <Switch label="Switch off" />
          </div>
          <div className="space-y-2">
            <p id="radio-label" className="text-small font-semibold text-fg-secondary">Radio options</p>
            <RadioGroup aria-labelledby="radio-label" defaultValue="a" className="flex gap-4"><label className="flex items-center gap-2 text-small"><RadioGroupItem value="a" />Choice A</label><label className="flex items-center gap-2 text-small"><RadioGroupItem value="b" />Choice B</label></RadioGroup>
          </div>
          <Slider label="Example range" defaultValue={[35]} min={0} max={100} hint="Illustrative value only." />
        </div>
      </section>

      <section aria-labelledby="cards-title" className="space-y-4">
        <h2 id="cards-title" className="font-display text-section font-semibold">Cards, stats and skeletons</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <Card elevation="flat"><CardHeader><CardTitle>Flat card</CardTitle><CardDescription>Card description</CardDescription></CardHeader><CardContent>Card content</CardContent><CardFooter>Card footer</CardFooter></Card>
          <Card elevation="raised">Raised card</Card>
          <Card elevation="floating">Floating card</Card>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <KpiCard label="Example metric" value="—" description="No performance data in this component preview." icon={<Check />} />
          <Stat label="Stat example" value="—" delta="No change" />
        </div>
        <div className="grid gap-3 md:grid-cols-4"><Skeleton /><Skeleton variant="card" /><Skeleton variant="table-row" /><Skeleton variant="media" /></div>
      </section>

      <section aria-labelledby="navigation-title" className="space-y-4">
        <h2 id="navigation-title" className="font-display text-section font-semibold">Steps, tabs and navigation</h2>
        <StepBar steps={stepBarSteps} />
        <LinkTabs label="Example sections" items={[{ to: "/_design", label: "First" }, { to: "/_design?tab=second", label: "Second" }]} activeTo="/_design" />
        <Tabs defaultValue="first">
          <TabsList><TabsTrigger value="first">First</TabsTrigger><TabsTrigger value="second">Second</TabsTrigger></TabsList>
          <TabsContent value="first" className="p-3 text-small">First panel</TabsContent>
          <TabsContent value="second" className="p-3 text-small">Second panel</TabsContent>
        </Tabs>
        <Accordion type="single" collapsible><AccordionItem value="item"><AccordionTrigger>Accordion</AccordionTrigger><AccordionContent className="p-3 text-small">Accordion content</AccordionContent></AccordionItem></Accordion>
        <Collapsible open={collapsibleOpen} onOpenChange={setCollapsibleOpen}><CollapsibleTrigger asChild><Button variant="quiet" aria-expanded={collapsibleOpen}>Collapsible section</Button></CollapsibleTrigger><CollapsibleContent className="p-3 text-small">Collapsible content</CollapsibleContent></Collapsible>
        <ScrollArea className="h-20 rounded-sharp border border-hairline p-3 text-small">Scrollable content specimen.</ScrollArea>
        <Separator />
        <div className="flex flex-wrap items-center gap-6">
          <Mark />
          <Mark wordmark size={32} />
          <Logo alt="Brand mark example" />
          <Avatar fallback="ME" />
          <p className="text-small text-fg-secondary">Keyboard shortcut: <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd></p>
        </div>
      </section>

      <section aria-labelledby="overlays-title" className="space-y-4">
        <h2 id="overlays-title" className="font-display text-section font-semibold">Overlays</h2>
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild><Button variant="secondary">Open dialog</Button></DialogTrigger>
            <DialogContent aria-describedby="dialog-example-description"><DialogTitle>Dialog example</DialogTitle><DialogDescription id="dialog-example-description">A labelled dialog specimen.</DialogDescription></DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="danger">Open alert dialog</Button></AlertDialogTrigger>
            <AlertDialogContent aria-describedby="alert-example-description"><AlertDialogTitle>Confirm example</AlertDialogTitle><AlertDialogDescription id="alert-example-description">This dialog does not perform an action.</AlertDialogDescription><div className="mt-4 flex justify-end gap-2"><AlertDialogCancel asChild><Button variant="secondary">Cancel</Button></AlertDialogCancel><AlertDialogAction asChild><Button>Confirm</Button></AlertDialogAction></div></AlertDialogContent>
          </AlertDialog>
          <Button variant="secondary" onClick={() => setDrawerOpen(true)}>Open drawer</Button>
          <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="Drawer example" description="A side panel. Esc closes it.">
            <p className="text-small text-fg-secondary">Drawer content sits here.</p>
          </Drawer>
          <Sheet>
            <SheetTrigger asChild><Button variant="secondary">Open bottom sheet</Button></SheetTrigger>
            <SheetContent><SheetTitle className="font-display text-section font-semibold">Sheet example</SheetTitle><SheetDescription className="text-small text-fg-muted">This is a specimen sheet.</SheetDescription></SheetContent>
          </Sheet>
          <Popover><PopoverTrigger asChild><Button variant="secondary">Open popover</Button></PopoverTrigger><PopoverContent className="text-small">Popover example</PopoverContent></Popover>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="secondary">Dropdown</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Example menu action</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <Tooltip><TooltipTrigger asChild><Button variant="quiet">Tooltip</Button></TooltipTrigger><TooltipContent>Helpful details</TooltipContent></Tooltip>
          <Button variant="quiet" onClick={() => toast.success("Component preview toast")}>Show toast</Button>
        </div>
      </section>

      <section aria-labelledby="states-title" className="space-y-4">
        <h2 id="states-title" className="font-display text-section font-semibold">Empty, error, loading and save states</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <EmptyState title="Nothing connected" reason="Connect a provider to see real records here." action={<Button variant="secondary">Configure provider</Button>} />
          <ErrorState message="Example loading problem." requestId="preview-only" detail="Technical details are disclosed only when opened." onRetry={() => undefined} />
        </div>
        <div className="flex flex-wrap items-end gap-8">
          <LoadingMark size={16} label="Loading plans" />
          <LoadingMark size={24} label="Loading plans" showLabel />
          <LoadingMark size={48} label="Planning the video" showLabel />
        </div>
        <div className="flex flex-wrap items-center gap-6">
          {saveStatuses.map((status) => <SaveState key={status} status={status} />)}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <NotConnected service="Meta" />
          <ErrorNotice>Example failure notice.</ErrorNotice>
        </div>
        <DataTable data={specimenRows} columns={columns} selectable emptyTitle="No examples" emptyReason="This is a component preview." />
        <Progress value={62} aria-label="Example progress" />
      </section>
    </main>
  </TooltipProvider>;
}
