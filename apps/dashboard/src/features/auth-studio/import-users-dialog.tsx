import * as React from "react";
import { apiFetch } from "../../lib/api.js";
import {
  Button,
  Textarea,
  Label,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import { errorMessage } from "./helpers.js";

export function ImportUsersDialog({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      toast.error(t("authStudio.users.importInvalidJson"));
      return;
    }
    if (!Array.isArray(parsed)) {
      toast.error(t("authStudio.users.importArrayRequired"));
      return;
    }
    if (parsed.length === 0 || parsed.length > 100) {
      toast.error(t("authStudio.users.importTooMany"));
      return;
    }
    if (!parsed.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
      toast.error(t("authStudio.users.importArrayRequired"));
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch<{ count: number }>(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/users:import`,
        { method: "POST", body: JSON.stringify({ users: parsed }) }
      );
      toast.success(t("authStudio.users.importedToast", { count: res.count ?? parsed.length }));
      onDone();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.users.importFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("authStudio.users.importTitle")}</DialogTitle>
        <DialogDescription>{t("authStudio.users.importDescription")}</DialogDescription>
      </DialogHeader>
      <div className="py-2">
        <Label htmlFor="import-users-json" className="text-xs">{t("authStudio.users.importTitle")}</Label>
        <Textarea
          id="import-users-json"
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
          placeholder={t("authStudio.users.importPlaceholder")}
          className="mt-1.5 min-h-48 font-mono text-[11px]"
          spellCheck={false}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onDone}>{t("authStudio.common.cancel")}</Button>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {t("authStudio.users.importSubmit")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
