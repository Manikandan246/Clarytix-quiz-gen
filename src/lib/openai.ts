import OpenAI from "openai";

let cachedClient: OpenAI | null = null;

export function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey,
    });
  }

  return cachedClient;
}
