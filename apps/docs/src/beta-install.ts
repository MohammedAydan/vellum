export const betaJavaScriptInstall = `# Node.js 22+, Corepack. Run outside your application directory.
git clone https://github.com/MohammedAydan/vellum.git vellum-beta
cd vellum-beta
git checkout 7d909ea6e7a726287dd7dd5ecae024f8f32d3e49
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @vellumdb/sdk-js... build
# From your application, use the path to this checkout:
# pnpm add /absolute/path/to/vellum-beta/packages/sdk-js`;
export const betaDartInstall = `# Dart 3.4+ / Flutter with Dart 3.4+. pubspec.yaml:
dependencies:
  vellum_flutter:
    git:
      url: https://github.com/MohammedAydan/vellum.git
      ref: 7d909ea6e7a726287dd7dd5ecae024f8f32d3e49
      path: sdks/flutter
# Then run: dart pub get (or flutter pub get)`;
