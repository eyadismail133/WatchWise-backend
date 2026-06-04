import { openai } from "../lib/openai.js";

const MODEL = "llama-3.3-70b-versatile";

interface RecommendationInput {
  userPrompt?: string;
  topGenres?: string[];
  topMoods?: string[];
  watchHistory?: string[];
}

export async function getAiRecommendation(input: RecommendationInput) {
  const systemPrompt = `You are a professional movie and TV show recommendation expert.

Rules:
- Recommend EXACTLY ONE real movie or TV show that exists and can be found on TMDB.
- The title must be the exact, full, official title (e.g. "Get Out", "A Quiet Place", "Titanic").
- Prefer critically acclaimed films or strong hidden gems that genuinely fit the user's request.
- Never invent fictional titles.
- Return JSON only — no extra text.

Response format:
{
  "title": "Exact Official Title",
  "mediaType": "movie" or "tv",
  "explanation": "2-3 sentences explaining why this fits the user's request."
}`;

  const userContext = `User request: ${input.userPrompt ?? "Suggest something based on my taste."}

Favorite genres: ${input.topGenres?.join(", ") || "Unknown"}
Favorite moods: ${input.topMoods?.join(", ") || "Unknown"}
Recently watched: ${input.watchHistory?.join(", ") || "None"}`;

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContext },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("AI recommendation failed");

  return JSON.parse(content) as {
    title: string;
    mediaType: "movie" | "tv";
    explanation: string;
  };
}

interface TasteActivityItem {
  title: string;
  genres: string[];
  mediaType: string;
  userRating?: number | null;
  status?: string;
  isFavorite: boolean;
  year?: number | null;
}

export interface AiTasteResult {
  narrative: number;
  visual: number;
  emotional: number;
  pacing: number;
  era: number;
  breadth: number;
  topGenres: string[];
  topMoods: string[];
  personality: string;
  summary: string;
}

export async function getAiTasteProfile(
  activity: TasteActivityItem[],
): Promise<AiTasteResult> {
  const systemPrompt = `You are a cinematic taste analyst. Given a user's watch history, ratings, and favorites, deeply analyze their viewing personality.

Return ONLY valid JSON with these exact fields (all numbers 0-100):
{
  "narrative": <number>,
  "visual": <number>,
  "emotional": <number>,
  "pacing": <number>,
  "era": <number>,
  "breadth": <number>,
  "topGenres": ["Genre1", "Genre2", "Genre3", "Genre4", "Genre5"],
  "topMoods": ["mood1", "mood2", "mood3", "mood4", "mood5", "mood6"],
  "personality": "Unique 2-3 word cinematic archetype label",
  "summary": "3-4 sentence personalized analysis of their taste and viewing identity."
}

Scoring guide:
- narrative: preference for complex, layered storytelling vs. simple plots
- visual: appreciation for cinematography, visual style, effects
- emotional: tendency toward emotional, character-driven content
- pacing: preference for fast-paced (high) vs. slow, contemplative (low)
- era: modern films/shows (high=recent) vs. classics (low=older)
- breadth: genre diversity (high=varied, low=focused on one genre)`;

  const activityText = activity
    .slice(0, 40)
    .map(
      (a) =>
        `"${a.title}" (${a.mediaType}, ${a.year ?? "?"}) — genres: ${a.genres.join(", ")}${a.userRating ? `, rating: ${a.userRating}/5` : ""}${a.isFavorite ? ", FAVORITED" : ""}${a.status === "watched" ? ", watched" : ""}`,
    )
    .join("\n");

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Here is my watch/favorite activity:\n\n${activityText || "No activity yet."}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("AI taste profile generation failed");

  const parsed = JSON.parse(content) as AiTasteResult;

  // Clamp all numeric fields to 0-100
  const clamp = (v: unknown) =>
    Math.max(0, Math.min(100, Math.round(Number(v) || 50)));

  return {
    narrative: clamp(parsed.narrative),
    visual: clamp(parsed.visual),
    emotional: clamp(parsed.emotional),
    pacing: clamp(parsed.pacing),
    era: clamp(parsed.era),
    breadth: clamp(parsed.breadth),
    topGenres: Array.isArray(parsed.topGenres)
      ? parsed.topGenres.slice(0, 5)
      : [],
    topMoods: Array.isArray(parsed.topMoods) ? parsed.topMoods.slice(0, 6) : [],
    personality:
      typeof parsed.personality === "string"
        ? parsed.personality
        : "Cinema Wanderer",
    summary:
      typeof parsed.summary === "string"
        ? parsed.summary
        : "Start watching and rating titles to build your taste profile.",
  };
}
