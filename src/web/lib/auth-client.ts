import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { DEMO_USER } from "@shared/demo-data";

const NOT_IN_DEMO = { data: null, error: { message: "Not available in the demo", status: 400 } };

/** The demo build has no server: a signed-in demo user, and every account change answers "not available". */
function demoClient(): ReturnType<typeof createRealClient> {
  const session = {
    user: { ...DEMO_USER, emailVerified: true, image: null, twoFactorEnabled: true },
    session: { id: "s1", userId: DEMO_USER.id },
  };
  const useSession = () => ({ data: session, isPending: false, error: null, refetch: async () => {} });
  const stub: ProxyHandler<object> = {
    get: (_t, key) => (key === "useSession" ? useSession : new Proxy(async () => NOT_IN_DEMO, stub)),
    apply: async () => NOT_IN_DEMO,
  };
  return new Proxy(async () => NOT_IN_DEMO, stub) as unknown as ReturnType<typeof createRealClient>;
}

// Without onTwoFactorRedirect the login page handles the second step itself.
const createRealClient = () => createAuthClient({ basePath: "/api/auth", plugins: [twoFactorClient()] });

export const authClient = __DEMO__ ? demoClient() : createRealClient();
