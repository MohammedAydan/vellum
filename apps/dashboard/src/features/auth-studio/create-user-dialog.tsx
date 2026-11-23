import * as React from "react";
import { apiFetch } from "../../lib/api.js";
import {
  Button,
  Input,
  Label,
  Switch,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  useI18n,
} from "@vellum/ui";
import { toast } from "sonner";
import type { UnknownRecord } from "./types.js";
import { errorMessage } from "./helpers.js";

export function CreateUserDialog({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [phoneNumber, setPhoneNumber] = React.useState("");
  const [emailVerified, setEmailVerified] = React.useState(false);
  const [phoneVerified, setPhoneVerified] = React.useState(false);
  const [isAnonymous, setIsAnonymous] = React.useState(false);
  const [isDisabled, setIsDisabled] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAnonymous && !email.trim()) {
      toast.error(t("authStudio.users.requiredEmail"));
      return;
    }
    if (!isAnonymous && email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error(t("authStudio.users.invalidEmail"));
      return;
    }
    if (password && password.length < 8) {
      toast.error(t("authStudio.users.requiredPassword"));
      return;
    }
    setSaving(true);
    try {
      const body: UnknownRecord = {
        email: isAnonymous ? null : email.trim().toLowerCase(),
        displayName: displayName.trim() || null,
        emailVerified,
        phoneVerified,
        isAnonymous,
        isDisabled,
      };
      if (phoneNumber.trim()) body["phoneNumber"] = phoneNumber.trim();
      if (password) body["password"] = password;
      await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/auth/admin/users`,
        { method: "POST", body: JSON.stringify(body) }
      );
      toast.success(t("authStudio.users.createdToast"));
      onDone();
    } catch (err: unknown) {
      toast.error(errorMessage(err, t("authStudio.users.createFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t("authStudio.users.createTitle")}</DialogTitle>
        <DialogDescription>{t("authStudio.users.createDescription")}</DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} className="space-y-3.5 py-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-user-email" className="text-xs">{t("authStudio.users.fieldEmail")}</Label>
          <Input
            id="new-user-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("authStudio.users.emailPlaceholder")}
            className="h-8 text-xs"
            disabled={isAnonymous}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-user-password" className="text-xs">{t("authStudio.users.fieldPassword")}</Label>
          <Input
            id="new-user-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("authStudio.users.passwordPlaceholder")}
            className="h-8 text-xs"
            autoComplete="new-password"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-name" className="text-xs">{t("authStudio.users.fieldDisplayName")}</Label>
            <Input
              id="new-user-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t("authStudio.users.displayNamePlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-phone" className="text-xs">{t("authStudio.users.fieldPhone")}</Label>
            <Input
              id="new-user-phone"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder={t("authStudio.users.phonePlaceholder")}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
          {([
            [t("authStudio.users.fieldEmailVerified"), emailVerified, setEmailVerified],
            [t("authStudio.users.fieldPhoneVerified"), phoneVerified, setPhoneVerified],
            [t("authStudio.users.fieldAnonymous"), isAnonymous, setIsAnonymous],
            [t("authStudio.users.fieldDisabled"), isDisabled, setIsDisabled],
          ] as const).map(([label, checked, onChange]) => (
            <label key={label} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={checked} onCheckedChange={onChange} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" size="sm" onClick={onDone}>
            {t("authStudio.common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {t("authStudio.users.createSubmit")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
