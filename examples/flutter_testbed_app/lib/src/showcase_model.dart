/// Platform-neutral model shared by the pure-Dart and Flutter showcase surfaces.
///
/// Keeping the scenario metadata free of `package:flutter` imports means the
/// whole model is analysable and testable with the pure Dart SDK, while the
/// Flutter widget layer can map each [ShowcaseIcon] to a Material icon.
library;

/// A platform-neutral icon token used by [ScenarioDescriptor].
enum ShowcaseIcon {
  key,
  personAdd,
  merge,
  mail,
  password,
  lock,
  admin,
  sort,
  bolt,
  autorenew,
  split,
  lockReset,
  code,
  link,
  chart,
  gauge,
}

/// One of the 16 live scenarios exercised by `VellumLiveTestbedRunner`.
class ScenarioDescriptor {
  final String number;
  final String title;
  final String detail;
  final ShowcaseIcon icon;

  const ScenarioDescriptor({
    required this.number,
    required this.title,
    required this.detail,
    required this.icon,
  });
}

/// The canonical, ordered list of live scenarios shared by CLI and showcase.
const List<ScenarioDescriptor> kScenarios = <ScenarioDescriptor>[
  ScenarioDescriptor(
    number: '01',
    title: 'JWKS discovery',
    detail: 'OKP / Ed25519 key',
    icon: ShowcaseIcon.key,
  ),
  ScenarioDescriptor(
    number: '02',
    title: 'Signup + projection',
    detail: 'users/{uid} auto-write',
    icon: ShowcaseIcon.personAdd,
  ),
  ScenarioDescriptor(
    number: '03',
    title: 'Merge preservation',
    detail: 'Custom field + profile patch',
    icon: ShowcaseIcon.merge,
  ),
  ScenarioDescriptor(
    number: '04',
    title: 'Email verification',
    detail: 'devToken confirm',
    icon: ShowcaseIcon.mail,
  ),
  ScenarioDescriptor(
    number: '05',
    title: 'TOTP MFA',
    detail: 'Enroll, challenge, verify',
    icon: ShowcaseIcon.password,
  ),
  ScenarioDescriptor(
    number: '06',
    title: 'Owner vs stranger',
    detail: 'Security rules return 403',
    icon: ShowcaseIcon.lock,
  ),
  ScenarioDescriptor(
    number: '07',
    title: 'Claims elevation',
    detail: 'Customer admin + refresh',
    icon: ShowcaseIcon.admin,
  ),
  ScenarioDescriptor(
    number: '08',
    title: 'Query + cursors',
    detail: 'Sorted, filtered, paginated',
    icon: ShowcaseIcon.sort,
  ),
  ScenarioDescriptor(
    number: '09',
    title: 'Realtime watch',
    detail: 'WebSocket event < 2 s',
    icon: ShowcaseIcon.bolt,
  ),
  ScenarioDescriptor(
    number: '10',
    title: 'Silent refresh',
    detail: 'Expired access token',
    icon: ShowcaseIcon.autorenew,
  ),
  ScenarioDescriptor(
    number: '11',
    title: 'Refresh mutex',
    detail: '5 concurrent callers',
    icon: ShowcaseIcon.split,
  ),
  ScenarioDescriptor(
    number: '12',
    title: 'Password reset',
    detail: 'New sign-in + revocation',
    icon: ShowcaseIcon.lockReset,
  ),
  ScenarioDescriptor(
    number: '13',
    title: 'Rules DSL studio',
    detail: 'Compile, publish, simulate',
    icon: ShowcaseIcon.code,
  ),
  ScenarioDescriptor(
    number: '14',
    title: 'Relations + redaction',
    detail: 'include + rules filter',
    icon: ShowcaseIcon.link,
  ),
  ScenarioDescriptor(
    number: '15',
    title: 'V2 aggregations',
    detail: 'groupBy + CI + OR',
    icon: ShowcaseIcon.chart,
  ),
  ScenarioDescriptor(
    number: '16',
    title: 'Index advisor',
    detail: 'Suggestion + one-click apply',
    icon: ShowcaseIcon.gauge,
  ),
];

/// Short human-readable summary used by both the CLI and the UI.
String describeShowcase() =>
    'VELLUM Flutter Showcase — ${kScenarios.length} live scenarios against the real API';
