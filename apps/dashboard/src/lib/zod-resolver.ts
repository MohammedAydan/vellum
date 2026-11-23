import type {
  FieldError,
  FieldErrors,
  FieldValues,
  Resolver,
  ResolverResult,
} from "react-hook-form";
import type { z } from "zod";

function setNestedError(
  target: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  error: FieldError
): void {
  if (path.length === 0) {
    target["root"] = error;
    return;
  }
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = String(path[i]);
    const existing = cursor[segment];
    if (typeof existing !== "object" || existing === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = String(path[path.length - 1]);
  if (cursor[leaf] === undefined) {
    cursor[leaf] = error;
  }
}

/**
 * Typed Zod v3 resolver for `react-hook-form`.
 *
 * The monorepo hoists zod v4 for `@vellum/ui`, while the dashboard declares
 * zod v3. Running `safeParse` / `safeParseAsync` directly against the
 * app-local Zod schema keeps the inferred resolver output type strictly equal
 * to `z.infer<TSchema>` with zero double-casts or peer-type mismatches.
 */
export function zodResolver<TSchema extends z.ZodType<FieldValues>>(
  schema: TSchema,
  schemaOptions?: Partial<z.ParseParams>,
  factoryOptions?: { mode?: "async" | "sync"; raw?: boolean }
): Resolver<z.infer<TSchema>> {
  return async (values): Promise<ResolverResult<z.infer<TSchema>>> => {
    const parsed =
      factoryOptions?.mode === "sync"
        ? schema.safeParse(values, schemaOptions)
        : await schema.safeParseAsync(values, schemaOptions);

    if (parsed.success) {
      return {
        values: (factoryOptions?.raw ? values : parsed.data) as z.infer<TSchema>,
        errors: {},
      };
    }

    const errors: Record<string, unknown> = {};
    for (const issue of parsed.error.issues) {
      setNestedError(errors, issue.path, {
        type: issue.code,
        message: issue.message,
      });
    }
    return {
      values: {},
      errors: errors as FieldErrors<z.infer<TSchema>>,
    };
  };
}
