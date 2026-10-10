import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("the Vercel API handler serves the health endpoint without starting a process listener", async () => {
  process.env.GROQ_API_KEY = "test-key";
  const { default: handler } = await import("../api/[...path].js");
  const server = createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Server is Live!");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
