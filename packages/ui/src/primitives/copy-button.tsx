import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "../components/button.js";
import { toast } from "sonner";
import { cn } from "../lib/cn.js";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  value: string;
  label?: string;
  successMessage?: string;
}

export function CopyButton({
  value,
  label,
  successMessage = "Copied to clipboard",
  className,
  variant = "ghost",
  size = "icon",
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(successMessage);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleCopy}
      className={cn("h-7 w-7 text-muted-foreground hover:text-foreground", className)}
      title="Copy to clipboard"
      {...props}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {label ? <span className="ms-1.5 text-xs">{label}</span> : null}
      <span className="sr-only">Copy</span>
    </Button>
  );
}
