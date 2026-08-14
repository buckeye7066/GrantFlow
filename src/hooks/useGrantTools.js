/**
 * GrantWatch-beating grant management hooks:
 * - Saved search filters (persist per user)
 * - View history tracking
 * - Hide/dismiss grants
 * - PDF export of grant details
 * - Boolean search parsing (AND/OR/NOT)
 */

import { useState, useCallback, useMemo } from "react"
import { formatReasonText } from "@/utils/reasonText"

// ── Storage Keys ──────────────────────────────────────────────────────────────

const SAVED_SEARCHES_KEY = "grantflow:saved-searches"
const VIEW_HISTORY_KEY = "grantflow:view-history"
const HIDDEN_GRANTS_KEY = "grantflow:hidden-grants"

// ── Saved Search Filters ──────────────────────────────────────────────────────

function loadFromStorage(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* quota */ }
}

/**
 * Manage saved search filters. Each saved search has:
 * { id, name, filters: { query, state, categories, minScore, ... }, savedAt }
 */
export function useSavedSearches() {
  const [searches, setSearches] = useState(() => loadFromStorage(SAVED_SEARCHES_KEY))

  const saveSearch = useCallback((name, filters) => {
    setSearches((prev) => {
      const next = [
        { id: `ss_${Date.now()}`, name, filters, savedAt: new Date().toISOString() },
        ...prev,
      ].slice(0, 20) // keep max 20
      saveToStorage(SAVED_SEARCHES_KEY, next)
      return next
    })
  }, [])

  const deleteSearch = useCallback((id) => {
    setSearches((prev) => {
      const next = prev.filter((s) => s.id !== id)
      saveToStorage(SAVED_SEARCHES_KEY, next)
      return next
    })
  }, [])

  return { savedSearches: searches, saveSearch, deleteSearch }
}

// ── View History ──────────────────────────────────────────────────────────────

/**
 * Track which grants the user has viewed. Stores:
 * { grantId, title, viewedAt, source }
 */
export function useViewHistory() {
  const [history, setHistory] = useState(() => loadFromStorage(VIEW_HISTORY_KEY))

  const recordView = useCallback((grant) => {
    if (!grant?.id) return
    setHistory((prev) => {
      const filtered = prev.filter((h) => h.grantId !== grant.id)
      const next = [
        { grantId: grant.id, title: grant.title, viewedAt: new Date().toISOString(), source: grant.source },
        ...filtered,
      ].slice(0, 100) // keep last 100
      saveToStorage(VIEW_HISTORY_KEY, next)
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    setHistory([])
    saveToStorage(VIEW_HISTORY_KEY, [])
  }, [])

  const isViewed = useCallback((grantId) => {
    return history.some((h) => h.grantId === grantId)
  }, [history])

  return { viewHistory: history, recordView, clearHistory, isViewed }
}

// ── Hide/Dismiss Grants ───────────────────────────────────────────────────────

/**
 * Let users hide irrelevant grants so they don't clutter results.
 */
export function useHiddenGrants() {
  const [hidden, setHidden] = useState(() => new Set(loadFromStorage(HIDDEN_GRANTS_KEY)))

  const hideGrant = useCallback((grantId) => {
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(grantId)
      saveToStorage(HIDDEN_GRANTS_KEY, [...next])
      return next
    })
  }, [])

  const unhideGrant = useCallback((grantId) => {
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(grantId)
      saveToStorage(HIDDEN_GRANTS_KEY, [...next])
      return next
    })
  }, [])

  const unhideAll = useCallback(() => {
    setHidden(new Set())
    saveToStorage(HIDDEN_GRANTS_KEY, [])
  }, [])

  const isHidden = useCallback((grantId) => hidden.has(grantId), [hidden])

  return { hiddenCount: hidden.size, hideGrant, unhideGrant, unhideAll, isHidden }
}

// ── PDF Export ────────────────────────────────────────────────────────────────

/**
 * Export grant details as a printable PDF using the browser's print dialog.
 * No library dependency — uses a hidden iframe with formatted HTML.
 */
export function exportGrantAsPDF(grant) {
  if (!grant) return

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(grant.title || "Grant Details")}</title>
      <style>
        body { font-family: Georgia, serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
        h1 { font-size: 22px; margin-bottom: 8px; }
        .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
        .section { margin-bottom: 16px; }
        .section h2 { font-size: 16px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 8px; }
        .section p { font-size: 14px; line-height: 1.6; }
        .field { display: flex; gap: 8px; margin-bottom: 4px; font-size: 13px; }
        .field .label { font-weight: bold; min-width: 140px; color: #555; }
        .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #999; }
        ul { padding-left: 20px; }
        li { font-size: 13px; margin-bottom: 4px; }
        @media print { body { margin: 0; } }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(grant.title || "Untitled Grant")}</h1>
      <div class="meta">
        ${[grant.sponsor || grant.funder, grant.state, grant.deadline ? `Deadline: ${grant.deadline}` : null].filter(Boolean).map((part) => escapeHtml(String(part))).join(" &bull; ")}
      </div>

      ${grant.description ? `<div class="section"><h2>Description</h2><p>${escapeHtml(grant.description)}</p></div>` : ""}

      <div class="section">
        <h2>Details</h2>
        ${field("Source", escapeHtml(grant.source || ""))}
        ${field("Sponsor", escapeHtml(grant.sponsor || grant.funder || ""))}
        ${field("State", escapeHtml(grant.state || ""))}
        ${field("Deadline", escapeHtml(grant.deadline || ""))}
        ${field("Deadline Type", escapeHtml(grant.deadline_type || ""))}
        ${field("Amount", escapeHtml([grant.amount_min, grant.amount_max].filter(Boolean).map(n => "$" + Number(n).toLocaleString()).join(" – ") || grant.amount_description || ""))}
        ${field("Type", escapeHtml(grant.opportunity_type || ""))}
        ${field("Application URL", grant.application_url ? `<a href="${escapeHtml(grant.application_url)}">${escapeHtml(grant.application_url)}</a>` : null)}
        ${field("Source URL", grant.source_url ? `<a href="${escapeHtml(grant.source_url)}">${escapeHtml(grant.source_url)}</a>` : null)}
      </div>

      ${grant.eligibility_bullets?.length > 0 ? `
        <div class="section">
          <h2>Eligibility</h2>
          <ul>${(Array.isArray(grant.eligibility_bullets) ? grant.eligibility_bullets : []).map(b => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
        </div>
      ` : ""}

      ${grant.match_reasons?.length > 0 ? `
        <div class="section">
          <h2>Match Reasons</h2>
          <ul>${(Array.isArray(grant.match_reasons) ? grant.match_reasons : []).map(r => {
            const text = formatReasonText(r)
            return text ? `<li>${escapeHtml(text)}</li>` : ""
          }).join("")}</ul>
        </div>
      ` : ""}

      <div class="footer">
        Exported from GrantFlow on ${new Date().toLocaleDateString()} &bull; ${escapeHtml(grant.source_url || "")}
      </div>
    </body>
    </html>
  `

  const iframe = document.createElement("iframe")
  iframe.style.position = "fixed"
  iframe.style.right = "0"
  iframe.style.bottom = "0"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "0"
  document.body.appendChild(iframe)

  iframe.contentWindow.document.open()
  iframe.contentWindow.document.write(html)
  iframe.contentWindow.document.close()

  iframe.contentWindow.focus()
  iframe.contentWindow.print()

  setTimeout(() => document.body.removeChild(iframe), 5000)
}

function escapeHtml(str) {
  if (!str) return ""
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function field(label, value) {
  if (!value) return ""
  return `<div class="field"><span class="label">${escapeHtml(label)}:</span><span>${value}</span></div>`
}

// ── Boolean Search Parser ─────────────────────────────────────────────────────

/**
 * Parse a boolean search query with AND, OR, NOT operators.
 * Examples:
 *   "education AND health" → must contain both
 *   "food OR housing" → must contain either
 *   "grant NOT loan" → must contain "grant", must not contain "loan"
 *   "small business AND (food OR catering)" → supports grouping
 *
 * Returns a filter function that takes a text string and returns true/false.
 */
export function parseBooleanQuery(query) {
  if (!query || typeof query !== "string") return () => true

  const trimmed = query.trim()
  if (!trimmed) return () => true

  // Check if the query uses boolean operators
  const hasBooleanOps = /\b(AND|OR|NOT)\b/i.test(trimmed)
  if (!hasBooleanOps) {
    // Simple keyword search — all words must appear
    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
    return (text) => {
      const lower = String(text || "").toLowerCase()
      return words.every((w) => lower.includes(w))
    }
  }

  // Tokenize: keywords (AND/OR/NOT), parentheses, and terms
  const rawTokens = trimmed
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const upper = t.toUpperCase()
      if (upper === "AND" || upper === "OR" || upper === "NOT") {
        return { type: "op", value: upper }
      }
      if (t === "(") return { type: "lparen" }
      if (t === ")") return { type: "rparen" }
      return { type: "term", value: t.toLowerCase() }
    })

  // Insert implicit AND between consecutive operands (e.g., "small business")
  const tokens = []
  for (let i = 0; i < rawTokens.length; i++) {
    tokens.push(rawTokens[i])
    const curr = rawTokens[i]
    const next = rawTokens[i + 1]
    if (!next) continue
    const currIsOperand = curr.type === "term" || curr.type === "rparen"
    const nextStartsOperand =
      next.type === "term" || next.type === "lparen" || (next.type === "op" && next.value === "NOT")
    if (currIsOperand && nextStartsOperand) {
      tokens.push({ type: "op", value: "AND" })
    }
  }

  let pos = 0

  // Recursive descent parser with precedence: NOT > AND > OR
  function parseOr() {
    let node = parseAnd()
    while (pos < tokens.length && tokens[pos].type === "op" && tokens[pos].value === "OR") {
      pos++
      node = { type: "or", left: node, right: parseAnd() }
    }
    return node
  }

  function parseAnd() {
    let node = parseNot()
    while (pos < tokens.length && tokens[pos].type === "op" && tokens[pos].value === "AND") {
      pos++
      node = { type: "and", left: node, right: parseNot() }
    }
    return node
  }

  function parseNot() {
    if (pos < tokens.length && tokens[pos].type === "op" && tokens[pos].value === "NOT") {
      pos++
      return { type: "not", child: parseNot() }
    }
    return parsePrimary()
  }

  function parsePrimary() {
    if (pos >= tokens.length) return null
    const tok = tokens[pos]
    if (tok.type === "lparen") {
      pos++
      const node = parseOr()
      if (pos < tokens.length && tokens[pos].type === "rparen") {
        pos++
      }
      return node
    }
    if (tok.type === "rparen") {
      return null
    }
    if (tok.type === "op") {
      // Operator where a term is expected — treat as a literal term
      pos++
      return { type: "term", value: tok.value.toLowerCase() }
    }
    pos++
    return { type: "term", value: tok.value }
  }

  const ast = parseOr()

  function evaluate(node, text) {
    if (!node) return true
    switch (node.type) {
      case "term":
        return text.includes(node.value)
      case "not":
        return !evaluate(node.child, text)
      case "and":
        return evaluate(node.left, text) && evaluate(node.right, text)
      case "or":
        return evaluate(node.left, text) || evaluate(node.right, text)
      default:
        return true
    }
  }

  return (text) => {
    const lower = String(text || "").toLowerCase()
    return evaluate(ast, lower)
  }
}
