/** Pure URL helpers shared by the Vercel runtime adapter and its tests. */

/** URL prefix of the backend Vercel Function (`apps/api/api/server/[...path].ts`) after a rewrite. */
export const VERCEL_FUNCTION_PREFIX = "/api/server";

/** Remove the Vercel function mount prefix from an incoming request URL. */
export function stripVercelFunctionPrefix(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url === VERCEL_FUNCTION_PREFIX) return "/";
  if (url.startsWith(`${VERCEL_FUNCTION_PREFIX}/`)) {
    return url.slice(VERCEL_FUNCTION_PREFIX.length);
  }
  return url;
}
