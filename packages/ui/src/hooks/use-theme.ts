import { useTheme as useNextTheme } from "next-themes";

export function useTheme() {
  const { theme, setTheme, systemTheme } = useNextTheme();
  return {
    theme: theme ?? "system",
    setTheme,
    resolvedTheme: theme === "system" ? systemTheme : theme,
    isDark: (theme === "system" ? systemTheme : theme) === "dark",
  };
}
