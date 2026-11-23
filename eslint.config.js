import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "sdks/flutter/**",
      "backups/**",
      "apps/dashboard/public/**",
      "dist-frontend/**",
    ],
  },
  {
    rules: {
      "no-control-regex": "off",
      "no-unused-vars": "off",
      "no-empty": "warn",
      "no-undef": "off",
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@vellum/*/dist/*", "@vellum/*/dist"],
              message: "Import from workspace package entrypoints or declared subpaths, never from dist/.",
            },
          ],
        },
      ],
    },
  },
];
