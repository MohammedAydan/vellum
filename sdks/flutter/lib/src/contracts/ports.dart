part of '../../vellum_flutter_core.dart';

/// Canonical JSON object map type.
typedef JsonMap = Map<String, Object?>;

/// Canonical JSON array list type.
typedef JsonList = List<Object?>;

/// Sealed typed result for contract-first error handling without untyped throws.
sealed class VellumResult<T extends Object, E extends Object> {
  const VellumResult();

  bool get isOk => this is VellumOk<T, E>;
  bool get isErr => this is VellumErr<T, E>;
}

final class VellumOk<T extends Object, E extends Object> extends VellumResult<T, E> {
  const VellumOk(this.value);
  final T value;
}

final class VellumErr<T extends Object, E extends Object> extends VellumResult<T, E> {
  const VellumErr(this.error);
  final E error;
}

/// Validated UUID project identifier value object.
final class ProjectId {
  ProjectId(this.value) {
    if (!_uuidPattern.hasMatch(value)) {
      throw const VellumException(
        code: 'INVALID_ARGUMENT',
        message: 'ProjectId must be a valid UUID',
        statusCode: 400,
      );
    }
  }

  static final RegExp _uuidPattern = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  final String value;

  @override
  bool operator ==(Object other) => other is ProjectId && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'ProjectId($value)';
}

/// Validated document path value object rejecting traversal and control chars.
final class DocumentPathId {
  DocumentPathId(this.value) {
    validateVellumPath(value, requireEvenSegments: true);
  }

  final String value;

  @override
  bool operator ==(Object other) => other is DocumentPathId && other.value == value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'DocumentPathId($value)';
}

/// Abstract contract port for pluggable auth token and session persistence.
abstract interface class TokenStoragePort {
  Future<String?> readAccessToken();

  Future<void> writeAccessToken(String? token);

  Future<String?> readRefreshToken();

  Future<void> writeRefreshToken(String? token);

  Future<JsonMap?> readUser();

  Future<void> writeUser(JsonMap? user);
}

/// Abstract contract port for end-user authentication operations.
abstract interface class VellumAuthPort {
  int get sessionEpoch;
  VellumUser? get currentUser;
  Stream<VellumUser?> get authStateChanges;
  Future<void> restore();
  Future<String?> getIdToken({bool forceRefresh = false});
  Future<VellumUser> signUpWithEmailAndPassword({
    required String email,
    required String password,
    String? displayName,
    String? photoUrl,
    String? phoneNumber,
    JsonMap? metadata,
  });
  Future<VellumAuthResult> signInWithEmailAndPassword({
    required String email,
    required String password,
  });
  Future<VellumUser> signInAnonymously({
    String? displayName,
    JsonMap? metadata,
  });
  /// Resolves to [VellumMfaRequired] when the account has a second factor, like
  /// the other sign-in methods. No session is stored in that case.
  Future<VellumAuthResult> signInWithOAuth({
    required String provider,
    String? idToken,
    String? accessToken,
    String? providerUserId,
    String? email,
    bool? emailVerified,
    String? displayName,
    String? photoUrl,
    JsonMap? metadata,
  });
  /// Browser-based Google / GitHub sign-in is driven by [VellumOAuth] (and the
  /// `vellum_flutter_oauth` package); these are its building blocks.
  ///
  /// Starts the server-side OAuth flow for [provider] and returns the provider's
  /// authorize URL. The API key is sent as a header, never in a URL. The server
  /// returns to [redirectUri] (a loopback `http://127.0.0.1:<port>/...` is always
  /// accepted, anything else must be in the project's allowed list) with a
  /// one-time `vellum_code`.
  Future<Uri> oauthStart({
    required String provider,
    required String redirectUri,
    required String codeChallenge,
    String? state,
    bool link = false,
    String? currentPassword,
  });

  /// Starts a redirect-less sign-in: no redirect URI, no deep link, no app
  /// registration. Open the returned URL in the system browser, then call
  /// [pollOAuth] with the PKCE verifier until it resolves.
  Future<Uri> oauthStartPoll({
    required String provider,
    required String codeChallenge,
    bool link = false,
    String? currentPassword,
  });

  /// Collects the result of [oauthStartPoll]. Resolves to `null` while the
  /// browser step is still in progress.
  Future<VellumAuthResult?> pollOAuth({required String codeVerifier});

  /// Trades the one-time `vellum_code` plus the PKCE [codeVerifier] for a session.
  Future<VellumAuthResult> exchangeOAuthCode({
    required String code,
    required String codeVerifier,
  });

  /// Signs in with a Google ID token (for example from `google_sign_in`).
  /// The server verifies it against Google's keys and the project's client IDs.
  Future<VellumAuthResult> signInWithGoogleIdToken({
    required String idToken,
    String? nonce,
  });

  /// Signs in with the `identityToken` from Sign in with Apple
  /// (`sign_in_with_apple`). Pass the raw nonce you used (or its SHA-256, which
  /// is what Apple's native sheet embeds), the `authorizationCode` so the grant
  /// can be revoked when the account is deleted, and the name from the first
  /// authorization (Apple only sends it once).
  Future<VellumAuthResult> signInWithAppleIdToken({
    required String idToken,
    String? nonce,
    String? authorizationCode,
    String? givenName,
    String? familyName,
  });
  Future<VellumUser> getUser();
  Future<VellumUser> verifyMfaChallenge({
    required String mfaTicket,
    required String code,
    String? factorType,
  });
  Future<TotpEnrollment> enrollTotpMfa({String? issuer});
  Future<void> confirmTotpMfa({required String code});
  Future<void> disableMfa({required String code});
  Future<AuthActionResult> sendPasswordResetEmail(String email);
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  });
  /// Active sessions (devices) of the signed-in user.
  Future<List<VellumSessionInfo>> listSessions();

  /// Signs one of the user's sessions out.
  Future<void> revokeSession(String sessionId);

  /// Sign-in methods linked to the account.
  Future<VellumLinkedProviders> listIdentities();
  @Deprecated('Use listIdentities() instead.')
  Future<VellumLinkedProviders> listLinkedProviders();

  /// Removes a linked sign-in method. Refused when it is the last one.
  ///
  /// Pass [currentPassword] when the account has a password. Accounts without
  /// one must have signed in within the last 10 minutes.
  Future<void> unlinkProvider(String provider, {String? currentPassword});

  /// Changes the password of the signed-in user. Needs the current password;
  /// every other session ends and this one continues on a fresh session.
  Future<VellumUser> changePassword({
    required String currentPassword,
    required String newPassword,
  });

  /// Permanently deletes the signed-in account and signs out locally.
  /// Password accounts must pass [password]; Google/GitHub/Apple accounts need nothing.
  Future<void> deleteAccount({String? password});
  Future<AuthActionResult> sendEmailVerification({String? email});
  Future<void> confirmEmailVerification(String token);
  Future<VellumUser> updateProfile({
    String? email,
    String? displayName,
    String? photoUrl,
    String? phoneNumber,
    bool? phoneVerified,
    JsonMap? metadata,
    String? password,
    String? currentPassword,
  });
  Future<void> signOut({bool allSessions = false});
  void dispose();
}

/// Abstract contract port for multiplexed realtime subscriptions.
abstract interface class VellumRealtimePort {
  String subscribe(
    JsonMap target,
    void Function(JsonMap frame) onFrame,
    void Function(Object error)? onError, {
    void Function()? onClose,
  });
  void unsubscribe(String subId);
  void dispose();
  void close();
}

/// Abstract contract port for the top-level VELLUM client facade.
abstract interface class VellumClientPort {
  String get endpoint;
  String get projectId;
  String get baseUrl;
  VellumAuthPort get auth;
  VellumRealtimePort get realtime;
  CollectionReference<JsonMap> collection(String path);
  DocumentReference<JsonMap> doc(String path);
  Future<DocumentSnapshot<JsonMap>> getDoc(String path);
  Future<void> setDoc(
    String path,
    JsonMap data, {
    bool merge = false,
    int? ifVersion,
    String? idempotencyKey,
  });
  Future<void> updateDoc(
    String path,
    JsonMap data, {
    int? ifVersion,
    String? idempotencyKey,
  });
  Future<void> deleteDoc(
    String path, {
    int? ifVersion,
    String? idempotencyKey,
  });
  Query<JsonMap> query(
    String collectionPath, {
    Object? where,
    Object? orderBy,
    int? limit,
    String? cursor,
  });
  Future<JsonMap> batchWrite(
    List<JsonMap> writes, {
    String? idempotencyKey,
  });
  Future<List<JsonMap>> writeBatchChunked(
    List<JsonMap> writes, {
    int chunkSize = 500,
    String? idempotencyKeyPrefix,
  });
  VellumWriteBatch batch();
  Stream<QuerySnapshot<JsonMap>> watchCollection(
    String collectionPath, {
    Object? where,
    Object? orderBy,
    int? limit,
    String? cursor,
  });
  Stream<DocumentSnapshot<JsonMap>> watchDocument(String path);
  Future<R> runTransaction<R>(
    Future<R> Function(TransactionContext tx) updateFn, {
    int maxAttempts = 5,
  });
  Future<ListCollectionsResult> listCollections({
    String? search,
    int? limit,
    String? cursor,
  });
  Future<VellumCollectionInfo> createCollection(
    String name, {
    String? description,
    int? defaultTtlSeconds,
    JsonMap? schemaValidation,
    JsonMap? metadata,
    bool? ifNotExists,
  });
  Future<VellumCollectionInfo?> getCollectionInfo(String name);
  Future<VellumCollectionInfo> updateCollection(
    String name, {
    String? description,
    int? defaultTtlSeconds,
    JsonMap? schemaValidation,
  });
  Future<ClearCollectionResult> clearCollection(String name);
  Future<DeleteCollectionResult> deleteCollection(String name);
  Future<ImportResult> importDocuments(
    String collection,
    List<JsonMap> docs, {
    String? mode,
  });
  Future<ExportResult> exportDocuments(
    String collection, {
    int? limit,
    String? cursor,
  });
  void dispose();
  void close();
}
