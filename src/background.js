/**
 * PageLens Background Service Worker
 * Handles AI API calls, caching, and message passing.
 * API keys are ONLY stored and used here — never exposed to content scripts.
 * Uses Google Gemini API (free tier available at aistudio.google.com)
 */

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache per URL
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message origin — only accept from our extension
  if (sender.id !== chrome.runtime.id && !sender.tab) {
    console.warn("[PageLens] Rejected message from unknown sender");
    return false;
  }

  if (message.type === "SUMMARIZE_PAGE") {
    handleSummarize(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === "CLEAR_CACHE") {
    clearCache(message.payload?.url)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ success: true, data: settings }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveSettings(message.payload)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── Core Summarization ───────────────────────────────────────────────────────
async function handleSummarize({ url, content, title, wordCount }) {
  // Check cache first
  const cached = await getCachedSummary(url);
  if (cached) {
    console.log("[PageLens] Cache hit for:", url);
    return { ...cached, fromCache: true };
  }

  // Get user settings (API key stored securely in chrome.storage.local)
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("NO_API_KEY");
  }

  const estimatedReadTime = Math.ceil(wordCount / 238); // avg reading speed

  const prompt = buildPrompt(title, content, estimatedReadTime);

  const response = await callGeminiAPI(settings.apiKey, prompt);

  const result = parseAIResponse(response, estimatedReadTime, wordCount);

  // Cache the result
  await cacheSummary(url, result);

  return { ...result, fromCache: false };
}

// ─── AI Prompt Builder ────────────────────────────────────────────────────────
function buildPrompt(title, content, readTime) {
  return `You are PageLens, an expert page summarizer. Analyze the following webpage content and provide a structured summary.

Page Title: ${title}
Estimated Read Time: ${readTime} minute${readTime !== 1 ? "s" : ""}

Content:
${content.slice(0, 12000)}

Respond ONLY with a valid JSON object in this exact format (no markdown, no backticks):
{
  "oneLiner": "One crisp sentence describing the page",
  "bullets": [
    "Key point 1 — specific and informative",
    "Key point 2 — specific and informative",
    "Key point 3 — specific and informative",
    "Key point 4 — specific and informative",
    "Key point 5 — specific and informative"
  ],
  "insights": [
    "Deeper insight or implication 1",
    "Deeper insight or implication 2",
    "Deeper insight or implication 3"
  ],
  "sentiment": "positive|neutral|negative|mixed",
  "contentType": "article|tutorial|news|product|documentation|other",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}`;
}

// ─── Gemini API Call (Free Tier) ──────────────────────────────────────────────
async function callGeminiAPI(apiKey, prompt) {
  const url = `${GEMINI_API_URL}?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.3 }
    })
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const msg = errorBody?.error?.message || "";
    if (response.status === 400) throw new Error("INVALID_API_KEY");
    if (response.status === 403) throw new Error("INVALID_API_KEY");
    if (response.status === 429) throw new Error("RATE_LIMITED: " + msg);
    if (response.status === 503) throw new Error("API_OVERLOADED");
    throw new Error(msg || `API_ERROR_${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("EMPTY_RESPONSE");
  return text;
}

// ─── Response Parser 
function parseAIResponse(rawText, estimatedReadTime, wordCount) {
  try {
    // Strip any accidental markdown fences
    const clean = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      oneLiner: sanitize(parsed.oneLiner || ""),
      bullets: (parsed.bullets || []).map(sanitize).filter(Boolean).slice(0, 7),
      insights: (parsed.insights || []).map(sanitize).filter(Boolean).slice(0, 4),
      sentiment: ["positive", "neutral", "negative", "mixed"].includes(parsed.sentiment)
        ? parsed.sentiment
        : "neutral",
      contentType: parsed.contentType || "article",
      keywords: (parsed.keywords || []).map(sanitize).filter(Boolean).slice(0, 8),
      estimatedReadTime,
      wordCount,
      timestamp: Date.now()
    };
  } catch {
    // Fallback: treat raw text as a single bullet
    return {
      oneLiner: "Summary generated",
      bullets: [sanitize(rawText.slice(0, 500))],
      insights: [],
      sentiment: "neutral",
      contentType: "other",
      keywords: [],
      estimatedReadTime,
      wordCount,
      timestamp: Date.now()
    };
  }
}

// xss protection for any AI-generated text that might be rendered in the popup
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .trim();
}

// catch and store summaries in chrome.storage.local with a TTL
async function getCachedSummary(url) {
  const key = `cache_${hashUrl(url)}`;
  const result = await chrome.storage.local.get(key);
  const cached = result[key];
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return cached;
}

async function cacheSummary(url, data) {
  const key = `cache_${hashUrl(url)}`;
  await chrome.storage.local.set({ [key]: { ...data, timestamp: Date.now() } });
}

async function clearCache(url) {
  if (url) {
    const key = `cache_${hashUrl(url)}`;
    await chrome.storage.local.remove(key);
  } else {
    // Clear all cached summaries
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter((k) => k.startsWith("cache_"));
    await chrome.storage.local.remove(cacheKeys);
  }
}

function hashUrl(url) {
  // Simple hash for storage key generation
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash << 5) - hash + url.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// settings management — only API key is stored, and it's only used in this background script for security
async function getSettings() {
  const result = await chrome.storage.local.get("settings");
  return result.settings || { apiKey: "", theme: "auto", highlightEnabled: true };
}

async function saveSettings(settings) {
  // Validate settings object
  const safe = {
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : "",
    theme: ["auto", "light", "dark"].includes(settings.theme) ? settings.theme : "auto",
    highlightEnabled: Boolean(settings.highlightEnabled)
  };
  await chrome.storage.local.set({ settings: safe });
}
