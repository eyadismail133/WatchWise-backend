import assert from "node:assert/strict";
import test from "node:test";

test("the retired Groq model regression uses a free-plan model for recommendations", async () => {
  process.env.GROQ_API_KEY = "test-key";

  const { openai } = await import("../lib/openai.js");
  const { getAiRecommendation } = await import("../services/aiRecommendation.js");
  const completionApi = openai.chat.completions;
  const originalDescriptor = Object.getOwnPropertyDescriptor(completionApi, "create");
  let requestedModel = "";

  Object.defineProperty(completionApi, "create", {
    configurable: true,
    value: async ({ model }: { model: string }) => {
      requestedModel = model;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Arrival",
                mediaType: "movie",
                explanation: "A thoughtful science-fiction drama.",
              }),
            },
          },
        ],
      };
    },
  });

  try {
    const recommendation = await getAiRecommendation({
      userPrompt: "Recommend smart science fiction",
    });

    assert.equal(recommendation.title, "Arrival");
    assert.equal(requestedModel, "qwen/qwen3.8-27b");
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(completionApi, "create", originalDescriptor);
    } else {
      delete (completionApi as { create?: unknown }).create;
    }
  }
});
