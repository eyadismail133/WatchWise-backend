import { openai } from "../lib/openai.js";

interface RecommendationInput {
  userPrompt?: string;
  topGenres?: string[];
  topMoods?: string[];
  watchHistory?: string[];
}

export async function getAiRecommendation(input: RecommendationInput) {
  const systemPrompt = `
You are a professional movie and TV recommendation expert.

Your job:
- Recommend ONLY ONE movie or TV show.
- Choose highly relevant titles.
- Prefer critically acclaimed or strong hidden gems.
- Avoid random picks.
- Return JSON only.

Response format:
{
  "title": "Interstellar",
  "mediaType": "movie",
  "explanation": "A thoughtful emotional sci-fi journey with philosophical themes and breathtaking visuals."
}
`;

  const userContext = `
User request:
${input.userPrompt ?? "Suggest something based on my taste profile."}

Favorite genres:
${input.topGenres?.join(", ") ?? "Unknown"}

Favorite moods:
${input.topMoods?.join(", ") ?? "Unknown"}

Recently watched:
${input.watchHistory?.join(", ") ?? "Unknown"}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.9,
    response_format: {
      type: "json_object",
    },
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userContext,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;

  if (!content) {
    throw new Error("AI recommendation failed");
  }

  return JSON.parse(content) as {
    title: string;
    mediaType: "movie" | "tv";
    explanation: string;
  };
}
