import * as AccordionPrimitive from "@radix-ui/react-accordion";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Drawer as Vaul } from "vaul";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const Overlay = "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out";
const Surface = "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-surface p-6 text-fg shadow-md focus:outline-none";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ className, ...props }: ComponentProps<typeof DialogPrimitive.Content>) { return <DialogPrimitive.Portal><DialogPrimitive.Overlay className={Overlay} /><DialogPrimitive.Content {...props} className={cn(Surface, className)} /></DialogPrimitive.Portal>; }
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) { return <AlertDialogPrimitive.Portal><AlertDialogPrimitive.Overlay className={Overlay} /><AlertDialogPrimitive.Content {...props} className={cn(Surface, className)} /></AlertDialogPrimitive.Portal>; }
export const AlertDialogTitle = AlertDialogPrimitive.Title;
export const AlertDialogDescription = AlertDialogPrimitive.Description;

export const Sheet = Vaul.Root;
export const SheetTrigger = Vaul.Trigger;
export const SheetClose = Vaul.Close;
export const SheetTitle = Vaul.Title;
export const SheetDescription = Vaul.Description;
export function SheetContent({ className, ...props }: ComponentProps<typeof Vaul.Content>) { return <Vaul.Portal><Vaul.Overlay className={Overlay} /><Vaul.Content {...props} className={cn("fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-auto rounded-t-xl border border-border bg-surface p-6 pb-[max(env(safe-area-inset-bottom),1.5rem)] text-fg shadow-md", className)} /></Vaul.Portal>; }

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) { return <PopoverPrimitive.Portal><PopoverPrimitive.Content {...props} className={cn("z-50 rounded-md border border-border bg-surface p-4 text-fg shadow-md", className)} /></PopoverPrimitive.Portal>; }

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuItem = DropdownMenuPrimitive.Item;
export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof DropdownMenuPrimitive.Content>) { return <DropdownMenuPrimitive.Portal><DropdownMenuPrimitive.Content {...props} className={cn("z-50 min-w-36 rounded-md border border-border bg-surface p-1 text-fg shadow-md", className)} /></DropdownMenuPrimitive.Portal>; }

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export function TooltipContent({ className, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) { return <TooltipPrimitive.Portal><TooltipPrimitive.Content {...props} className={cn("z-50 rounded bg-fg px-2 py-1 text-xs text-bg shadow-sm", className)} /></TooltipPrimitive.Portal>; }

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) { return <TabsPrimitive.List {...props} className={cn("inline-flex gap-1 border-b border-border", className)} />; }
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) { return <TabsPrimitive.Trigger {...props} className={cn("min-h-10 px-3 text-sm text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-b-2 data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-fg", className)} />; }
export const TabsContent = TabsPrimitive.Content;

export const Accordion = AccordionPrimitive.Root;
export const AccordionItem = AccordionPrimitive.Item;
export function AccordionTrigger({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Trigger>) { return <AccordionPrimitive.Header><AccordionPrimitive.Trigger {...props} className={cn("flex min-h-11 w-full items-center justify-between border-b border-border py-2 text-left font-medium", className)} /></AccordionPrimitive.Header>; }
export const AccordionContent = AccordionPrimitive.Content;
export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Root>) { return <ScrollAreaPrimitive.Root {...props} className={cn("overflow-hidden", className)}>{children}<ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2.5 touch-none select-none p-0.5"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong" /></ScrollAreaPrimitive.Scrollbar><ScrollAreaPrimitive.Corner /></ScrollAreaPrimitive.Root>; }
export function Separator({ className, ...props }: ComponentProps<typeof SeparatorPrimitive.Root>) { return <SeparatorPrimitive.Root {...props} className={cn("shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className)} />; }
export function Progress({ className, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) { return <ProgressPrimitive.Root {...props} className={cn("relative h-2 w-full overflow-hidden rounded-full bg-surface-2", className)}><ProgressPrimitive.Indicator className="h-full w-full flex-1 bg-accent transition-transform" style={{ transform: `translateX(-${100 - (props.value ?? 0)}%)` }} /></ProgressPrimitive.Root>; }
