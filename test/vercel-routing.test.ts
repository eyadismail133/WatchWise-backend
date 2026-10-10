import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("Vercel forwards nested API paths to the serverless handler", () => {
  const configurationPath = resolve("vercel.json");

  assert.equal(existsSync(configurationPath), true);

  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  assert.deepEqual(configuration.rewrites, [
    { source: "/api/(.*)", destination: "/api/[...path]" },
  ]);
});
