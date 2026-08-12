import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fallacies = JSON.parse(
  await readFile(path.join(__dirname, "data", "fallacies.json"), "utf-8")
);
const fallacyNames = new Set(fallacies.map((f) => f.name.toLowerCase()));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Provider adapters -----------------------------------------------
// Each provider knows how to list its models and how to run a single
// prompt-in / JSON-out call. Everything else in this file is provider-agnostic.

const PROVIDERS = {
  gemini: {
    async listModels(apiKey) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => ({ name: m.name.replace(/^models\//, ""), displayName: m.displayName || m.name }));
    },
    async generate(apiKey, model, prompt, { temperature } = {}) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            ...(temperature != null ? { temperature } : {}),
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("The model returned an empty response.");
      return text;
    },
  },

  openai: {
    async listModels(apiKey) {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      return (data.data || [])
        .filter((m) => /^(gpt|o\d)/i.test(m.id) && !/(embedding|whisper|tts|dall-e|moderation|audio|realtime)/i.test(m.id))
        .map((m) => ({ name: m.id, displayName: m.id }));
    },
    async generate(apiKey, model, prompt, { temperature } = {}) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          ...(temperature != null ? { temperature } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("The model returned an empty response.");
      return text;
    },
  },

  anthropic: {
    async listModels(apiKey) {
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      return (data.data || []).map((m) => ({ name: m.id, displayName: m.display_name || m.id }));
    },
    async generate(apiKey, model, prompt, { temperature } = {}) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
          ...(temperature != null ? { temperature: Math.min(temperature, 1) } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `API error (${r.status})`);
      const text = data?.content?.[0]?.text;
      if (!text) throw new Error("The model returned an empty response.");
      return text;
    },
  },
};

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unsupported provider: ${name}`);
  return provider;
}

function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("The model returned malformed JSON.");
  }
}

async function callModel({ provider, apiKey, model, prompt, temperature }) {
  const text = await getProvider(provider).generate(apiKey, model, prompt, { temperature });
  return parseJsonLoose(text);
}

// --- Scenario variety ----------------------------------------------------
// Left entirely to the model, the argument generator gravitates toward a
// handful of favorite scenarios (libraries, smoking bans...). We fight that
// by forcing a randomly chosen domain each round and banning recently used
// topics/proposers, instead of just asking nicely for "variety".

const SCENARIO_CATEGORIES = [
  "workplace rules (office dress code, remote work, meetings)",
  "a homeowners' association or apartment building rule",
  "a sports league or team decision",
  "a restaurant, cafe, or food truck policy",
  "a social media platform or app feature",
  "a gym or fitness studio policy",
  "a public transit or parking policy",
  "a video game or gaming community rule",
  "a wedding, party, or family gathering dispute",
  "a pet or animal-related town ordinance",
  "a college or university campus policy",
  "a workplace dress code or grooming policy",
  "a streaming service or entertainment industry decision",
  "a neighborhood noise, parking, or yard dispute",
  "a fashion trend or clothing brand controversy",
  "an amusement park, zoo, or tourist attraction rule",
  "a dating app or dating culture debate",
  "a holiday tradition or seasonal event decision",
  "a coffee shop, bar, or nightlife policy",
  "a local farmers market or small business regulation",
  "a airline or air travel policy",
  "a fast food chain or grocery store decision",
  "a music festival or concert venue rule",
  "a barbershop, salon, or personal grooming business decision",
  "a youth sports or Little League decision",
  "a condo building or landlord-tenant dispute",
  "a tech gadget or smart home device controversy",
  "a city park or recreation center rule",
];

let recentTopics = [];

function buildRoundPrompt() {
  const category = SCENARIO_CATEGORIES[Math.floor(Math.random() * SCENARIO_CATEGORIES.length)];
  const seed = Math.floor(Math.random() * 1_000_000);
  const avoidList = recentTopics.length
    ? `\n\nDo NOT reuse these recent topics or anything close to them: ${recentTopics.map((t) => `"${t}"`).join(", ")}.`
    : "";

  return `Invent one random, everyday debate topic and a short, punchy question about it, in the style of a local news headline.
Examples of the style (do not reuse these, and do not default to library/book/reading scenarios — those are overused):
- "A politician is proposing to ban smoking in the city. Should the city ban smoking?"
- "A gym manager wants to ban phone use on the workout floor. Should the gym ban phones on the floor?"

The scenario MUST be specifically about this domain: ${category}.${avoidList}

The question must always name or clearly describe a specific proposer (a person, role, or named group — e.g. "a gym manager", "HOA board president Karen Liu", "a team captain") who is advancing the proposal, so a player has a concrete person/entity to argue about. Keep the question answerable in one short sentence. (random seed: ${seed}, ignore this number, it's just to keep your answer fresh)

Respond with ONLY JSON, no markdown formatting, of the exact shape: {"topic": string, "question": string}`;
}

// --- Routes -------------------------------------------------------------

app.get("/api/fallacies", (req, res) => {
  res.json(fallacies);
});

app.post("/api/models", async (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "Missing API key." });
  try {
    const models = await getProvider(provider).listModels(apiKey);
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/round", async (req, res) => {
  const { provider, apiKey, model } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "Missing API key." });
  if (!model) return res.status(400).json({ error: "Missing model." });

  const prompt = buildRoundPrompt();

  try {
    const result = await callModel({ provider, apiKey, model, prompt, temperature: 1.3 });
    if (result.topic) {
      recentTopics.push(result.topic);
      if (recentTopics.length > 8) recentTopics.shift();
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { provider, apiKey, model, topic, question, response } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: "Missing API key." });
  if (!model) return res.status(400).json({ error: "Missing model." });
  if (!response || !response.trim()) {
    return res.status(400).json({ error: "Missing response text." });
  }

  const fallacyReference = fallacies
    .map((f) => `- ${f.name}: ${f.description}`)
    .join("\n");

  const prompt = `You are a strict judge for a game called Illogically Sound. A player was given this scenario:
Topic: "${topic || "(not given)"}"
Question: "${question}"

The player responded:
"${response}"

Here is the canonical list of logical fallacies to check against:
${fallacyReference}

Grading rules — read carefully, you must be strict here:
1. First decide whether the response is genuinely engaging with the scenario at all — i.e. it is trying to argue for or against the proposal in the question, even if via fallacious reasoning. A response that is just a random, contextless insult or non sequitur with no logical connection to the topic, the question, or the proposer named in it is NOT a fallacy — it is just noise, and must not be counted.
2. Every fallacy you report must be functioning AS PART OF AN ARGUMENT about the question. For example, an ad hominem only counts if it attacks a person who is actually the proposer/arguer in this scenario (or a stated supporter of the proposal) — insulting a random unrelated person the player made up, or an insult with no argumentative role, does not count.
3. Do not reward low-effort responses that consist of a single unrelated jab and nothing else. If the response has no real connection to the scenario, "onTopic" must be false and "fallacies" must be an empty array, regardless of how insulting or fallacy-shaped the wording sounds.
4. When the response IS engaging with the scenario, be generous and thorough about recognizing genuine fallacies within it — this game rewards players for deliberately packing in fallacies while staying on topic.
5. Only count a fallacy if it is a plausible instance from the list above, and use fallacy names EXACTLY as they appear in the list. Do not invent names. Do not list the same fallacy twice.

For each fallacy found, give a short quote (a snippet from the player's response, not the whole thing) and a one-sentence explanation of why it fits, tying it back to the scenario.

Respond with ONLY JSON, no markdown formatting, of the exact shape:
{"onTopic": boolean, "fallacies": [{"name": string, "quote": string, "explanation": string}], "commentary": string}
The "commentary" field is a short, playful one or two sentence verdict on the player's performance. If "onTopic" is false, explain in "commentary" that the response didn't actually engage with the scenario so nothing counts.`;

  try {
    const result = await callModel({ provider, apiKey, model, prompt });

    const onTopic = result.onTopic !== false;
    const seen = new Set();
    const validated = [];
    if (onTopic) {
      for (const f of result.fallacies || []) {
        const key = (f.name || "").toLowerCase().trim();
        if (!fallacyNames.has(key) || seen.has(key)) continue;
        seen.add(key);
        validated.push(f);
      }
    }

    res.json({
      onTopic,
      fallacies: validated,
      commentary: result.commentary || "",
      score: validated.length * 10,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Illogically Sound running at http://localhost:${PORT}`);
});
