/**
 * PageLens Popup Script
 * Orchestrates extraction → background AI call → UI rendering.
 */

// state
let currentTab = null;
let currentSummary = null;
let highlightsActive = false;
let isSettingsOpen = false;

// Dom References
const $ = (id) => document.getElementById(id);
const views = {
  main: $("view-main"),
  result: $("view-result"),
  settings: $("view-settings"),
  error: $("view-error")
};

// Initialization
document.addEventListener("DOMContentLoaded", async () => {
  await loadTheme();
  await initCurrentTab();
  bindEvents();
});

async function initCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab) {
    showError("Could not access the current tab.");
    return;
  }

  // Show page info
  $("page-title").textContent = truncate(tab.title || "Untitled Page", 60);
  $("page-url").textContent = truncate(new URL(tab.url).hostname, 40);

  // Set favicon
  if (tab.favIconUrl) {
    const img = $("page-favicon");
    img.src = tab.favIconUrl;
    img.onerror = () => img.remove();
  }

  // Check if page is summarizable
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    $("btn-summarize").disabled = true;
    $("btn-summarize").textContent = "Cannot summarize this page";
    $("page-badge").textContent = "system page";
    return;
  }

  // Check for cached summary
  const cached = await checkCache(tab.url);
  if (cached) {
    currentSummary = cached;
    renderSummary(cached, true);
  }
}

function bindEvents() {
  $("btn-summarize").addEventListener("click", handleSummarize);
  $("btn-clear").addEventListener("click", handleClear);
  $("btn-copy").addEventListener("click", handleCopy);
  $("btn-highlight").addEventListener("click", handleHighlight);
  $("btn-settings").addEventListener("click", toggleSettings);
  $("btn-settings-close").addEventListener("click", toggleSettings);
  $("btn-save-settings").addEventListener("click", handleSaveSettings);
  $("btn-retry").addEventListener("click", handleSummarize);
  $("btn-back").addEventListener("click", () => showView("main"));
  $("theme-toggle").addEventListener("click", cycleTheme);
}

// Summarize button handler — main flow orchestrator
async function handleSummarize() {
  // Verify API key first
  const settings = await sendToBackground({ type: "GET_SETTINGS" });
  if (!settings.data?.apiKey) {
    showSettingsWithPrompt("Please add your Anthropic API key to get started.");
    return;
  }

  showLoading();

  try {
    // Step 1: Extract content from the page via content script
    const extracted = await chrome.tabs.sendMessage(currentTab.id, {
      type: "EXTRACT_CONTENT"
    });

    if (!extracted?.success) {
      throw new Error("Failed to extract page content. Try refreshing the page.");
    }

    const { content, title, wordCount, url } = extracted.data;

    if (!content || wordCount < 30) {
      throw new Error("Not enough readable content found on this page.");
    }

    // Step 2: Send to background for AI processing
    const result = await sendToBackground({
      type: "SUMMARIZE_PAGE",
      payload: { url, content, title, wordCount }
    });

    if (!result.success) {
      throw new Error(friendlyError(result.error));
    }

    currentSummary = result.data;
    renderSummary(result.data, result.data.fromCache);

  } catch (err) {
    showError(err.message || "Something went wrong. Please try again.");
  }
}

async function handleClear() {
  if (!currentTab) return;

  // Remove highlights if active
  if (highlightsActive) {
    await chrome.tabs.sendMessage(currentTab.id, { type: "REMOVE_HIGHLIGHTS" });
    highlightsActive = false;
  }

  // Clear cache for this URL
  await sendToBackground({
    type: "CLEAR_CACHE",
    payload: { url: currentTab.url }
  });

  currentSummary = null;
  showView("main");

  // Animate button
  const btn = $("btn-clear");
  btn.textContent = "✓ Cleared";
  setTimeout(() => (btn.textContent = "Clear"), 1500);
}

async function handleCopy() {
  if (!currentSummary) return;
  const text = formatSummaryAsText(currentSummary);
  try {
    await navigator.clipboard.writeText(text);
    const btn = $("btn-copy");
    btn.textContent = "✓ Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 2000);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function handleHighlight() {
  if (!currentTab || !currentSummary) return;

  if (highlightsActive) {
    await chrome.tabs.sendMessage(currentTab.id, { type: "REMOVE_HIGHLIGHTS" });
    highlightsActive = false;
    $("btn-highlight").textContent = "Highlight";
    $("btn-highlight").classList.remove("active");
  } else {
    await chrome.tabs.sendMessage(currentTab.id, {
      type: "HIGHLIGHT_KEYWORDS",
      payload: { keywords: currentSummary.keywords || [] }
    });
    highlightsActive = true;
    $("btn-highlight").textContent = "✓ Highlighted";
    $("btn-highlight").classList.add("active");
  }
}

// Settings management
async function toggleSettings() {
  isSettingsOpen = !isSettingsOpen;

  if (isSettingsOpen) {
    const settings = await sendToBackground({ type: "GET_SETTINGS" });
    if (settings.data?.apiKey) {
      $("api-key-input").value = settings.data.apiKey;
    }
    $("highlight-toggle").checked = settings.data?.highlightEnabled !== false;
    showView("settings");
  } else {
    showView(currentSummary ? "result" : "main");
  }
}

async function showSettingsWithPrompt(msg) {
  $("settings-prompt").textContent = msg;
  isSettingsOpen = true;
  const settings = await sendToBackground({ type: "GET_SETTINGS" });
  if (settings.data?.apiKey) $("api-key-input").value = settings.data.apiKey;
  $("highlight-toggle").checked = settings.data?.highlightEnabled !== false;
  showView("settings");
}

async function handleSaveSettings() {
  const apiKey = $("api-key-input").value.trim();
  const highlightEnabled = $("highlight-toggle").checked;

  await sendToBackground({
    type: "SAVE_SETTINGS",
    payload: { apiKey, highlightEnabled, theme: getCurrentTheme() }
  });

  isSettingsOpen = false;
  showView(currentSummary ? "result" : "main");

  const btn = $("btn-save-settings");
  btn.textContent = "✓ Saved!";
  setTimeout(() => (btn.textContent = "Save Settings"), 1500);
}

// Rendering the summary result view
function renderSummary(data, fromCache) {
  showView("result");

  // One-liner
  $("summary-oneliner").textContent = data.oneLiner || "";

  // Meta badges
  $("badge-type").textContent = data.contentType || "article";
  $("badge-sentiment").textContent = data.sentiment || "neutral";
  $("badge-sentiment").className = `badge sentiment-${data.sentiment || "neutral"}`;

  // Read time & word count
  $("meta-readtime").textContent = `${data.estimatedReadTime} min read`;
  $("meta-wordcount").textContent = `${(data.wordCount || 0).toLocaleString()} words`;

  // Cache indicator
  $("cache-badge").style.display = fromCache ? "inline-flex" : "none";

  // Bullet points
  const bulletList = $("bullet-list");
  bulletList.innerHTML = "";
  for (const bullet of data.bullets || []) {
    const li = document.createElement("li");
    li.textContent = bullet; // textContent — no XSS risk
    bulletList.appendChild(li);
  }

  // Insights
  const insightList = $("insight-list");
  insightList.innerHTML = "";
  for (const insight of data.insights || []) {
    const li = document.createElement("li");
    li.textContent = insight;
    insightList.appendChild(li);
  }

  // Keywords
  const keywordContainer = $("keywords");
  keywordContainer.innerHTML = "";
  for (const kw of data.keywords || []) {
    const span = document.createElement("span");
    span.className = "keyword-tag";
    span.textContent = kw;
    keywordContainer.appendChild(span);
  }

  // Show/hide highlight button based on keywords
  $("btn-highlight").style.display = (data.keywords?.length > 0) ? "inline-flex" : "none";
}

function formatSummaryAsText(data) {
  const lines = [
    `📄 ${data.oneLiner}`,
    "",
    "KEY POINTS:",
    ...(data.bullets || []).map((b) => `• ${b}`),
    "",
    "INSIGHTS:",
    ...(data.insights || []).map((i) => `→ ${i}`),
    "",
    `⏱ ${data.estimatedReadTime} min read · ${(data.wordCount || 0).toLocaleString()} words`,
    `🏷 ${(data.keywords || []).join(", ")}`,
    "",
    "Summarized by PageLens"
  ];
  return lines.join("\n");
}

// View Management
function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== name);
  }
}

function showLoading() {
  showView("main");
  $("btn-summarize").disabled = true;
  $("btn-summarize").classList.add("loading");
  $("btn-summarize").setAttribute("aria-busy", "true");
  $("loading-text").classList.remove("hidden");
}

function hideLoading() {
  $("btn-summarize").disabled = false;
  $("btn-summarize").classList.remove("loading");
  $("btn-summarize").removeAttribute("aria-busy");
  $("loading-text").classList.add("hidden");
}

function showError(message) {
  hideLoading();
  showView("error");
  $("error-message").textContent = message;
}

// Theme
const THEMES = ["auto", "light", "dark"];
let themeIndex = 0;

async function loadTheme() {
  const settings = await sendToBackground({ type: "GET_SETTINGS" });
  const theme = settings.data?.theme || "auto";
  themeIndex = THEMES.indexOf(theme);
  if (themeIndex < 0) themeIndex = 0;
  applyTheme(theme);
}

function getCurrentTheme() {
  return THEMES[themeIndex];
}

function cycleTheme() {
  themeIndex = (themeIndex + 1) % THEMES.length;
  const theme = THEMES[themeIndex];
  applyTheme(theme);
  sendToBackground({
    type: "SAVE_SETTINGS",
    payload: { theme, apiKey: $("api-key-input")?.value || "", highlightEnabled: true }
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const icons = { auto: "🌓", light: "☀️", dark: "🌙" };
  $("theme-toggle").textContent = icons[theme] || "🌓";
  $("theme-toggle").setAttribute("aria-label", `Theme: ${theme}`);
}

// Helpers
async function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

async function checkCache(url) {
  // We trigger a summarize with cached check via background
  return null; // The background handles cache; we just let summarize run
}

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function friendlyError(code) {
  const messages = {
    NO_API_KEY: "No API key found. Please add your Anthropic API key in settings.",
    INVALID_API_KEY: "Invalid API key. Please check your key in settings.",
    RATE_LIMITED: "You've hit the API rate limit. Please wait a moment and try again.",
    API_OVERLOADED: "The AI service is currently busy. Please try again in a moment.",
    EMPTY_RESPONSE: "Received an empty response from the AI. Please try again."
  };
  return messages[code] || code || "An unexpected error occurred. Please try again.";
}
