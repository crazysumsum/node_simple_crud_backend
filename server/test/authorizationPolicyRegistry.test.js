import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationError,
  createAuthorizationPolicyRegistry
} from "../src/framework/authorization/authorizationPolicyRegistry.js";

const route = { method: "POST", path: "/api/v1/orders" };

test("parameterized permission policy reads permissions from JWT claims", async () => {
  const registry = createAuthorizationPolicyRegistry();
  const policies = registry.normalize(
    [
      "authenticated",
      {
        name: "hasPermission",
        options: {
          permissions: ["order.create", "inventory.reserve"],
          match: "all"
        }
      }
    ],
    "post /api/v1/orders"
  );
  const allowedRequest = {
    auth: {
      type: "jwt",
      claims: { permissions: ["order.create", "inventory.reserve"] }
    }
  };

  assert.equal(await registry.authorize(policies, allowedRequest, route), true);

  await assert.rejects(
    () =>
      registry.authorize(
        policies,
        {
          auth: { type: "jwt", claims: { permissions: ["order.create"] } }
        },
        route
      ),
    AuthorizationError
  );
});

test("authorization policy options are rejected during startup validation", () => {
  const registry = createAuthorizationPolicyRegistry();

  assert.throws(
    () =>
      registry.normalize(
        [{ name: "hasRole", options: { roles: [], unknown: true } }],
        "get /api/v1/admin"
      ),
    /unknown options/
  );
  assert.throws(
    () =>
      registry.normalize(
        [{ name: "allowAll", options: { unexpected: true } }],
        "get /api/v1/public"
      ),
    /does not accept options/
  );
});
