/**
 * Automatic public-field projection from an auth user into a tenant document.
 * Rules can never block this system write: this is a trusted internal caller,
 * so it uses an `InternalEngineContext` (`internal: true` plus
 * `bypassRules: true`) — the public `EngineContext` deliberately has no bypass
 * flag. `merge: true` preserves fields a developer added to the doc.
 */

import type { AuthUserRecord, TenantContext } from "@vellum/storage";

export interface DocumentProjectorEngine {
  setDocument(ctx: TenantContext & {
    path: string;
    data: Record<string, unknown>;
    merge?: boolean | undefined;
    /** Marks this caller as a trusted system component (InternalEngineContext). */
    internal: true;
    bypassRules?: boolean | undefined;
  }): Promise<unknown>;
}

export interface ProjectedUserDocument {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  emailVerified: boolean;
  isAnonymous: boolean;
  customClaims: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function buildProjectedUserDocument(user: AuthUserRecord): ProjectedUserDocument {
  return {
    uid: user.id,
    email: user.email,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    phoneNumber: user.phoneNumber,
    emailVerified: user.emailVerified,
    isAnonymous: user.isAnonymous,
    customClaims: user.customClaims,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toDocumentRecord(doc: ProjectedUserDocument): Record<string, unknown> {
  return {
    uid: doc.uid,
    email: doc.email,
    displayName: doc.displayName,
    photoUrl: doc.photoUrl,
    phoneNumber: doc.phoneNumber,
    emailVerified: doc.emailVerified,
    isAnonymous: doc.isAnonymous,
    customClaims: doc.customClaims,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class DocumentProjector {
  constructor(private readonly documentEngine: DocumentProjectorEngine) {}

  public async project(
    ctx: TenantContext,
    user: AuthUserRecord,
    collectionPath: string
  ): Promise<void> {
    const path = `${collectionPath.replace(/^\/+|\/+$/g, "")}/${user.id}`;
    await this.documentEngine.setDocument({
      projectId: ctx.projectId,
      path,
      data: toDocumentRecord(buildProjectedUserDocument(user)),
      merge: true,
      internal: true,
      bypassRules: true,
    });
  }
}
