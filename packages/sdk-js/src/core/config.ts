import { encodePathSegment } from "./safe-json.js";

/** HTTP endpoint is an origin, never a console or project API route. */
export function normalizeEndpoint(input = "http://localhost:8080"): string {
  let url: URL;
  try { url = new URL(input); } catch {
    throw new Error("@vellumdb/sdk-js: endpoint must be an absolute HTTP(S) origin, e.g. https://api.vellum.dev (without /v1)");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) {
    throw new Error("@vellumdb/sdk-js: endpoint must be an HTTP(S) origin without credentials, path, query, or fragment; remove /v1 and project/auth routes");
  }
  return url.origin;
}

export function validateProjectConfig(projectId: string, apiKey: string): void {
  if (typeof projectId !== "string" || !projectId.trim() || projectId !== projectId.trim()) {
    throw new Error("@vellumdb/sdk-js: projectId is required and must be a non-empty project ID, not a URL");
  }
  encodePathSegment(projectId, "projectId");
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey !== apiKey.trim()) {
    throw new Error("@vellumdb/sdk-js: apiKey is required and must be a non-empty project API key");
  }
}
