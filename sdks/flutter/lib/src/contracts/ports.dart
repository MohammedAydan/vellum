part of '../../vellum_flutter.dart';

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
    JsonMap? customClaims,
  });
  Future<VellumAuthResult> signInWithEmailAndPassword({
    required String email,
    required String password,
  });
  Future<VellumUser> signInAnonymously({
    String? displayName,
    JsonMap? metadata,
  });
  Future<VellumUser> signInWithOAuth({
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
  Future<VellumUser> getUser();
  Future<VellumUser> verifyMfaChallenge({
    required String mfaTicket,
    required String code,
    String? factorType,
  });
  Future<TotpEnrollment> enrollTotpMfa({String? issuer});
  Future<void> confirmTotpMfa({required String code});
  Future<AuthActionResult> sendPasswordResetEmail(String email);
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  });
  Future<AuthActionResult> sendEmailVerification({String? email});
  Future<void> confirmEmailVerification(String token);
  Future<VellumUser> updateProfile({
    String? email,
    String? displayName,
    String? photoUrl,
    String? phoneNumber,
    bool? phoneVerified,
    JsonMap? metadata,
    JsonMap? customClaims,
    String? password,
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
