import { Route as rootRoute } from "./routes/__root.js";
import { Route as indexRoute } from "./routes/index.js";
import { Route as authRoute } from "./routes/_auth.js";
import { Route as loginRoute } from "./routes/_auth/login.js";
import { Route as signupRoute } from "./routes/_auth/signup.js";
import { Route as mfaRoute } from "./routes/_auth/mfa.js";
import { PrivacyRoute, TermsRoute } from "./routes/legal.js";
import { Route as appRoute } from "./routes/_app.js";
import { Route as appIndexRoute } from "./routes/_app/index.js";
import { Route as orgProjectsRoute } from "./routes/_app/orgs.$orgId.js";
import { Route as projectRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.js";
import { Route as projectUsageRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.usage.js";
import { Route as orgBillingRoute } from "./routes/_app/orgs.$orgId.billing.js";
import { Route as settingsRoute } from "./routes/_app/settings.js";
import { Route as dataRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.data.js";
import { Route as queryRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.query.js";
import { Route as rulesRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.rules.js";
import { Route as relationsRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.relations.js";
import { Route as indexesRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.indexes.js";
import { Route as keysRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.keys.js";
import { Route as authStudioRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.auth.js";
import { Route as projectIndexRoute } from "./routes/_app/orgs.$orgId.projects.$projectId.index.js";

const projectWithChildren = projectRoute.addChildren([
  projectIndexRoute,
  dataRoute,
  queryRoute,
  rulesRoute,
  relationsRoute,
  indexesRoute,
  keysRoute,
  authStudioRoute,
]);

const appWithChildren = appRoute.addChildren([
  appIndexRoute,
  orgProjectsRoute,
  projectUsageRoute,
  orgBillingRoute,
  settingsRoute,
  projectWithChildren,
]);

const authWithChildren = authRoute.addChildren([
  loginRoute,
  signupRoute,
  mfaRoute,
]);

export const routeTree = rootRoute.addChildren([
  indexRoute,
  PrivacyRoute,
  TermsRoute,
  authWithChildren,
  appWithChildren,
]);
