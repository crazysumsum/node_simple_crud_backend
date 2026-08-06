import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIdempotencyStore } from "../src/framework/idempotency/IdempotencyStore.js";

const options = { fingerprint: "same-input", ttlMs: 60000 };

test("memory idempotency capacity never evicts pending work", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 1 });

  assert.deepEqual(await store.begin("first", options), { state: "started" });
  assert.deepEqual(await store.begin("second", options), {
    state: "capacityExceeded"
  });
  assert.deepEqual(await store.begin("first", options), { state: "inProgress" });
});

test("memory idempotency capacity may evict a completed entry", async () => {
  const store = new MemoryIdempotencyStore({ maxEntries: 1 });

  await store.begin("completed", options);
  await store.complete(
    "completed",
    { statusCode: 201, body: { success: true } },
    { ttlMs: 60000 }
  );

  assert.deepEqual(await store.begin("new", options), { state: "started" });
  assert.deepEqual(await store.begin("completed", options), {
    state: "capacityExceeded"
  });
});
