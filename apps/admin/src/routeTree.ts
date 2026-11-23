import { Route as rootRoute } from "./routes/__root.js";
import { Route as indexRoute } from "./routes/index.js";
import { Route as authRoute } from "./routes/_auth.js";
import { Route as loginRoute } from "./routes/_auth/login.js";
import { Route as appRoute } from "./routes/_app.js";
import { Route as overviewRoute } from "./routes/_app/index.js";
import { Route as tenantsRoute } from "./routes/_app/tenants.js";
import { Route as tenantDetailRoute } from "./routes/_app/tenants.$orgId.js";
import { Route as auditRoute } from "./routes/_app/audit.js";
import { Route as metricsRoute } from "./routes/_app/metrics.js";
import { Route as featuresRoute } from "./routes/_app/features.js";
import { Route as authControlRoute } from "./routes/_app/auth.js";
import { Route as securityRoute } from "./routes/_app/security.js";
import { Route as billingRoute } from "./routes/_app/billing.js";

const authWithChildren = authRoute.addChildren([
  loginRoute,
]);

const appWithChildren = appRoute.addChildren([
  overviewRoute,
  tenantsRoute,
  tenantDetailRoute,
  auditRoute,
  metricsRoute,
  featuresRoute,
  securityRoute,
  billingRoute,
  authControlRoute,
]);

export const routeTree = rootRoute.addChildren([
  indexRoute,
  authWithChildren,
  appWithChildren,
]);
