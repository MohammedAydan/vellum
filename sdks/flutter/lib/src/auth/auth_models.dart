/// Immutable end-user authentication models with secret-redacting toString() overrides.
part of '../../vellum_flutter_core.dart';

/// A signed-in end-user snapshot: public fields plus the SDK-held token material.
class VellumUser {
  final String id;
  final String? email;
  final bool emailVerified;
  final String? displayName;
  final String? photoUrl;
  final String? phoneNumber;
  final bool phoneVerified;
  final bool isDisabled;
  final bool isAnonymous;
  final JsonMap customClaims;
  final JsonMap metadata;
  final String createdAt;
  final String updatedAt;
  final String? lastSignInAt;
  final String accessToken;
  final String refreshToken;
  final String tokenType;
  final String sessionId;
  final String expiresAt;

  const VellumUser({
    required this.id,
    this.email,
    this.emailVerified = false,
    this.displayName,
    this.photoUrl,
    this.phoneNumber,
    this.phoneVerified = false,
    this.isDisabled = false,
    this.isAnonymous = false,
    this.customClaims = const <String, Object?>{},
    this.metadata = const <String, Object?>{},
    this.createdAt = '',
    this.updatedAt = '',
    this.lastSignInAt,
    this.accessToken = '',
    this.refreshToken = '',
    this.tokenType = 'Bearer',
    this.sessionId = '',
    this.expiresAt = '',
  });

  factory VellumUser.fromJson(JsonMap json) {
    return VellumUser(
      id: json['id'] is String ? json['id'] as String : '',
      email: json['email'] is String ? json['email'] as String : null,
      emailVerified: json['emailVerified'] == true,
      displayName:
          json['displayName'] is String ? json['displayName'] as String : null,
      photoUrl: json['photoUrl'] is String ? json['photoUrl'] as String : null,
      phoneNumber:
          json['phoneNumber'] is String ? json['phoneNumber'] as String : null,
      phoneVerified: json['phoneVerified'] == true,
      isDisabled: json['isDisabled'] == true,
      isAnonymous: json['isAnonymous'] == true,
      customClaims: json['customClaims'] is Map
          ? Map<String, Object?>.unmodifiable(
              (json['customClaims'] as Map).cast<String, Object?>(),
            )
          : const <String, Object?>{},
      metadata: json['metadata'] is Map
          ? Map<String, Object?>.unmodifiable(
              (json['metadata'] as Map).cast<String, Object?>(),
            )
          : const <String, Object?>{},
      createdAt: json['createdAt'] is String ? json['createdAt'] as String : '',
      updatedAt: json['updatedAt'] is String ? json['updatedAt'] as String : '',
      lastSignInAt: json['lastSignInAt'] is String
          ? json['lastSignInAt'] as String
          : null,
      accessToken:
          json['accessToken'] is String ? json['accessToken'] as String : '',
      refreshToken:
          json['refreshToken'] is String ? json['refreshToken'] as String : '',
      tokenType:
          json['tokenType'] is String ? json['tokenType'] as String : 'Bearer',
      sessionId: json['sessionId'] is String ? json['sessionId'] as String : '',
      expiresAt: json['expiresAt'] is String ? json['expiresAt'] as String : '',
    );
  }

  /// Parses a `{ user, accessToken, refreshToken, ... }` session response.
  factory VellumUser.fromSession(JsonMap session) {
    final Object? rawUser = session['user'];
    if (rawUser is! Map ||
        rawUser['id'] is! String ||
        (rawUser['id'] as String).trim().isEmpty) {
      throw const VellumException(
          code: 'INVALID_AUTH_RESPONSE',
          message: 'Invalid auth response: missing user.id',
          statusCode: 502);
    }
    final JsonMap userMap = rawUser.cast<String, Object?>();
    for (final field in [
      'accessToken',
      'refreshToken',
      'sessionId',
      'expiresAt'
    ]) {
      _requireAuthString(session[field], field);
    }
    if (DateTime.tryParse(session['expiresAt'] as String) == null ||
        (session['tokenType'] != null && session['tokenType'] != 'Bearer')) {
      throw const VellumException(
          code: 'INVALID_AUTH_RESPONSE',
          message:
              'Invalid auth response: invalid session expiry or token type',
          statusCode: 502);
    }
    return VellumUser.fromJson(<String, Object?>{
      ...userMap,
      'accessToken': session['accessToken'],
      'refreshToken': session['refreshToken'],
      'tokenType': session['tokenType'] ?? 'Bearer',
      'sessionId': session['sessionId'],
      'expiresAt': session['expiresAt'],
    });
  }

  JsonMap toJson() => <String, Object?>{
        'id': id,
        'email': email,
        'emailVerified': emailVerified,
        'displayName': displayName,
        'photoUrl': photoUrl,
        'phoneNumber': phoneNumber,
        'phoneVerified': phoneVerified,
        'isDisabled': isDisabled,
        'isAnonymous': isAnonymous,
        'customClaims': customClaims,
        'metadata': metadata,
        'createdAt': createdAt,
        'updatedAt': updatedAt,
        'lastSignInAt': lastSignInAt,
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'tokenType': tokenType,
        'sessionId': sessionId,
        'expiresAt': expiresAt,
      };

  @override
  String toString() =>
      'VellumUser(id: $id, email: $email, isAnonymous: $isAnonymous, '
      'accessToken: <redacted>, refreshToken: <redacted>)';
}

/// Result of a sign-in that may require a second factor.
sealed class VellumAuthResult {
  const VellumAuthResult();
}

class VellumSession extends VellumAuthResult {
  final VellumUser user;

  const VellumSession(this.user);

  @override
  String toString() => 'VellumSession(user: $user)';
}

class VellumMfaRequired extends VellumAuthResult {
  final String mfaTicket;
  final List<String> factors;
  final String expiresAt;

  const VellumMfaRequired({
    required this.mfaTicket,
    this.factors = const <String>[],
    required this.expiresAt,
  });

  @override
  String toString() =>
      'VellumMfaRequired(mfaTicket: <redacted>, factors: $factors, expiresAt: $expiresAt)';
}

class TotpEnrollment {
  final String secret;
  final String otpauthUri;
  final List<String> recoveryCodes;

  const TotpEnrollment({
    required this.secret,
    required this.otpauthUri,
    this.recoveryCodes = const <String>[],
  });

  @override
  String toString() =>
      'TotpEnrollment(secret: <redacted>, otpauthUri: <redacted>, '
      'recoveryCodes: [${recoveryCodes.length} redacted])';
}

class AuthActionResult {
  final bool success;
  final String? devToken;
  final String? expiresAt;

  const AuthActionResult({
    required this.success,
    this.devToken,
    this.expiresAt,
  });

  @override
  String toString() =>
      'AuthActionResult(success: $success, devToken: ${devToken != null ? '<redacted>' : 'null'}, '
      'expiresAt: $expiresAt)';
}
