/**
 * @vellum/core - Canonical Branded ID Types & Validators
 *
 * Distinguishes UUIDv4 identifiers (project, index, transaction) from
 * prefixed identifiers (user, organization, api key, session) per the
 * verified repository conventions.
 */

import { VellumError } from "../errors.js";

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type ProjectId = Brand<string, "ProjectId">;
export type OrganizationId = Brand<string, "OrganizationId">;
export type UserId = Brand<string, "UserId">;
export type DocumentId = Brand<string, "DocumentId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;
export type IndexId = Brand<string, "IndexId">;
export type TransactionId = Brand<string, "TransactionId">;
export type SessionId = Brand<string, "SessionId">;

export const UUID_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PREFIXED_ID_REGEX = /^[a-z][a-z0-9_]*_[a-z0-9_-]{3,64}$/i;

const DOCUMENT_ID_REGEX = /^[^\s/\\?\x00-\x1f\x7f]{1,256}$/;

export function isUuidId(value: unknown): value is string {
  return typeof value === "string" && UUID_ID_REGEX.test(value);
}

export function isPrefixedId(value: unknown): value is string {
  return typeof value === "string" && PREFIXED_ID_REGEX.test(value);
}

export function asProjectId(value: string): ProjectId {
  if (!isUuidId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "ProjectId must be a valid UUID");
  }
  return value as ProjectId;
}

export function asIndexId(value: string): IndexId {
  if (!isUuidId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "IndexId must be a valid UUID");
  }
  return value as IndexId;
}

export function asTransactionId(value: string): TransactionId {
  if (!isUuidId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "TransactionId must be a valid UUID");
  }
  return value as TransactionId;
}

export function asOrganizationId(value: string): OrganizationId {
  if (!isUuidId(value) && !isPrefixedId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "OrganizationId must be a valid UUID or prefixed identifier");
  }
  return value as OrganizationId;
}

export function asUserId(value: string): UserId {
  if (!isUuidId(value) && !isPrefixedId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "UserId must be a valid UUID or prefixed identifier");
  }
  return value as UserId;
}

export function asApiKeyId(value: string): ApiKeyId {
  if (!isUuidId(value) && !isPrefixedId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "ApiKeyId must be a valid UUID or prefixed identifier");
  }
  return value as ApiKeyId;
}

export function asSessionId(value: string): SessionId {
  if (!isUuidId(value) && !isPrefixedId(value)) {
    throw new VellumError("INVALID_ARGUMENT", "SessionId must be a valid UUID or prefixed identifier");
  }
  return value as SessionId;
}

export function asDocumentId(value: string): DocumentId {
  if (typeof value !== "string" || value === "." || value === ".." || !DOCUMENT_ID_REGEX.test(value)) {
    throw new VellumError("INVALID_ARGUMENT", "DocumentId contains invalid characters or traversal segments");
  }
  return value as DocumentId;
}
