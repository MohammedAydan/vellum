/// Tests for the interactive console's widget tree and helpers.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:vellum_e2e_app/main.dart';

void main() {
  testWidgets('setup screen renders connection fields and output pane',
      (WidgetTester tester) async {
    final AppState state = AppState();
    addTearDown(state.dispose);
    await tester.pumpWidget(MaterialApp(home: SetupScreen(appState: state)));

    expect(find.text('Connection'), findsOneWidget);
    expect(find.text('API base URL'), findsOneWidget);
    expect(find.text('Project ID'), findsOneWidget);
    expect(find.text('API key (pk_ or sk_)'), findsOneWidget);
    expect(find.byType(OutputPane), findsOneWidget);
    expect(find.text('Connect'), findsOneWidget);
  });

  testWidgets('auth, documents, query, realtime and manage screens render',
      (WidgetTester tester) async {
    final AppState state = AppState();
    addTearDown(state.dispose);
    for (final Widget screen in <Widget>[
      AuthScreen(appState: state),
      DocumentsScreen(appState: state),
      QueryScreen(appState: state),
      RealtimeScreen(appState: state),
      ManageScreen(appState: state),
    ]) {
      await tester.pumpWidget(MaterialApp(home: screen));
      expect(find.byType(ListView), findsOneWidget,
          reason: '${screen.runtimeType} did not render');
    }
  });

  test('pretty formats JSON and AppState logs output', () {
    expect(pretty(<String, dynamic>{'a': 1}), contains('"a": 1'));
    final AppState state = AppState();
    state.log('hello');
    expect(state.output, 'hello');
    state.dispose();
  });
}
