import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// OCC transactions — transfer funds between two accounts atomically.
// What you'll build: a debit + credit staged in one `runTransaction`, plus a
// forced conflict and a stale-version precondition.
// Real-world scenario: a payments service reads both balances and commits both
// writes together; a competing write before commit aborts the transaction.
// Note: Dart's `runTransaction` returns the callback result directly (unlike
// the JS SDK, which returns `{ result, commit }`).
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final endpoint = Platform.environment['VELLUM_API_BASE'] ??
      const String.fromEnvironment('VELLUM_API_BASE',
          defaultValue: 'http://127.0.0.1:8080');
  final projectId = Platform.environment['VELLUM_PROJECT_ID'] ??
      const String.fromEnvironment('VELLUM_PROJECT_ID');
  final apiKey = Platform.environment['VELLUM_API_KEY'] ??
      const String.fromEnvironment('VELLUM_API_KEY');

  final client =
      VellumClient(endpoint: endpoint, projectId: projectId, apiKey: apiKey);
  final prefix =
      'ex_flutter_transactions_${DateTime.now().microsecondsSinceEpoch}';
  final col = client.collection(prefix);
  final fromRef = col.doc('account-a');
  final toRef = col.doc('account-b');

  try {
    print('=== OCC Transactions (Flutter) ===');
    await fromRef.set({'owner': 'ada', 'balance': 100});
    await toRef.set({'owner': 'ben', 'balance': 50});

    final transfer = await client.runTransaction((tx) async {
      final from = await tx.get(fromRef);
      final to = await tx.get(toRef);
      final fromBefore = (from.data()?['balance'] as num).toInt();
      final toBefore = (to.data()?['balance'] as num).toInt();
      const amount = 50;
      final fromAfter = fromBefore - amount;
      final toAfter = toBefore + amount;
      tx.update(fromRef, {'balance': fromAfter});
      tx.update(toRef, {'balance': toAfter});
      return {
        'amount': amount,
        'fromBefore': fromBefore,
        'toBefore': toBefore,
        'fromAfter': fromAfter,
        'toAfter': toAfter
      };
    });
    print('transfer=$transfer');

    final finalFrom = await fromRef.get();
    final finalTo = await toRef.get();
    print(
        'fromBalance=${finalFrom.data()?['balance']} toBalance=${finalTo.data()?['balance']}');

    // Forced conflict: change a read doc before committing a held transaction.
    final begin = await client.request('POST', '/transactions:begin', body: {});
    final token = begin['transactionToken'] as String;
    final held = await client.request(
      'GET',
      '/documents/${fromRef.path}?transactionToken=${Uri.encodeQueryComponent(token)}',
    );
    final heldVersion = held['version'];
    await fromRef.update({'balance': 51});
    try {
      await client.request('POST', '/transactions:commit', body: {
        'transactionToken': token,
        'writes': [
          {
            'type': 'update',
            'path': fromRef.path,
            'data': {'balance': 200},
            'ifVersion': heldVersion
          },
        ],
      });
    } on VellumException catch (e) {
      print('forced conflict: code=${e.code} status=${e.statusCode}');
    }

    try {
      await fromRef.update({'balance': 300}, ifVersion: 1);
    } on VellumException catch (e) {
      print('stale precondition: code=${e.code} status=${e.statusCode}');
    }
  } finally {
    for (final ref in [fromRef, toRef]) {
      try {
        await ref.delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
