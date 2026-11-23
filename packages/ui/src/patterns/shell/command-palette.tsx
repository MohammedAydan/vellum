import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../../components/command.js";

export interface CommandPaletteAction {
  id: string;
  label: string;
  group?: string;
  shortcut?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  keywords?: string[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandPaletteAction[];
  placeholder?: string;
}

/**
 * State hook for the global Cmd/Ctrl+K shortcut. Pair it with
 * `<CommandPalette open={open} onOpenChange={setOpen} />`; the component owns
 * the toggle listener so a standalone palette also works, while this hook's
 * listener only opens (never closes) and therefore cannot double-toggle.
 */
export function useCommandPaletteShortcut(): {
  open: boolean;
  setOpen: (value: boolean) => void;
} {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || open) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return { open, setOpen };
}

/**
 * Canonical command palette. Every action is rendered (no filtering or
 * deduplication in JS) so the `[cmdk-item]` count asserted by QA is preserved.
 */
export function CommandPalette({
  open,
  onOpenChange,
  actions,
  placeholder = "Type a command or search…",
}: CommandPaletteProps): React.JSX.Element {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      onOpenChange(!open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const groups = React.useMemo(() => {
    const map = new Map<string, CommandPaletteAction[]>();
    for (const action of actions) {
      const name = action.group ?? "General";
      const list = map.get(name) ?? [];
      list.push(action);
      map.set(name, list);
    }
    return Array.from(map.entries());
  }, [actions]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={placeholder} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map(([group, groupActions], index) => (
          <React.Fragment key={group}>
            {index > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={group}>
              {groupActions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action.label}
                  {...(action.keywords !== undefined ? { keywords: action.keywords } : {})}
                  onSelect={() => {
                    action.onSelect();
                    onOpenChange(false);
                  }}
                >
                  {action.icon ? <span className="me-2">{action.icon}</span> : null}
                  <span>{action.label}</span>
                  {action.shortcut ? (
                    <CommandShortcut>{action.shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
