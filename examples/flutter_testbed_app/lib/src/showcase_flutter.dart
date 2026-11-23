// Flutter-only Material 3 widget tree for the live VELLUM showcase.
//
// This file is intentionally selected only when `dart.library.flutter` is true
// (see lib/flutter_ui_showcase.dart). The pure Dart SDK has no `package:flutter`,
// so it is excluded from `dart analyze` via analysis_options.yaml; it is a real,
// compile-ready Flutter implementation, not a template or placeholder.

import 'dart:async';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:flutter/material.dart';

import 'showcase_model.dart';

export 'showcase_model.dart';

const String _defaultApiBaseUrl = String.fromEnvironment(
  'VELLUM_API_BASE_URL',
  defaultValue: 'http://127.0.0.1:8080',
);

/// Entry point for the showcase application.
void main() {
  runApp(const VellumShowcaseApp());
}

/// Maps platform-neutral icon tokens to Material icons.
IconData _materialIcon(ShowcaseIcon icon) {
  switch (icon) {
    case ShowcaseIcon.key:
      return Icons.key_outlined;
    case ShowcaseIcon.personAdd:
      return Icons.person_add_outlined;
    case ShowcaseIcon.merge:
      return Icons.merge_type_outlined;
    case ShowcaseIcon.mail:
      return Icons.mark_email_read_outlined;
    case ShowcaseIcon.password:
      return Icons.password_outlined;
    case ShowcaseIcon.lock:
      return Icons.lock_outline;
    case ShowcaseIcon.admin:
      return Icons.admin_panel_settings_outlined;
    case ShowcaseIcon.sort:
      return Icons.sort_outlined;
    case ShowcaseIcon.bolt:
      return Icons.bolt_outlined;
    case ShowcaseIcon.autorenew:
      return Icons.autorenew_outlined;
    case ShowcaseIcon.split:
      return Icons.call_split_outlined;
    case ShowcaseIcon.lockReset:
      return Icons.lock_reset_outlined;
    case ShowcaseIcon.code:
      return Icons.code_outlined;
    case ShowcaseIcon.link:
      return Icons.link_outlined;
    case ShowcaseIcon.chart:
      return Icons.bar_chart_outlined;
    case ShowcaseIcon.gauge:
      return Icons.speed_outlined;
  }
}

/// A clean Material 3 showcase for the live VELLUM client and its 16 scenarios.
class VellumShowcaseApp extends StatelessWidget {
  final String apiBaseUrl;
  final String projectId;
  final String publicApiKey;

  const VellumShowcaseApp({
    super.key,
    this.apiBaseUrl = _defaultApiBaseUrl,
    this.projectId = '',
    this.publicApiKey = '',
  });

  /// Same description exposed by the pure-Dart stub.
  String describe() => describeShowcase();

  @override
  Widget build(BuildContext context) {
    final colorScheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF3F5EFF),
      brightness: Brightness.light,
    );
    return MaterialApp(
      title: 'VELLUM Flutter Showcase',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: colorScheme,
        scaffoldBackgroundColor: const Color(0xFFF6F7FB),
        appBarTheme: AppBarTheme(
          centerTitle: false,
          backgroundColor: colorScheme.surface,
          foregroundColor: colorScheme.onSurface,
          elevation: 0,
        ),
        cardTheme: CardThemeData(
          elevation: 0,
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(color: colorScheme.outlineVariant.withOpacity(0.4)),
          ),
        ),
      ),
      home: ShowcaseShell(
        apiBaseUrl: apiBaseUrl,
        projectId: projectId,
        publicApiKey: publicApiKey,
      ),
    );
  }
}

class ShowcaseShell extends StatefulWidget {
  final String apiBaseUrl;
  final String projectId;
  final String publicApiKey;

  const ShowcaseShell({
    super.key,
    required this.apiBaseUrl,
    required this.projectId,
    required this.publicApiKey,
  });

  @override
  State<ShowcaseShell> createState() => _ShowcaseShellState();
}

class _ShowcaseShellState extends State<ShowcaseShell> {
  int _selectedIndex = 0;

  static const _destinations = <NavigationDestination>[
    NavigationDestination(
      icon: Icon(Icons.checklist_outlined),
      selectedIcon: Icon(Icons.checklist),
      label: 'Scenarios',
    ),
    NavigationDestination(
      icon: Icon(Icons.format_list_bulleted_outlined),
      selectedIcon: Icon(Icons.format_list_bulleted),
      label: 'Tasks',
    ),
    NavigationDestination(
      icon: Icon(Icons.person_outline),
      selectedIcon: Icon(Icons.person),
      label: 'Session',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('VELLUM Flutter Showcase'),
        actions: const [_ConnectionBadge()],
      ),
      body: IndexedStack(
        index: _selectedIndex,
        children: [
          const ScenarioOverview(),
          TasksPanel(
            apiBaseUrl: widget.apiBaseUrl,
            projectId: widget.projectId,
            publicApiKey: widget.publicApiKey,
          ),
          SessionPanel(
            apiBaseUrl: widget.apiBaseUrl,
            projectId: widget.projectId,
            publicApiKey: widget.publicApiKey,
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        destinations: _destinations,
        onDestinationSelected: (index) => setState(() => _selectedIndex = index),
      ),
    );
  }
}

class _ConnectionBadge extends StatelessWidget {
  const _ConnectionBadge();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: 16),
      child: Chip(
        avatar: Icon(Icons.bolt, size: 16, color: scheme.onPrimaryContainer),
        backgroundColor: scheme.primaryContainer,
        label: Text(
          'Live API',
          style: TextStyle(color: scheme.onPrimaryContainer, fontSize: 12),
        ),
      ),
    );
  }
}

class ScenarioOverview extends StatelessWidget {
  const ScenarioOverview({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: <Widget>[
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(24, 24, 24, 8),
            child: Text(
              '16 live scenarios',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          sliver: SliverGrid(
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 380,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 2.5,
            ),
            delegate: SliverChildBuilderDelegate(
              (context, index) {
                final scenario = kScenarios[index];
                return Card(
                  child: ListTile(
                    leading: CircleAvatar(child: Text(scenario.number)),
                    title: Text(scenario.title),
                    subtitle: Text(scenario.detail),
                    trailing: Icon(_materialIcon(scenario.icon), color: Colors.indigo),
                  ),
                );
              },
              childCount: kScenarios.length,
            ),
          ),
        ),
      ],
    );
  }
}

class TasksPanel extends StatefulWidget {
  final String apiBaseUrl;
  final String projectId;
  final String publicApiKey;

  const TasksPanel({
    super.key,
    required this.apiBaseUrl,
    required this.projectId,
    required this.publicApiKey,
  });

  @override
  State<TasksPanel> createState() => _TasksPanelState();
}

class _TasksPanelState extends State<TasksPanel> {
  late final VellumClient _client;
  StreamSubscription<QuerySnapshot<JsonMap>>? _subscription;
  final List<DocumentSnapshot<JsonMap>> _tasks = <DocumentSnapshot<JsonMap>>[];

  @override
  void initState() {
    super.initState();
    _client = VellumClient(
      baseUrl: widget.apiBaseUrl,
      projectId: widget.projectId,
      apiKey: widget.publicApiKey,
    );
    _subscription = _client
        .watchCollection(
          'tasks',
          orderBy: <String, Object?>{'field': 'priority', 'dir': 'desc'},
          limit: 50,
        )
        .listen(
          (snapshot) {
            if (!mounted) return;
            setState(() {
              _tasks
                ..clear()
                ..addAll(snapshot.docs);
            });
          },
          onError: (Object error) {
            if (!mounted) return;
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Realtime error: ${error.runtimeType}')),
            );
          },
        );
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _client.auth.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_tasks.isEmpty) {
      return const Center(child: Text('Waiting for realtime task snapshots…'));
    }
    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _tasks.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final task = _tasks[index];
        final JsonMap data = task.data() ?? const <String, Object?>{};
        return Card(
          child: ListTile(
            title: Text('${data['title'] ?? task.id}'),
            subtitle: Text('priority: ${data['priority'] ?? '-'}'),
            trailing: const Icon(Icons.chevron_right),
          ),
        );
      },
    );
  }
}

/// Live auth-state inspector backed by `authStateChanges`.
class SessionPanel extends StatelessWidget {
  final String apiBaseUrl;
  final String projectId;
  final String publicApiKey;

  const SessionPanel({
    super.key,
    required this.apiBaseUrl,
    required this.projectId,
    required this.publicApiKey,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final client = VellumClient(
      baseUrl: apiBaseUrl,
      projectId: projectId,
      apiKey: publicApiKey,
    );
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(Icons.shield_outlined, size: 40, color: scheme.primary),
                const SizedBox(height: 16),
                const Text(
                  'Session state',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 8),
                StreamBuilder<VellumUser?>(
                  stream: client.auth.authStateChanges,
                  builder: (context, snapshot) {
                    final user = snapshot.data;
                    return Text(
                      user == null
                          ? 'Anonymous — sign in through the end-user auth flow.'
                          : 'Signed in as ${user.email ?? user.id}',
                    );
                  },
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const ScenarioOverview(),
                    ),
                  ),
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('View scenarios'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
