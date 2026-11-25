/// Reactive end-user authentication client with single-flight refresh and session epoch tracking.
part of '../../vellum_flutter_core.dart';

String _requireAuthString(Object? value, String field) {
  if (value is! String || value.trim().isEmpty) {
    throw VellumException(
      code: 'INVALID_AUTH_RESPONSE',
      message: 'Invalid auth response: missing $field',
      statusCode: 502,
    );
  }
  return value;
}

/// Reads the JWT `exp` claim. Uses only base64/JSON decoding — no `eval`.
int? _jwtExpirySeconds(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return null;
  try {
    final normalized = base64.normalize(parts[1]);
    final decoded = utf8.decode(base64.decode(normalized));
    final Object? payload = jsonDecode(decoded);
    if (payload is Map) {
      final Object? exp = payload['exp'];
      if (exp is num) return exp.toInt();
    }
    return null;
  } catch (_) {
    return null;
  }
}

bool _isTokenExpiringWithin(String token, Duration skew) {
  final exp = _jwtExpirySeconds(token);
  if (exp == null) return false;
  return exp * 1000 - skew.inMilliseconds <=
      DateTime.now().millisecondsSinceEpoch;
}

/// Reactive end-user auth, wired into the owning [VellumClient]'s REST and WS.
class VellumAuth implements VellumAuthPort {
  final VellumClient client;
  final TokenStoragePort storage;

  final StreamController<VellumUser?> _authController =
      StreamController<VellumUser?>.broadcast();
  VellumUser? _currentUser;
  Future<VellumUser?>? _inFlightRefresh;
  Timer? _refreshTimer;
  int _sessionEpoch = 0;
  bool _disposed = false;

  /// Monotonic counter incremented on sign-in, session restore, sign-out, and
  /// disposal. Guards in-flight token refreshes from resurrecting stale sessions.
  @override
  int get sessionEpoch => _sessionEpoch;

  VellumAuth(this.client, {TokenStoragePort? storage})
      : storage = storage ?? InMemoryAuthTokenStorage();

  /// Auth state stream.
  ///
  /// Subscribing immediately yields the current state (`null` when signed out),
  /// then every subsequent transition: sign-in, token refresh, profile update
  /// and sign-out. Each call to this getter creates an independent stream, so
  /// separate UI components can listen concurrently without sharing state.
  @override
  Stream<VellumUser?> get authStateChanges {
    // A synchronous broadcast controller delivers the value added inside
    // `onListen` before `.listen()` returns, while still supporting the
    // single listener that each call to this getter creates.
    final controller = StreamController<VellumUser?>.broadcast(sync: true);
    StreamSubscription<VellumUser?>? inner;

    void forward(VellumUser? user) {
      if (!controller.isClosed) controller.add(user);
    }

    controller.onListen = () {
      inner = _authController.stream.listen(
        forward,
        onError: (Object error, StackTrace stack) {
          if (!controller.isClosed) controller.addError(error, stack);
        },
        onDone: () {
          if (!controller.isClosed) controller.close();
        },
      );
      forward(_currentUser);
    };
    controller.onCancel = () async {
      final subscription = inner;
      inner = null;
      await subscription?.cancel();
    };
    return controller.stream;
  }

  @override
  VellumUser? get currentUser => _currentUser;

  /// Rehydrates a previously persisted session. Safe to call at app startup.
  @override
  Future<void> restore() async {
    if (_disposed) return;
    final startEpoch = _sessionEpoch;
    final stored = await storage.readUser();
    final access = await storage.readAccessToken();
    final refresh = await storage.readRefreshToken();
    if (_disposed || _sessionEpoch != startEpoch) return;
    if (stored == null || access == null || refresh == null) return;
    _sessionEpoch++;
    await _setCurrentUser(VellumUser.fromJson(<String, Object?>{
      ...stored,
      'accessToken': access,
      'refreshToken': refresh,
    }));
  }

  Future<void> _setCurrentUser(
    VellumUser? user, {
    bool emit = true,
    int? expectedEpoch,
  }) async {
    if (_disposed) return;
    if (expectedEpoch != null && _sessionEpoch != expectedEpoch) return;
    if (_currentUser?.id != user?.id ||
        _currentUser?.accessToken != user?.accessToken) {
      client.clearCache();
      // Token rotation keeps the offline store (entries are per user); a
      // different user or sign-out wipes it.
      if (_currentUser?.id != user?.id) client.clearDocumentCache();
    }
    final sameUserTokenChanged = user != null &&
        _currentUser?.id == user.id &&
        _currentUser?.accessToken != user.accessToken;
    if (_currentUser?.id != user?.id) client.realtime.dispose();
    _currentUser = user;
    if (sameUserTokenChanged) client.realtime.refreshCredentials();
    _scheduleRefresh();
    if (emit && !_authController.isClosed) _authController.add(user);
    await storage.writeAccessToken(user?.accessToken);
    await storage.writeRefreshToken(user?.refreshToken);
    await storage.writeUser(user?.toJson());
  }

  void _requireCurrentEpoch(int expectedEpoch) {
    if (_disposed || _sessionEpoch != expectedEpoch) {
      throw const VellumException(
        code: 'AUTH_STATE_CHANGED',
        message: 'Auth state changed while the request was in flight',
        statusCode: 409,
      );
    }
  }

  void _scheduleRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = null;
    if (_disposed || !client.autoRefresh) return;
    final user = _currentUser;
    if (user == null) return;
    final exp = _jwtExpirySeconds(user.accessToken);
    if (exp == null) return;
    final delayMs =
        max(0, exp * 1000 - 60000 - DateTime.now().millisecondsSinceEpoch);
    _refreshTimer = Timer(Duration(milliseconds: delayMs), () {
      _refreshTimer = null;
      if (_disposed) return;
      getIdToken(forceRefresh: true).catchError((Object _) => null);
    });
  }

  /// Returns a valid access token, refreshing 60 s before expiry. Concurrent
  /// forced refreshes share one in-flight request.
  @override
  Future<String?> getIdToken({bool forceRefresh = false}) async {
    if (_disposed) return null;
    final user = _currentUser;
    if (user == null) return null;
    if (!forceRefresh &&
        (!client.autoRefresh ||
            !_isTokenExpiringWithin(
                user.accessToken, const Duration(seconds: 60)))) {
      return user.accessToken;
    }

    final startEpoch = _sessionEpoch;
    final pending = _inFlightRefresh;
    if (pending != null) {
      try {
        final refreshed = await pending;
        if (_disposed || _sessionEpoch != startEpoch) return null;
        return refreshed?.accessToken;
      } catch (_) {
        return null;
      }
    }
    final task = _performRefresh(user, startEpoch);
    _inFlightRefresh = task;
    try {
      final refreshed = await task;
      if (_disposed || _sessionEpoch != startEpoch) return null;
      return refreshed?.accessToken;
    } catch (_) {
      return null;
    } finally {
      if (identical(_inFlightRefresh, task)) _inFlightRefresh = null;
    }
  }

  /// Coalesces reactive 401 refreshes across concurrent and staggered requests.
  ///
  /// If another request has already rotated [failedToken] to a newer token,
  /// returns that newer token immediately without issuing another refresh call.
  Future<String?> refreshOnUnauthorized(String? failedToken) async {
    if (_disposed || !client.autoRefresh) return null;
    final user = _currentUser;
    if (user == null || user.refreshToken.isEmpty) return null;
    if (failedToken != null &&
        failedToken.isNotEmpty &&
        user.accessToken.isNotEmpty &&
        user.accessToken != failedToken &&
        !_isTokenExpiringWithin(
            user.accessToken, const Duration(seconds: 60))) {
      return user.accessToken;
    }
    return getIdToken(forceRefresh: true);
  }

  Future<VellumUser?> _performRefresh(
      VellumUser user, int expectedEpoch) async {
    if (_disposed || _sessionEpoch != expectedEpoch) return null;
    // No bearer on the refresh call: that would recurse into getIdToken.
    final res = await client.request(
      'POST',
      '/auth/token/refresh',
      body: <String, Object?>{'refreshToken': user.refreshToken},
      includeAuth: false,
    );
    // Abort if signOut(), dispose(), or a new sign-in occurred while in flight.
    if (_disposed || _sessionEpoch != expectedEpoch) return null;
    final next = VellumUser.fromSession(<String, Object?>{
      'user': user.toJson(),
      'accessToken': _requireAuthString(res['accessToken'], 'accessToken'),
      'refreshToken': _requireAuthString(res['refreshToken'], 'refreshToken'),
      'tokenType': res['tokenType'] is String ? res['tokenType'] : 'Bearer',
      'sessionId':
          res.containsKey('sessionId') ? res['sessionId'] : user.sessionId,
      'expiresAt':
          res.containsKey('expiresAt') ? res['expiresAt'] : user.expiresAt,
    });
    // Refresh changes the token material that consumers hold, so emit the new
    // state to keep every authStateChanges listener in sync.
    await _setCurrentUser(next, expectedEpoch: expectedEpoch);
    if (_disposed || _sessionEpoch != expectedEpoch) return null;
    return next;
  }

  @override
  Future<VellumUser> signUpWithEmailAndPassword({
    required String email,
    required String password,
    String? displayName,
    String? photoUrl,
    String? phoneNumber,
    JsonMap? metadata,
    JsonMap? customClaims,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/sign-up/email',
      body: <String, Object?>{
        'email': email,
        'password': password,
        if (displayName != null) 'displayName': displayName,
        if (photoUrl != null) 'photoUrl': photoUrl,
        if (phoneNumber != null) 'phoneNumber': phoneNumber,
        if (metadata != null) 'metadata': metadata,
        if (customClaims != null) 'customClaims': customClaims,
      },
      includeAuth: false,
    );
    _requireCurrentEpoch(expectedEpoch);
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return user;
  }

  @override
  Future<VellumAuthResult> signInWithEmailAndPassword({
    required String email,
    required String password,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/sign-in/email',
      body: <String, Object?>{'email': email, 'password': password},
      includeAuth: false,
    );
    _requireCurrentEpoch(expectedEpoch);
    if (res['mfaRequired'] == true) {
      // No session was issued: currentUser is deliberately left untouched.
      return VellumMfaRequired(
        mfaTicket: _requireAuthString(res['mfaTicket'], 'mfaTicket'),
        factors: (res['factors'] is List)
            ? (res['factors'] as List).whereType<String>().toList()
            : const <String>[],
        expiresAt: res['expiresAt'] is String ? res['expiresAt'] as String : '',
      );
    }
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return VellumSession(user);
  }

  @override
  Future<VellumUser> signInAnonymously({
    String? displayName,
    JsonMap? metadata,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/sign-in/anonymous',
      body: <String, Object?>{
        if (displayName != null) 'displayName': displayName,
        if (metadata != null) 'metadata': metadata,
      },
      includeAuth: false,
    );
    _requireCurrentEpoch(expectedEpoch);
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return user;
  }

  @override
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
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/sign-in/provider',
      body: <String, Object?>{
        'provider': provider,
        if (idToken != null) 'idToken': idToken,
        if (accessToken != null) 'accessToken': accessToken,
        if (providerUserId != null) 'providerUserId': providerUserId,
        if (email != null) 'email': email,
        if (emailVerified != null) 'emailVerified': emailVerified,
        if (displayName != null) 'displayName': displayName,
        if (photoUrl != null) 'photoUrl': photoUrl,
        if (metadata != null) 'metadata': metadata,
      },
      includeAuth: false,
    );
    _requireCurrentEpoch(expectedEpoch);
    if (res['mfaRequired'] == true) {
      // No session was issued: currentUser is deliberately left untouched.
      return VellumMfaRequired(
        mfaTicket: _requireAuthString(res['mfaTicket'], 'mfaTicket'),
        factors: (res['factors'] is List)
            ? (res['factors'] as List).whereType<String>().toList()
            : const <String>[],
        expiresAt: res['expiresAt'] is String ? res['expiresAt'] as String : '',
      );
    }
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return VellumSession(user);
  }

  @override
  Future<Uri> oauthStart({
    required String provider,
    required String redirectUri,
    required String codeChallenge,
    String? state,
    bool link = false,
    String? currentPassword,
  }) async {
    // The API key goes in a header of this POST, never in a URL the browser could expose.
    final res = await client.request(
      'POST',
      '/auth/oauth/${Uri.encodeComponent(provider)}/start',
      body: <String, Object?>{
        'redirectUri': redirectUri,
        'codeChallenge': codeChallenge,
        if (state != null) 'state': state,
        if (link) 'link': true,
        if (link && currentPassword != null) 'currentPassword': currentPassword,
      },
      // Linking is done by a signed-in user: the server needs their token.
      includeAuth: link,
    );
    final url = res['authorizeUrl'];
    if (url is! String || url.isEmpty) {
      throw const VellumException(
        code: 'INTERNAL',
        message: 'The server did not return a sign-in URL',
        statusCode: 0,
      );
    }
    return Uri.parse(url);
  }

  @override
  Future<Uri> oauthStartPoll({
    required String provider,
    required String codeChallenge,
    bool link = false,
    String? currentPassword,
  }) async {
    final res = await client.request(
      'POST',
      '/auth/oauth/${Uri.encodeComponent(provider)}/start',
      body: <String, Object?>{
        'delivery': 'poll',
        'codeChallenge': codeChallenge,
        if (link) 'link': true,
        if (link && currentPassword != null) 'currentPassword': currentPassword,
      },
      includeAuth: link,
    );
    final url = res['authorizeUrl'];
    if (url is! String || url.isEmpty) {
      throw const VellumException(
        code: 'INTERNAL',
        message: 'The server did not return a sign-in URL',
        statusCode: 0,
      );
    }
    return Uri.parse(url);
  }

  @override
  Future<VellumAuthResult?> pollOAuth({required String codeVerifier}) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/oauth/poll',
      body: <String, Object?>{'codeVerifier': codeVerifier},
      includeAuth: false,
    );
    if (res['status'] == 'pending') return null;
    return _completeSignIn(res, expectedEpoch);
  }

  @override
  Future<VellumAuthResult> exchangeOAuthCode({
    required String code,
    required String codeVerifier,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/oauth/exchange',
      body: <String, Object?>{'code': code, 'codeVerifier': codeVerifier},
      includeAuth: false,
    );
    return _completeSignIn(res, expectedEpoch);
  }

  @override
  Future<VellumAuthResult> signInWithGoogleIdToken({
    required String idToken,
    String? nonce,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/oauth/google/id-token',
      body: <String, Object?>{
        'idToken': idToken,
        if (nonce != null) 'nonce': nonce,
      },
      includeAuth: false,
    );
    return _completeSignIn(res, expectedEpoch);
  }

  @override
  Future<VellumAuthResult> signInWithAppleIdToken({
    required String idToken,
    String? nonce,
    String? authorizationCode,
    String? givenName,
    String? familyName,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/oauth/apple/id-token',
      body: <String, Object?>{
        'idToken': idToken,
        if (nonce != null) 'nonce': nonce,
        if (authorizationCode != null) 'authorizationCode': authorizationCode,
        if (givenName != null) 'givenName': givenName,
        if (familyName != null) 'familyName': familyName,
      },
      includeAuth: false,
    );
    return _completeSignIn(res, expectedEpoch);
  }

  Future<VellumAuthResult> _completeSignIn(
    JsonMap res,
    int expectedEpoch,
  ) async {
    _requireCurrentEpoch(expectedEpoch);
    if (res['mfaRequired'] == true) {
      return VellumMfaRequired(
        mfaTicket: _requireAuthString(res['mfaTicket'], 'mfaTicket'),
        factors: (res['factors'] is List)
            ? (res['factors'] as List).whereType<String>().toList()
            : const <String>[],
        expiresAt: res['expiresAt'] is String ? res['expiresAt'] as String : '',
      );
    }
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return VellumSession(user);
  }

  /// Fetches the authenticated end-user's public profile from `GET /auth/user`.
  ///
  /// The fresh profile is merged into [currentUser] while preserving the
  /// SDK-held token material. This is a read, so listeners are not notified;
  /// mutations such as [updateProfile] do emit an auth-state transition.
  @override
  Future<VellumUser> getUser() async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request('GET', '/auth/user');
    _requireCurrentEpoch(expectedEpoch);
    final rawUser = res['user'];
    if (rawUser is! Map ||
        rawUser['id'] is! String ||
        (rawUser['id'] as String).trim().isEmpty) {
      throw const VellumException(
        code: 'INVALID_AUTH_RESPONSE',
        message: 'Invalid auth response: missing user',
        statusCode: 502,
      );
    }
    final user = VellumUser.fromJson(<String, Object?>{
      ...(_currentUser?.toJson() ?? <String, Object?>{}),
      ...rawUser.cast<String, Object?>(),
    });
    await _setCurrentUser(user, emit: false);
    return user;
  }

  @override
  Future<VellumUser> verifyMfaChallenge({
    required String mfaTicket,
    required String code,
    String? factorType,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/mfa/challenge',
      body: <String, Object?>{
        'mfaTicket': mfaTicket,
        'code': code,
        if (factorType != null) 'factorType': factorType,
      },
      includeAuth: false,
    );
    _requireCurrentEpoch(expectedEpoch);
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return user;
  }

  @override
  Future<TotpEnrollment> enrollTotpMfa({String? issuer}) async {
    final res = await client.request(
      'POST',
      '/auth/mfa/enroll',
      body: <String, Object?>{if (issuer != null) 'issuer': issuer},
    );
    return TotpEnrollment(
      secret: _requireAuthString(res['secret'], 'secret'),
      otpauthUri: _requireAuthString(res['otpauthUri'], 'otpauthUri'),
      recoveryCodes: (res['recoveryCodes'] is List)
          ? (res['recoveryCodes'] as List).whereType<String>().toList()
          : const <String>[],
    );
  }

  @override
  Future<void> confirmTotpMfa({required String code}) async {
    await client.request('POST', '/auth/mfa/verify',
        body: <String, Object?>{'code': code});
  }

  @override
  Future<void> disableMfa({required String code}) async {
    await client.request('POST', '/auth/mfa/disable',
        body: <String, Object?>{'code': code});
  }

  /// Sends a password-reset email.
  ///
  /// [email] is positional to keep the public surface identical across SDKs.
  @override
  Future<AuthActionResult> sendPasswordResetEmail(String email) async {
    final res = await client.request(
      'POST',
      '/auth/password/reset',
      body: <String, Object?>{'email': email},
      includeAuth: false,
    );
    return AuthActionResult(
      success: true,
      devToken: res['devToken'] is String ? res['devToken'] as String : null,
      expiresAt: res['expiresAt'] is String ? res['expiresAt'] as String : null,
    );
  }

  @override
  Future<void> confirmPasswordReset({
    required String token,
    required String newPassword,
  }) async {
    await client.request(
      'POST',
      '/auth/password/confirm',
      body: <String, Object?>{'token': token, 'newPassword': newPassword},
      includeAuth: false,
    );
  }

  @override
  Future<AuthActionResult> sendEmailVerification({String? email}) async {
    final res = await client.request(
      'POST',
      '/auth/email/verify/request',
      body: <String, Object?>{if (email != null) 'email': email},
    );
    return AuthActionResult(
      success: true,
      devToken: res['devToken'] is String ? res['devToken'] as String : null,
      expiresAt: res['expiresAt'] is String ? res['expiresAt'] as String : null,
    );
  }

  /// Confirms an email-verification token.
  ///
  /// [token] is positional to keep the public surface identical across SDKs.
  /// When the endpoint returns the updated user, [currentUser] is refreshed and
  /// an auth-state transition is emitted.
  @override
  Future<void> confirmEmailVerification(String token) async {
    final res = await client.request(
      'POST',
      '/auth/email/verify/confirm',
      body: <String, Object?>{'token': token},
      includeAuth: false,
    );
    final rawUser = res['user'];
    final current = _currentUser;
    if (rawUser is Map && current != null) {
      final userMap = rawUser.cast<String, Object?>();
      final user = VellumUser.fromJson(<String, Object?>{
        ...current.toJson(),
        ...userMap,
      });
      await _setCurrentUser(user);
    }
  }

  @override
  Future<List<VellumSessionInfo>> listSessions() async {
    final res = await client.request('GET', '/auth/sessions');
    final list = res['sessions'];
    if (list is! List) return const <VellumSessionInfo>[];
    return list
        .whereType<Map<Object?, Object?>>()
        .map((m) => VellumSessionInfo.fromJson(Map<String, Object?>.from(m)))
        .toList(growable: false);
  }

  @override
  Future<void> revokeSession(String sessionId) async {
    await client.request(
        'DELETE', '/auth/sessions/${Uri.encodeComponent(sessionId)}');
  }

  @override
  Future<VellumLinkedProviders> listLinkedProviders() async {
    final res = await client.request('GET', '/auth/identities');
    final list = res['identities'];
    return VellumLinkedProviders(
      providers: list is List
          ? list
              .whereType<Map<Object?, Object?>>()
              .map((m) =>
                  VellumLinkedProvider.fromJson(Map<String, Object?>.from(m)))
              .toList(growable: false)
          : const <VellumLinkedProvider>[],
      hasPassword: res['hasPassword'] == true,
    );
  }

  @override
  Future<void> unlinkProvider(String provider, {String? currentPassword}) async {
    await client.request(
      'DELETE',
      '/auth/identities/${Uri.encodeComponent(provider)}',
      body: <String, Object?>{
        if (currentPassword != null) 'currentPassword': currentPassword,
      },
    );
  }

  @override
  Future<VellumUser> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final expectedEpoch = _sessionEpoch;
    final res = await client.request(
      'POST',
      '/auth/password/change',
      body: <String, Object?>{
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      },
    );
    _requireCurrentEpoch(expectedEpoch);
    final user = VellumUser.fromSession(res);
    _sessionEpoch++;
    await _setCurrentUser(user);
    return user;
  }

  @override
  Future<void> deleteAccount({String? password}) async {
    await client.request(
      'DELETE',
      '/auth/user',
      body: <String, Object?>{if (password != null) 'password': password},
    );
    await signOut();
  }

  /// Patches the authenticated end-user's profile and emits the new state.
  ///
  /// Pass [currentPassword] when changing [email] on an account that has a
  /// password. `password` is not forwarded; use [changePassword] to change it.
  @override
  Future<VellumUser> updateProfile({
    String? email,
    String? displayName,
    String? photoUrl,
    String? phoneNumber,
    bool? phoneVerified,
    JsonMap? metadata,
    JsonMap? customClaims,
    String? password,
    String? currentPassword,
  }) async {
    final expectedEpoch = _sessionEpoch;
    // `password` is deliberately not forwarded: UpdateProfileRequestSchema
    // strips unknown keys, so sending it would invalidate an otherwise valid
    // patch. Use changePassword() to change a password.
    if (password != null && password.isEmpty) {
      throw const VellumException(
        code: 'INVALID_ARGUMENT',
        message: 'password must not be empty',
        statusCode: 400,
      );
    }
    final patch = <String, Object?>{
      if (email != null) 'email': email,
      if (displayName != null) 'displayName': displayName,
      if (photoUrl != null) 'photoUrl': photoUrl,
      if (phoneNumber != null) 'phoneNumber': phoneNumber,
      if (phoneVerified != null) 'phoneVerified': phoneVerified,
      if (metadata != null) 'metadata': metadata,
      if (customClaims != null) 'customClaims': customClaims,
      // Needed when changing the email of an account that has a password.
      if (currentPassword != null) 'currentPassword': currentPassword,
    };
    final res = await client.request('PATCH', '/auth/user', body: patch);
    _requireCurrentEpoch(expectedEpoch);
    final rawUser = res['user'];
    if (rawUser is! Map ||
        rawUser['id'] is! String ||
        (rawUser['id'] as String).trim().isEmpty) {
      throw const VellumException(
          code: 'INVALID_AUTH_RESPONSE',
          message: 'Invalid auth response: missing user.id',
          statusCode: 502);
    }
    final user = VellumUser.fromJson(<String, Object?>{
      ...(_currentUser?.toJson() ?? <String, Object?>{}),
      ...rawUser.cast<String, Object?>(),
    });
    await _setCurrentUser(user);
    return user;
  }

  /// Revokes the current session, or every session when [allSessions] is true,
  /// then clears local auth state and emits `null`.
  ///
  /// A single-session sign-out sends the refresh token and needs no bearer.
  /// `allSessions` deliberately omits it so the server resolves the user from
  /// the bearer token and revokes all of their sessions.
  @override
  Future<void> signOut({bool allSessions = false}) async {
    final refreshToken = allSessions ? null : _currentUser?.refreshToken;
    // Advance epoch immediately so any in-flight refresh cannot resurrect the
    // session while sign-out is executing or after it completes.
    _sessionEpoch++;
    client.clearCache();
    await client.runSignOutHooks();
    client.realtime.dispose();
    _refreshTimer?.cancel();
    _refreshTimer = null;
    _inFlightRefresh = null;
    try {
      await client.request(
        'POST',
        '/auth/sign-out',
        body: <String, Object?>{
          if (refreshToken != null) 'refreshToken': refreshToken,
        },
        includeAuth: allSessions,
      );
    } catch (_) {
      // Local logout must succeed even if the server is unreachable.
    }
    _refreshTimer?.cancel();
    _refreshTimer = null;
    _inFlightRefresh = null;
    await _setCurrentUser(null);
  }

  /// Releases timers and the broadcast stream. Call when disposing the client.
  @override
  void dispose() {
    _disposed = true;
    _sessionEpoch++;
    client.clearCache();
    client.realtime.dispose();
    _refreshTimer?.cancel();
    _refreshTimer = null;
    _inFlightRefresh = null;
    if (!_authController.isClosed) _authController.close();
  }

  @override
  String toString() =>
      'VellumAuth(signedIn: ${_currentUser != null}, userId: ${_currentUser?.id})';
}
