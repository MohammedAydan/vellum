import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/sheet.js";
import { ConfirmDialog } from "../../primitives/confirm-dialog.js";

export interface DetailSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** Detail pane that slides in from the logical end edge (RTL aware). */
export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: DetailSheetProps): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="end"
        className="flex max-w-xl flex-col gap-0 p-0"
        data-slot="detail-sheet"
      >
        <SheetHeader className="sticky top-0 z-10 shrink-0 border-b border-border bg-background px-6 py-4 pe-12">
          <SheetTitle>{title}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? (
          <SheetFooter className="sticky bottom-0 z-10 mx-0 mb-0 mt-0 shrink-0 flex-row justify-end gap-2 rounded-none border-t border-border bg-background px-6 py-3">
            {footer}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export interface ConfirmDangerDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  requireTypeToConfirm?: string;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
}

/** Destructive confirmation dialog built on the shared AlertDialog primitive. */
export function ConfirmDangerDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  requireTypeToConfirm,
  onConfirm,
  loading,
}: ConfirmDangerDialogProps): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description ?? "This action cannot be undone."}
      confirmText={confirmLabel ?? "Confirm"}
      variant="destructive"
      onConfirm={onConfirm}
      {...(loading !== undefined ? { loading } : {})}
      {...(requireTypeToConfirm !== undefined
        ? {
            confirmRequiredText: requireTypeToConfirm,
            confirmLabel: `Type "${requireTypeToConfirm}" to confirm`,
          }
        : {})}
    />
  );
}
