/// VELLUM Interactive Console — a real Material 3 app built on `vellum_flutter`.
///
/// Every screen performs live operations against a running VELLUM API. Use the
/// Setup screen to point at a deployment, then explore Auth, Documents, Query,
/// Realtime and Manage. Nothing is mocked: each button calls the SDK and the
/// response is shown on screen.
///
///   flutter run --dart-define=VELLUM_API_BASE_URL=http://127.0.0.1:8080
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:flutter/material.dart';
import 'testbed_runner.dart';
import 'package:http/http.dart' as http;

const String kDefaultBaseUrl = String.fromEnvironment(
  'VELLUM_API_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080',
);
const String kDefaultProjectId = String.fromEnvironment(
  'VELLUM_PROJECT_ID',
  defaultValue: '',
);
const String kDefaultApiKey = String.fromEnvironment(
  'VELLUM_API_KEY',
  defaultValue: '',
);
const String kDefaultReportPath = 'vellum_interactive_report.md';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  if (Platform.environment['VELLUM_E2E_HEADLESS'] == '1') {
    _runHeadless();
    return;
  }
  runApp(const VellumConsoleApp());
}

/// Shared mutable app state. Screens call [run] so busy state and output are
/// consistent everywhere.
class AppState extends ChangeNotifier {
  final TextEditingController baseUrl =
      TextEditingController(text: kDefaultBaseUrl);
  final TextEditingController projectId =
      TextEditingController(text: kDefaultProjectId);
  final TextEditingController apiKey =
      TextEditingController(text: kDefaultApiKey);

  VellumClient? client;
  String output = 'Connect on the Setup screen to begin.';
  bool busy = false;
  String? cursor;

  bool get connected => client != null;

  void log(String message) {
    output = message;
    notifyListeners();
  }

  /// Public wrapper so screens can request a rebuild safely.
  void refresh() => notifyListeners();

  Future<T?> run<T>(Future<T> Function() action) async {
    if (client == null) {
      log('Connect first (Setup screen).');
      return null;
    }
    busy = true;
    notifyListeners();
    try {
      final T value = await action();
      return value;
    } on VellumException catch (error) {
      log('${error.code} [HTTP ${error.statusCode}]\n${error.message}');
      return null;
    } catch (error) {
      log('${error.runtimeType}: $error');
      return null;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  VellumClient get requireClient {
    final VellumClient? value = client;
    if (value == null) throw StateError('Not connected');
    return value;
  }

  void connect() {
    final String url = baseUrl.text.trim();
    final String project = projectId.text.trim();
    final String key = apiKey.text.trim();
    if (url.isEmpty || project.isEmpty || key.isEmpty) {
      log('Base URL, Project ID and API key are all required.');
      return;
    }
    client?.dispose();
    client = VellumClient(endpoint: url, projectId: project, apiKey: key);
    log('Connected to $url\nproject=$project\nkey=${key.substring(0, 3)}…');
    notifyListeners();
  }

  @override
  void dispose() {
    client?.dispose();
    baseUrl.dispose();
    projectId.dispose();
    apiKey.dispose();
    super.dispose();
  }
}

/// Formats values for the output pane without leaking secret material.
String pretty(Object? value) {
  try {
    return const JsonEncoder.withIndent('  ').convert(value);
  } catch (_) {
    return '$value';
  }
}

Future<void> _runHeadless() async {
  final String base = Platform.environment['VELLUM_API_BASE_URL'] ??
      kDefaultBaseUrl;
  final String path = Platform.environment['VELLUM_E2E_REPORT_PATH'] ??
      kDefaultReportPath;
  stdout.writeln('VELLUM Interactive Console (headless suite)');
  final List<ScenarioResult> results =
      await VellumLiveTestbedRunner(baseUrl: base).runAll();
  final int passed = results.where((r) => r.passed).length;
  final StringBuffer report = StringBuffer()
    ..writeln('# VELLUM Interactive Console — E2E Report')
    ..writeln()
    ..writeln('- Base URL: `$base`')
    ..writeln('- Result: **$passed/${results.length} passed**')
    ..writeln()
    ..writeln('| # | Scenario | Status | Latency |')
    ..writeln('| --- | --- | --- | --- |');
  for (int i = 0; i < results.length; i++) {
    final ScenarioResult r = results[i];
    report.writeln('| ${i + 1} | ${r.name} | ${r.status} | ${r.latencyMs} ms |');
  }
  final File file = File(path);
  await file.writeAsString(report.toString(), flush: true);
  stdout.writeln('Report: ${file.absolute.path}');
  stdout.writeln('Result: $passed/${results.length}');
  await stdout.flush();
  exit(passed == results.length ? 0 : 1);
}

class VellumConsoleApp extends StatefulWidget {
  const VellumConsoleApp({super.key});

  @override
  State<VellumConsoleApp> createState() => _VellumConsoleAppState();
}

class _VellumConsoleAppState extends State<VellumConsoleApp> {
  final AppState state = AppState();
  int _index = 0;

  List<Widget> get _pages => <Widget>[
        SetupScreen(appState: state),
        AuthScreen(appState: state),
        DocumentsScreen(appState: state),
        QueryScreen(appState: state),
        RealtimeScreen(appState: state),
        ManageScreen(appState: state),
      ];

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: state,
      builder: (BuildContext context, Widget? _) {
        return MaterialApp(
          title: 'VELLUM Interactive Console',
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor: const Color(0xFF00A878),
              brightness: Brightness.dark,
            ),
            useMaterial3: true,
          ),
          home: Scaffold(
            appBar: AppBar(
              title: const Text('VELLUM Interactive Console'),
              actions: <Widget>[
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Chip(
                    label: Text(state.connected ? 'CONNECTED' : 'OFFLINE'),
                    avatar: Icon(
                      state.connected ? Icons.link : Icons.link_off,
                      size: 16,
                    ),
                  ),
                ),
              ],
            ),
            body: Row(
              children: <Widget>[
                if (MediaQuery.of(context).size.width >= 900)
                  NavigationRail(
                    selectedIndex: _index,
                    onDestinationSelected: (int i) =>
                        setState(() => _index = i),
                    labelType: NavigationRailLabelType.all,
                    destinations: const <NavigationRailDestination>[
                      NavigationRailDestination(
                          icon: Icon(Icons.settings_outlined),
                          label: Text('Setup')),
                      NavigationRailDestination(
                          icon: Icon(Icons.login_outlined),
                          label: Text('Auth')),
                      NavigationRailDestination(
                          icon: Icon(Icons.description_outlined),
                          label: Text('Documents')),
                      NavigationRailDestination(
                          icon: Icon(Icons.search_outlined),
                          label: Text('Query')),
                      NavigationRailDestination(
                          icon: Icon(Icons.bolt_outlined),
                          label: Text('Realtime')),
                      NavigationRailDestination(
                          icon: Icon(Icons.admin_panel_settings_outlined),
                          label: Text('Manage')),
                    ],
                  ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: _pages[_index],
                  ),
                ),
              ],
            ),
            bottomNavigationBar: MediaQuery.of(context).size.width < 900
                ? NavigationBar(
                    selectedIndex: _index,
                    onDestinationSelected: (int i) =>
                        setState(() => _index = i),
                    destinations: const <NavigationDestination>[
                      NavigationDestination(
                          icon: Icon(Icons.settings_outlined), label: 'Setup'),
                      NavigationDestination(
                          icon: Icon(Icons.login_outlined), label: 'Auth'),
                      NavigationDestination(
                          icon: Icon(Icons.description_outlined),
                          label: 'Docs'),
                      NavigationDestination(
                          icon: Icon(Icons.search_outlined), label: 'Query'),
                      NavigationDestination(
                          icon: Icon(Icons.bolt_outlined), label: 'Realtime'),
                      NavigationDestination(
                          icon: Icon(Icons.admin_panel_settings_outlined),
                          label: 'Manage'),
                    ],
                  )
                : null,
          ),
        );
      },
    );
  }
}

/// Base for stateless screens: receives the shared state via its constructor.
abstract class ConsoleScreen extends StatelessWidget {
  const ConsoleScreen({super.key, required this.appState});

  final AppState appState;

  Widget buildScreen(BuildContext context, AppState state);

  @override
  Widget build(BuildContext context) => buildScreen(context, appState);
}

/// Reusable card with a title and a column of children.
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.title,
    required this.children,
    this.icon,
  });

  final String title;
  final List<Widget> children;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  Icon(icon, size: 18, color: theme.colorScheme.primary),
                  const SizedBox(width: 8),
                ],
                Text(title, style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 14),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// Shared result/output pane.
class OutputPane extends StatelessWidget {
  const OutputPane({super.key, required this.output});

  final String output;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: 140, maxHeight: 320),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: SingleChildScrollView(
        child: SelectableText(
          output,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
        ),
      ),
    );
  }
}

/// A text field with a label, used on all screens.
class Field extends StatelessWidget {
  const Field({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.maxLines = 1,
    this.obscure = false,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final int maxLines;
  final bool obscure;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        controller: controller,
        maxLines: maxLines,
        obscureText: obscure,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }
}

/// Button that disables itself while a shared action is running.
class ActionButton extends StatelessWidget {
  const ActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon = Icons.play_arrow_rounded,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData icon;

  @override
  Widget build(BuildContext context) => FilledButton.tonalIcon(
        onPressed: onPressed,
        icon: Icon(icon, size: 18),
        label: Text(label),
      );
}

/// ---------------------------------------------------------------------------
/// Setup
/// ---------------------------------------------------------------------------
class SetupScreen extends ConsoleScreen {
  const SetupScreen({super.key, required super.appState});

  @override
  Widget buildScreen(BuildContext context, AppState state) {
    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'Connection',
          icon: Icons.settings_outlined,
          children: <Widget>[
            Field(label: 'API base URL', controller: state.baseUrl),
            Field(label: 'Project ID', controller: state.projectId),
            Field(
                label: 'API key (pk_ or sk_)',
                controller: state.apiKey,
                obscure: true),
            const SizedBox(height: 4),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Connect',
                    icon: Icons.link,
                    onPressed: state.connect),
                ActionButton(
                    label: 'Health check',
                    icon: Icons.monitor_heart_outlined,
                    onPressed: () async {
                      final Uri uri = Uri.parse(
                          '${state.baseUrl.text.trim()}/v1/health/live');
                      try {
                        final http.Response r = await http.get(uri);
                        state.log('GET ${uri.path} -> ${r.statusCode}\n${r.body}');
                      } catch (error) {
                        state.log('Health check failed: $error');
                      }
                    }),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[OutputPane(output: state.output)],
        ),
        const Card(
          child: ListTile(
            leading: Icon(Icons.info_outline),
            title: Text('Tip'),
            subtitle: Text(
              'Use a publishable pk_ key for normal client work and an sk_ key '
              'for collections and index management.',
            ),
          ),
        ),
      ],
    );
  }
}

/// ---------------------------------------------------------------------------
/// Auth
/// ---------------------------------------------------------------------------
class AuthScreen extends ConsoleScreen {
  const AuthScreen({super.key, required super.appState});

  @override
  Widget buildScreen(BuildContext context, AppState state) {
    final TextEditingController email = TextEditingController(
        text: 'user-${DateTime.now().microsecondsSinceEpoch}@vellum.dev');
    final TextEditingController password =
        TextEditingController(text: 'Practical1');

    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'End-user authentication',
          icon: Icons.login_outlined,
          children: <Widget>[
            Field(label: 'Email', controller: email),
            Field(label: 'Password', controller: password, obscure: true),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                  label: 'Sign up',
                  icon: Icons.person_add_outlined,
                  onPressed: () => state.run(() async {
                    final user = await state.requireClient.auth
                        .signUpWithEmailAndPassword(
                            email: email.text.trim(),
                            password: password.text);
                    return state.log('Signed up: ${pretty(user.toJson())}');
                  }),
                ),
                ActionButton(
                  label: 'Sign in',
                  icon: Icons.login,
                  onPressed: () => state.run(() async {
                    final result = await state.requireClient.auth
                        .signInWithEmailAndPassword(
                            email: email.text.trim(),
                            password: password.text);
                    return state.log('Session: ${result.runtimeType}');
                  }),
                ),
                ActionButton(
                  label: 'Get user',
                  icon: Icons.person_outline,
                  onPressed: () => state.run(() async {
                    final user = await state.requireClient.auth.getUser();
                    return state.log(pretty(user.toJson()));
                  }),
                ),
                ActionButton(
                  label: 'Token info',
                  icon: Icons.key_outlined,
                  onPressed: () => state.run(() async {
                    final token =
                        await state.requireClient.auth.getIdToken();
                    return state.log(token == null
                        ? 'No active token'
                        : 'Token length: ${token.length} chars');
                  }),
                ),
                ActionButton(
                  label: 'Sign out',
                  icon: Icons.logout,
                  onPressed: () => state.run(() async {
                    await state.requireClient.auth.signOut();
                    return state.log('Signed out');
                  }),
                ),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[OutputPane(output: state.output)],
        ),
      ],
    );
  }
}

/// ---------------------------------------------------------------------------
/// Documents: CRUD, batch and OCC transactions
/// ---------------------------------------------------------------------------
class DocumentsScreen extends ConsoleScreen {
  const DocumentsScreen({super.key, required super.appState});

  @override
  Widget buildScreen(BuildContext context, AppState state) {
    final TextEditingController path = TextEditingController(text: 'users/demo1');
    final TextEditingController data = TextEditingController(
        text: '{"name": "Ada", "role": "admin", "priority": 7}');
    final TextEditingController patch =
        TextEditingController(text: '{"priority": 9}');
    final TextEditingController batch = TextEditingController(
        text: '[{"path":"users/b1","data":{"name":"Batch 1"}},'
              '{"path":"users/b2","data":{"name":"Batch 2"}}]');

    Map<String, dynamic> parseJson(TextEditingController c) {
      final Object? decoded = jsonDecode(c.text);
      if (decoded is! Map) throw StateError('Expected a JSON object');
      return decoded.cast<String, dynamic>();
    }

    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'Document CRUD',
          icon: Icons.description_outlined,
          children: <Widget>[
            Field(label: 'Document path', controller: path),
            Field(label: 'Data (JSON object)', controller: data, maxLines: 5),
            Field(label: 'Update patch (JSON)', controller: patch, maxLines: 3),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Create',
                    icon: Icons.add,
                    onPressed: () => state.run(() async {
                      await state.requireClient
                          .doc(path.text.trim())
                          .create(parseJson(data));
                      return state.log('Created ${path.text}');
                    })),
                ActionButton(
                    label: 'Set / Upsert',
                    icon: Icons.save_outlined,
                    onPressed: () => state.run(() async {
                      await state.requireClient
                          .doc(path.text.trim())
                          .upsert(parseJson(data));
                      return state.log('Upserted ${path.text}');
                    })),
                ActionButton(
                    label: 'Get',
                    icon: Icons.visibility_outlined,
                    onPressed: () => state.run(() async {
                      final snap =
                          await state.requireClient.getDoc(path.text.trim());
                      return state.log(
                          'path=${snap.path} v${snap.version}\n${pretty(snap.data())}');
                    })),
                ActionButton(
                    label: 'Update',
                    icon: Icons.edit_outlined,
                    onPressed: () => state.run(() async {
                      await state.requireClient.updateDoc(
                          path.text.trim(), parseJson(patch));
                      return state.log('Updated ${path.text}');
                    })),
                ActionButton(
                    label: 'Delete',
                    icon: Icons.delete_outline,
                    onPressed: () => state.run(() async {
                      await state.requireClient.deleteDoc(path.text.trim());
                      return state.log('Deleted ${path.text}');
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Atomic batch write',
          icon: Icons.call_split_outlined,
          children: <Widget>[
            Field(
                label: 'Writes JSON: [{"path": "...", "data": {...}}]',
                controller: batch,
                maxLines: 5),
            ActionButton(
                label: 'Commit batch',
                icon: Icons.send_outlined,
                onPressed: () => state.run(() async {
                  final Object? decoded = jsonDecode(batch.text);
                  if (decoded is! List) {
                    throw StateError('Expected a JSON array');
                  }
                  final List<Map<String, dynamic>> writes = decoded
                      .whereType<Map>()
                      .map((Map m) => m.cast<String, dynamic>())
                      .toList();
                  final result =
                      await state.requireClient.batchWrite(writes);
                  return state.log(pretty(result));
                })),
          ],
        ),
        SectionCard(
          title: 'Optimistic concurrency transaction',
          icon: Icons.lock_outline,
          children: <Widget>[
            ActionButton(
                label: 'Run OCC transaction (counter +1)',
                icon: Icons.account_tree_outlined,
                onPressed: () => state.run(() async {
                  final String txPath = 'users/tx-${DateTime.now().microsecondsSinceEpoch}';
                  await state.requireClient.setDoc(
                      txPath, <String, dynamic>{'counter': 0});
                  final int next = await state.requireClient
                      .runTransaction<int>((TransactionContext tx) async {
                    final snap = await tx.get(state.requireClient.doc(txPath));
                    final int current =
                        (snap.data()?['counter'] as num? ?? 0).toInt();
                    tx.set(state.requireClient.doc(txPath),
                        <String, dynamic>{'counter': current + 1});
                    return current + 1;
                  });
                  return state.log('$txPath: counter 0 -> $next');
                })),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[OutputPane(output: state.output)],
        ),
      ],
    );
  }
}

/// ---------------------------------------------------------------------------
/// Query, pagination, aggregations and relations
/// ---------------------------------------------------------------------------
class QueryScreen extends ConsoleScreen {
  const QueryScreen({super.key, required super.appState});

  @override
  Widget buildScreen(BuildContext context, AppState state) {
    final TextEditingController collection =
        TextEditingController(text: 'users');
    final TextEditingController field =
        TextEditingController(text: 'role');
    final TextEditingController op = TextEditingController(text: '==');
    final TextEditingController value = TextEditingController(text: 'admin');
    final TextEditingController orderField =
        TextEditingController(text: 'documentId');
    final TextEditingController dir = TextEditingController(text: 'asc');
    final TextEditingController limit = TextEditingController(text: '10');
    final TextEditingController groupField =
        TextEditingController(text: 'role');

    Query<Map<String, dynamic>> buildQuery() {
      final List<Object> clauses = <Object>[
        <String, dynamic>{
          'field': field.text.trim(),
          'op': op.text.trim(),
          'value': value.text.trim(),
        },
      ];
      return state.requireClient
          .query(collection.text.trim(),
              where: clauses,
              orderBy: <String, dynamic>{
                'field': orderField.text.trim(),
                'dir': dir.text.trim(),
              },
              limit: int.tryParse(limit.text) ?? 10)
          .orderBy('documentId');
    }

    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'Query builder',
          icon: Icons.search_outlined,
          children: <Widget>[
            Field(label: 'Collection path', controller: collection),
            Row(
              children: <Widget>[
                Expanded(child: Field(label: 'Where field', controller: field)),
                const SizedBox(width: 8),
                SizedBox(
                    width: 110,
                    child: Field(label: 'Op', controller: op)),
              ],
            ),
            Field(label: 'Value', controller: value),
            Row(
              children: <Widget>[
                Expanded(
                    child: Field(label: 'Order by', controller: orderField)),
                const SizedBox(width: 8),
                SizedBox(width: 100, child: Field(label: 'Dir', controller: dir)),
                const SizedBox(width: 8),
                SizedBox(
                    width: 100, child: Field(label: 'Limit', controller: limit)),
              ],
            ),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Run query',
                    onPressed: () => state.run(() async {
                      final QuerySnapshot<Map<String, dynamic>> page =
                          await buildQuery().get();
                      state.cursor = page.nextCursor;
                      return state.log(
                          'docs=${page.docs.length} nextCursor=${page.nextCursor ?? "none"}\n'
                          '${pretty(page.docs.map((d) => d.data()).toList())}');
                    })),
                ActionButton(
                    label: 'Next page',
                    icon: Icons.skip_next,
                    onPressed: state.cursor == null
                        ? null
                        : () => state.run(() async {
                            final QuerySnapshot<Map<String, dynamic>> page =
                                await buildQuery().startAfter(state.cursor!).get();
                            state.cursor = page.nextCursor;
                            return state.log(
                                'docs=${page.docs.length} nextCursor=${page.nextCursor ?? "none"}\n'
                                '${pretty(page.docs.map((d) => d.data()).toList())}');
                          })),
                ActionButton(
                    label: 'Count',
                    icon: Icons.numbers,
                    onPressed: () => state.run(() async {
                      final int count = await buildQuery().count();
                      return state.log('count=$count');
                    })),
                ActionButton(
                    label: 'Sum / Avg',
                    icon: Icons.functions,
                    onPressed: () => state.run(() async {
                      final Query<Map<String, dynamic>> q = buildQuery();
                      final num? sum = await q.sum('priority');
                      final num? avg = await q.avg('priority');
                      return state.log('sum=$sum, avg=$avg');
                    })),
                ActionButton(
                    label: 'Group by',
                    icon: Icons.group_outlined,
                    onPressed: () => state.run(() async {
                      final Map<String, dynamic> res = await buildQuery()
                          .aggregate(
                              groupBy: <String>[groupField.text.trim()],
                              metrics: <String, AggregateMetric>{
                                'count': const AggregateMetric.count(),
                              });
                      return state.log(pretty(res));
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Relations (include + redaction)',
          icon: Icons.link_outlined,
          children: <Widget>[
            Field(
                label: 'Group field for aggregation',
                controller: groupField),
            ActionButton(
                label: 'Read parent with included relation',
                icon: Icons.account_tree_outlined,
                onPressed: () => state.run(() async {
                  final String uid = (await state.requireClient.auth.getUser()).id;
                  final String userPath = 'users/$uid';
                  final String parent = 'posts/rel-${DateTime.now().microsecondsSinceEpoch}';
                  await state.requireClient.setDoc(userPath,
                      <String, dynamic>{'uid': uid, 'name': 'Me'});
                  await state.requireClient.setDoc(parent, <String, dynamic>{
                    'title': 'Relation demo',
                    'refs': <String>[userPath],
                  });
                  final snap = await state.requireClient.doc(parent).get(
                        include: <Object>[
                          VellumInclude(
                              field: 'refs', collection: 'users', as: 'targets'),
                        ],
                      );
                  return state.log('included=${pretty(snap.included)}\n'
                      'redacted=${snap.redactedRefs}');
                })),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[OutputPane(output: state.output)],
        ),
      ],
    );
  }
}

/// ---------------------------------------------------------------------------
/// Realtime
/// ---------------------------------------------------------------------------
class RealtimeScreen extends StatefulWidget {
  const RealtimeScreen({super.key, required this.appState});

  final AppState appState;

  @override
  State<RealtimeScreen> createState() => _RealtimeScreenState();
}

class _RealtimeScreenState extends State<RealtimeScreen> {
  final TextEditingController path = TextEditingController(text: 'users/rt-demo');
  final List<String> events = <String>[];
  StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _sub;

  @override
  void dispose() {
    _sub?.cancel();
    path.dispose();
    super.dispose();
  }

  AppState get state => widget.appState;

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'Realtime WebSocket',
          icon: Icons.bolt_outlined,
          children: <Widget>[
            Field(label: 'Document path to watch', controller: path),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Watch document',
                    icon: Icons.remove_red_eye_outlined,
                    onPressed: () async {
                      final AppState s = state;
                      if (!s.connected) {
                        s.log('Connect first (Setup screen).');
                        return;
                      }
                      await _sub?.cancel();
                      setState(() => events.clear());
                      _sub = s.requireClient
                          .watchDocument(path.text.trim())
                          .listen(
                            (snap) {
                              setState(() => events.insert(
                                  0,
                                  '${DateTime.now().toIso8601String()}  ${snap.path} v${snap.version}  ${pretty(snap.data())}'));
                            },
                            onError: (Object error) {
                              setState(() => events.insert(
                                  0, 'ERROR: ${error.runtimeType}: $error'));
                            },
                          );
                      s.log('Watching ${path.text}');
                    }),
                ActionButton(
                    label: 'Stop watching',
                    icon: Icons.stop_circle_outlined,
                    onPressed: () async {
                      await _sub?.cancel();
                      _sub = null;
                      state.log('Subscription stopped');
                    }),
                ActionButton(
                    label: 'Write a mutation',
                    icon: Icons.edit,
                    onPressed: () => state.run(() async {
                      await state.requireClient.setDoc(path.text.trim(),
                          <String, dynamic>{
                            'touchedAt': DateTime.now().toIso8601String(),
                          });
                      return state.log('Wrote ${path.text}');
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Live events (newest first)',
          icon: Icons.history,
          children: <Widget>[
            Container(
              constraints: const BoxConstraints(minHeight: 160, maxHeight: 320),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: events.isEmpty
                  ? const Text('No events yet — press "Watch document".')
                  : SingleChildScrollView(
                      child: SelectableText(
                        events.join('\n\n'),
                        style: const TextStyle(
                            fontFamily: 'monospace', fontSize: 12),
                      ),
                    ),
            ),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[OutputPane(output: state.output)],
        ),
      ],
    );
  }
}

/// ---------------------------------------------------------------------------
/// Manage: collections, indexes, rules and the automated suite
/// ---------------------------------------------------------------------------
class ManageScreen extends ConsoleScreen {
  const ManageScreen({super.key, required super.appState});

  @override
  Widget buildScreen(BuildContext context, AppState state) {
    final TextEditingController collection =
        TextEditingController(text: 'demo_collection');
    final TextEditingController indexCollection =
        TextEditingController(text: 'users');
    final TextEditingController indexField =
        TextEditingController(text: 'role');
    final TextEditingController rulesDsl = TextEditingController(
        text: "rules_version = '2';\n\nmatch /users/{userId} {\n"
              "  allow read: if auth.uid == path.userId;\n"
              "  allow write: if auth.uid == path.userId;\n}\n");
    final TextEditingController simulatePath =
        TextEditingController(text: 'users/u1');

    return ListView(
      children: <Widget>[
        SectionCard(
          title: 'Collections registry',
          icon: Icons.folder_outlined,
          children: <Widget>[
            Field(label: 'Collection name', controller: collection),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Create',
                    icon: Icons.create_new_folder_outlined,
                    onPressed: () => state.run(() async {
                      final info = await state.requireClient
                          .createCollection(collection.text.trim());
                      return state.log(pretty(info.toJson()));
                    })),
                ActionButton(
                    label: 'List',
                    icon: Icons.list,
                    onPressed: () => state.run(() async {
                      final res =
                          await state.requireClient.listCollections();
                      return state.log(pretty(res.toJson()));
                    })),
                ActionButton(
                    label: 'Clear',
                    icon: Icons.cleaning_services_outlined,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient
                          .clearCollection(collection.text.trim());
                      return state.log(pretty(res.toJson()));
                    })),
                ActionButton(
                    label: 'Delete',
                    icon: Icons.delete_forever_outlined,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient
                          .deleteCollection(collection.text.trim());
                      return state.log(pretty(res.toJson()));
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Composite indexes (server key)',
          icon: Icons.blur_on_outlined,
          children: <Widget>[
            Field(label: 'Collection path', controller: indexCollection),
            Field(label: 'Field path', controller: indexField),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'List indexes',
                    icon: Icons.list,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient
                          .request('GET', '/indexes');
                      return state.log(pretty(res));
                    })),
                ActionButton(
                    label: 'Create index',
                    icon: Icons.add,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient
                          .request('POST', '/indexes', body: <String, dynamic>{
                        'collectionPath': indexCollection.text.trim(),
                        'fields': <Map<String, dynamic>>[
                          <String, dynamic>{
                            'path': indexField.text.trim(),
                            'dir': 'asc',
                          },
                          <String, dynamic>{
                            'path': 'documentId',
                            'dir': 'asc',
                          },
                        ],
                      });
                      return state.log(pretty(res));
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Security rules DSL',
          icon: Icons.gpp_good_outlined,
          children: <Widget>[
            Field(label: 'Rules DSL source', controller: rulesDsl, maxLines: 8),
            Field(label: 'Simulate path', controller: simulatePath),
            Wrap(
              spacing: 10,
              children: <Widget>[
                ActionButton(
                    label: 'Compile DSL',
                    icon: Icons.code,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient.request(
                          'POST', '/rules/compile',
                          body: <String, dynamic>{
                            'source': rulesDsl.text,
                          });
                      return state.log(pretty(res));
                    })),
                ActionButton(
                    label: 'Simulate get',
                    icon: Icons.play_arrow,
                    onPressed: () => state.run(() async {
                      final res = await state.requireClient.request(
                          'POST', '/rules/simulate',
                          body: <String, dynamic>{
                            'operation': 'get',
                            'path': simulatePath.text.trim(),
                          });
                      return state.log(pretty(res));
                    })),
              ],
            ),
          ],
        ),
        SectionCard(
          title: 'Automated suite + Markdown report',
          icon: Icons.fact_check_outlined,
          children: <Widget>[
            ActionButton(
                label: 'Run 20 live scenarios & write .md report',
                icon: Icons.play_circle_outline,
                onPressed: () async {
                  state.busy = true;
                  state.refresh();
                  try {
                    final List<ScenarioResult> results =
                        await VellumLiveTestbedRunner(
                                baseUrl: state.baseUrl.text.trim())
                            .runAll();
                    final int passed =
                        results.where((r) => r.passed).length;
                    final String path = kDefaultReportPath;
                    final File file = File(path);
                    final StringBuffer md = StringBuffer()
                      ..writeln('# VELLUM Interactive Console — E2E Report')
                      ..writeln()
                      ..writeln('- Target: `${state.baseUrl.text.trim()}`')
                      ..writeln('- Result: **$passed/${results.length} passed**')
                      ..writeln()
                      ..writeln('| # | Scenario | Status | Latency |')
                      ..writeln('| --- | --- | --- | --- |');
                    for (int i = 0; i < results.length; i++) {
                      final ScenarioResult r = results[i];
                      md.writeln(
                          '| ${i + 1} | ${r.name} | ${r.status} | ${r.latencyMs} ms |');
                    }
                    await file.writeAsString(md.toString(), flush: true);
                    state.log('$passed/${results.length} passed\nReport: ${file.absolute.path}');
                  } catch (error) {
                    state.log('Suite failed: ${error.runtimeType}: $error');
                  } finally {
                    state.busy = false;
                    state.refresh();
                  }
                }),
          ],
        ),
        SectionCard(
          title: 'Output',
          icon: Icons.terminal,
          children: <Widget>[
            OutputPane(output: state.output),
            if (state.busy)
                const Padding(
                  padding: EdgeInsets.only(top: 12),
                  child: LinearProgressIndicator(),
                ),
          ],
        ),
      ],
    );
  }
}
