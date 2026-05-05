/**
 * PageLens Content Script
 * Extracts clean readable content from the current page.
 * Also handles highlight injection when requested.
 */

// ─── Message Listener 
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === "EXTRACT_CONTENT") {
    try {
      const extracted = extractPageContent();
      sendResponse({ success: true, data: extracted });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false; // Synchronous response
  }

  if (message.type === "HIGHLIGHT_KEYWORDS") {
    try {
      highlightKeywords(message.payload.keywords || []);
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  }

  if (message.type === "REMOVE_HIGHLIGHTS") {
    try {
      removeHighlights();
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  }
});

// ─── Content Extraction 
function extractPageContent() {
  const title = document.title || "";
  const url = window.location.href;

  // Try to find the main article content using heuristics
  const mainContent = findMainContent();
  const text = cleanText(mainContent);
  const wordCount = countWords(text);

  return { title, url, content: text, wordCount };
}

function findMainContent() {
  // Priority order of content selectors (most specific first)
  const contentSelectors = [
    "article[role='main']",
    "main article",
    "[role='main'] article",
    "article.post-content",
    "article.article-body",
    ".article-content",
    ".article-body",
    ".post-content",
    ".post-body",
    ".entry-content",
    ".story-body",
    ".content-body",
    ".blog-post",
    ".main-content",
    "article",
    "[role='main']",
    "main",
    ".content",
    "#content",
    "#main"
  ];

  for (const selector of contentSelectors) {
    const el = document.querySelector(selector);
    if (el && getTextLength(el) > 200) {
      return el;
    }
  }

  // Fallback: find the element with the most paragraph text
  return findContentByDensity();
}

function findContentByDensity() {
  const candidates = document.querySelectorAll("div, section, article");
  let best = document.body;
  let bestScore = 0;

  for (const el of candidates) {
    // Skip tiny elements and common non-content areas
    if (shouldSkipElement(el)) continue;

    const paragraphs = el.querySelectorAll("p");
    if (paragraphs.length < 2) continue;

    // Score: paragraph count × avg paragraph length
    let totalText = 0;
    for (const p of paragraphs) {
      totalText += p.textContent.trim().length;
    }
    const score = paragraphs.length * (totalText / paragraphs.length);

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function shouldSkipElement(el) {
  const skipTags = new Set(["HEADER", "FOOTER", "NAV", "ASIDE", "SCRIPT", "STYLE", "NOSCRIPT"]);
  const skipClasses = ["header", "footer", "nav", "navigation", "sidebar", "menu", "ad", "advertisement", "cookie", "popup", "modal", "banner"];
  const skipIds = ["header", "footer", "nav", "navigation", "sidebar", "menu", "cookie", "popup"];

  if (skipTags.has(el.tagName)) return true;

  const cls = el.className?.toLowerCase() || "";
  const id = el.id?.toLowerCase() || "";

  return (
    skipClasses.some((s) => cls.includes(s)) ||
    skipIds.some((s) => id.includes(s))
  );
}

function getTextLength(el) {
  return el.textContent?.trim().length || 0;
}

function cleanText(el) {
  if (!el) return "";

  // Clone to avoid mutating the DOM
  const clone = el.cloneNode(true);

  // Remove noise elements
  const removeSelectors = [
    "script", "style", "noscript", "iframe",
    "header", "footer", "nav", "aside",
    ".ad", ".ads", ".advertisement", ".social-share",
    ".comments", ".comment-section", ".related-posts",
    ".newsletter", ".subscribe", ".cookie-notice",
    "[aria-hidden='true']", ".visually-hidden", ".sr-only"
  ];

  for (const sel of removeSelectors) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // Extract text preserving some structure
  const text = extractStructuredText(clone);
  return text.replace(/\s{3,}/g, "\n\n").trim();
}

function extractStructuredText(el) {
  let result = "";
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) result += t + " ";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    const blockTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "td", "th", "figcaption"]);

    if (blockTags.has(tag)) result += "\n";

    for (const child of node.childNodes) walk(child);

    if (blockTags.has(tag)) result += "\n";
  };
  walk(el);
  return result;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Keyword Highlighting 
const HIGHLIGHT_CLASS = "pagelens-highlight";
const HIGHLIGHT_STYLE_ID = "pagelens-highlight-styles";

function highlightKeywords(keywords) {
  removeHighlights(); // Clean up any existing highlights

  if (!keywords.length) return;

  // Inject styles
  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    // Sanitize: no user input goes into CSS
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        background: linear-gradient(120deg, rgba(255, 213, 79, 0.5) 0%, rgba(255, 183, 3, 0.4) 100%);
        border-radius: 2px;
        padding: 1px 2px;
        transition: background 0.2s;
      }
      .${HIGHLIGHT_CLASS}:hover {
        background: rgba(255, 183, 3, 0.7);
      }
    `;
    document.head.appendChild(style);
  }

  // Build a safe regex from keywords
  const escapedKeywords = keywords
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((k) => k.length > 2) // skip very short words
    .join("|");

  if (!escapedKeywords) return;

  const regex = new RegExp(`\\b(${escapedKeywords})\\b`, "gi");

  // Walk text nodes and wrap matches
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        // Skip scripts, styles, already highlighted
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (["script", "style", "noscript", "textarea", "input"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.classList.contains(HIGHLIGHT_CLASS)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodesToProcess = [];
  while (walker.nextNode()) {
    if (regex.test(walker.currentNode.textContent)) {
      nodesToProcess.push(walker.currentNode);
    }
    regex.lastIndex = 0;
  }

  for (const textNode of nodesToProcess) {
    wrapMatches(textNode, regex);
    regex.lastIndex = 0;
  }
}

function wrapMatches(textNode, regex) {
  const text = textNode.textContent;
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match;

  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    // Highlighted match
    const mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    mark.textContent = match[0]; // Safe: textContent, not innerHTML
    fragment.appendChild(mark);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex === 0) return; // No matches found

  // Text after last match
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  textNode.parentNode.replaceChild(fragment, textNode);
}

function removeHighlights() {
  const marks = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }

  // Remove style tag
  document.getElementById(HIGHLIGHT_STYLE_ID)?.remove();
}
