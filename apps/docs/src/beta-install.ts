// Registry releases used by both language versions. Source-checkout setup belongs in README.
export const betaJavaScriptInstall = `# Node.js 22+ recommended
npm install @vellumdb/sdk-js@0.0.5
# or: pnpm add @vellumdb/sdk-js@0.0.5`;
export const betaDartInstall = `# Dart 3.4+ / compatible Flutter. Add to pubspec.yaml:
dependencies:
  vellum_flutter: ^0.0.5
# Then run: dart pub get (or flutter pub get)`;
