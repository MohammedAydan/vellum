import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/alert-dialog.js";
import { Input } from "../components/input.js";
import { buttonVariants } from "../components/button.js";
import { Spinner } from "../components/spinner.js";
import { cn } from "../lib/cn.js";

export interface ConfirmDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "destructive" | "default";
  loading?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
  /** When set, the user must type this exact text before confirming. */
  confirmRequiredText?: string;
  /** Label shown above the type-to-confirm input. */
  confirmLabel?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "default",
  loading = false,
  onConfirm,
  onCancel,
  confirmRequiredText,
  confirmLabel,
}: ConfirmDialogProps) {
  const [internalLoading, setInternalLoading] = React.useState(false);
  const [typedValue, setTypedValue] = React.useState("");
  const inputId = React.useId();
  const isLoading = loading || internalLoading;
  const requiresTyping =
    typeof confirmRequiredText === "string" && confirmRequiredText.length > 0;
  const canConfirm =
    !isLoading && (!requiresTyping || typedValue === confirmRequiredText);

  React.useEffect(() => {
    if (open) setTypedValue("");
  }, [open]);

  const handleConfirm = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    if (onConfirm) {
      const res = onConfirm();
      if (res instanceof Promise) {
        setInternalLoading(true);
        try {
          await res;
        } finally {
          setInternalLoading(false);
          onOpenChange?.(false);
        }
      } else {
        onOpenChange?.(false);
      }
    } else {
      onOpenChange?.(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-muted-foreground">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {requiresTyping ? (
          <div className="space-y-1.5">
            {confirmLabel ? (
              <label htmlFor={inputId} className="text-xs font-medium text-foreground">
                {confirmLabel}
              </label>
            ) : null}
            <Input
              id={inputId}
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={confirmRequiredText}
              autoComplete="off"
              disabled={isLoading}
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading} onClick={onCancel}>
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            onClick={handleConfirm}
            className={cn(
              variant === "destructive" && buttonVariants({ variant: "destructive" })
            )}
          >
            {isLoading ? <Spinner className="me-2 size-4" /> : null}
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
