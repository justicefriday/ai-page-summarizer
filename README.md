# PageLens — AI Page Summarizer Chrome Extension

> Instantly summarize any webpage with AI. Get bullet-point summaries, key insights, reading time estimates, and keyword highlighting — all from a clean, polished popup.

![PageLens Extension](icons/icon128.png)

---

## ✨ Features

- **One-click summarization** — Extracts and analyzes page content instantly
- **Structured output** — One-liner overview, bullet key points, deeper insights
- **Reading metadata** — Estimated read time + word count
- **Content classification** — Detects article type and sentiment
- **Keyword tags** — Extracted topics displayed as chips
- **In-page highlighting** — Highlights keyword matches directly on the page
- **Copy to clipboard** — One-click copy of the full summary
- **Smart caching** — Summaries cached per URL for 1 hour (no duplicate API calls)
- **Dark / Light / Auto theme** — Cycles with one click
- **Graceful error handling** — Clear messages for API failures, empty pages, etc.
- **Keyboard accessible** — Full focus states and ARIA labels throughout

---

## 🚀 Setup Instructions

### Prerequisites

- Google Chrome (or Chromium-based browser)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

### Installation (Local / Developer Mode)

1. **Download or clone this repository**

   ```bash
   git clone https://github.com/your-username/ai-page-summarizer.git
   cd ai-page-summarizer
   ```

2. **Open Chrome Extensions page**

   Navigate to `chrome://extensions` in your browser.

3. **Enable Developer Mode**

   Toggle the **Developer mode** switch in the top-right corner.

4. **Load the unpacked extension**

   Click **"Load unpacked"** and select the `ai-page-summarizer` folder (the one containing `manifest.json`).

5. **Pin the extension** (optional but recommended)

   Click the puzzle piece icon in the Chrome toolbar and pin **PageLens**.

6. **Add your API key**

   - Click the PageLens icon in the toolbar
   - Click the ⚙️ settings icon
   - Paste your Anthropic API key (`sk-ant-api03-…`)
   - Click **Save Settings**

7. **Summarize any page**

   Navigate to any article, blog post, or documentation page and click **"Summarize Page"**.

---

## 🏗 Architecture

```
ai-page-summarizer/
├── manifest.json          # Extension manifest (MV3)
├── popup.html             # Extension popup UI
├── popup.css              # All popup styles (CSS variables, themes)
├── icons/                 # Extension icons (16, 32, 48, 128px)
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js      # Service worker — AI calls, caching, settings
    ├── content.js         # Content script — extraction, highlighting
    └── popup.js           # Popup controller — orchestration, rendering
```

### Component Roles

| File | Responsibility |
|------|----------------|
| `manifest.json` | Declares permissions, registers scripts, defines popup |
| `popup.html/css` | User interface — views for main, result, settings, error |
| `popup.js` | Popup controller: triggers extraction, calls background, renders output |
| `background.js` | Service worker: holds API key, makes Anthropic requests, manages cache |
| `content.js` | Runs on every tab: extracts readable text, applies keyword highlights |

### Message Flow

```
User clicks "Summarize"
        │
        ▼
popup.js → chrome.tabs.sendMessage("EXTRACT_CONTENT")
        │
        ▼
content.js extracts readable text → returns {content, title, wordCount, url}
        │
        ▼
popup.js → chrome.runtime.sendMessage("SUMMARIZE_PAGE", payload)
        │
        ▼
background.js checks cache → (hit) returns cached summary
                           → (miss) calls Anthropic API
        │
        ▼
background.js → response → popup.js renders summary
        │
        ▼ (optional)
popup.js → chrome.tabs.sendMessage("HIGHLIGHT_KEYWORDS")
        │
        ▼
content.js walks DOM text nodes, wraps matches in <mark> elements
```

---

## 🤖 AI Integration

### Provider

**Anthropic Claude** (`claude-sonnet-4-20250514`) via the Messages API.

### Why Anthropic?

- Consistent, structured JSON output from natural language prompts
- High-quality summarization with nuanced insights
- Reliable response format

### Prompt Design

The prompt instructs Claude to return a strict JSON object:

```json
{
  "oneLiner": "...",
  "bullets": ["...", "..."],
  "insights": ["...", "..."],
  "sentiment": "positive|neutral|negative|mixed",
  "contentType": "article|tutorial|news|product|documentation|other",
  "keywords": ["...", "..."]
}
```

Content is truncated to ~12,000 characters to stay within a reasonable context window and keep costs low.

---

## 🔐 Security Decisions

### API Key Storage

- The API key is stored **exclusively** in `chrome.storage.local` (encrypted by Chrome, local to the device)
- The key is **only accessed in `background.js`** (the service worker)
- It is **never passed to the content script** or accessible from page context
- The popup requests settings from background via message passing — it never reads the key directly

### XSS Prevention

- All AI-generated text is inserted via `.textContent` — never `.innerHTML`
- Keyword highlights use `document.createTextNode()` and element `.textContent`, never string interpolation into HTML
- The background sanitizes all string fields returned from the AI before caching
- CSS for highlights is a hardcoded style tag — no user input enters CSS

### Content Script Isolation

- Content scripts run in an isolated world — they cannot access page JavaScript globals
- Message passing validates `sender.id === chrome.runtime.id`
- The `EXTRACT_CONTENT` handler is purely synchronous with no async side effects

### Minimal Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Access current tab URL/title on user action only |
| `storage` | Store API key and cached summaries locally |
| `scripting` | Inject content script dynamically if needed |
| `https://api.anthropic.com/*` | Only host permission — no broad `<all_urls>` for API |

---

## ⚖️ Trade-offs

| Decision | Trade-off |
|----------|-----------|
| **Direct browser → Anthropic API** | No proxy server needed (simpler setup), but requires `anthropic-dangerous-direct-browser-api-access` header. A production app would use a proxy to hide the key entirely. |
| **Content truncation at 12k chars** | Keeps costs and latency low; may miss content on very long pages |
| **1-hour cache TTL** | Balances API cost vs. staleness for frequently updated pages |
| **Heuristic content extraction** | Works well for 90%+ of article pages; complex SPAs or paywalled sites may yield less content than a full Readability.js integration |
| **Single-model approach** | Simpler but not user-configurable; advanced users can't switch to Haiku for cost savings |

---

## 🛠 Development Notes

- No build step required — plain HTML/CSS/JS, loads directly
- No npm dependencies — zero supply chain risk
- Manifest V3 compliant — no deprecated background pages
- Content script uses `NodeFilter` + `TreeWalker` for efficient DOM traversal

---

## 📄 License

MIT License — free to use, modify, and distribute.
