// exportFromBase44.js
// Run with: node exportFromBase44.js

const fs = require("fs");
const path = require("path");

// ======================================
// CONFIG
// ======================================

const CONFIG = {
  baseUrl: (process.env.BASE44_BASE_URL || "https://YOUR-PROJECT-FUNCTIONS-URL").trim(),
  bearerToken: process.env.BASE44_BEARER_TOKEN || null,
  cookie: process.env.BASE44_AUTH_COOKIE || null,
  requestTimeoutMs: 60_000,
};

function validateConfig() {
  if (!CONFIG.baseUrl || CONFIG.baseUrl.includes("YOUR-PROJECT-FUNCTIONS-URL")) {
    console.error(
      "\nERROR: Please set BASE44_BASE_URL (env var) or update CONFIG.baseUrl with your project functions URL.\n",
    );
    process.exit(1);
  }

  if (!CONFIG.bearerToken && !CONFIG.cookie) {
    console.warn(
      "⚠️  No authentication headers configured. Set BASE44_BEARER_TOKEN or BASE44_AUTH_COOKIE if your deployment requires auth.\n",
    );
  }
}

function buildAuthHeaders() {
  const headers = {};
  if (CONFIG.bearerToken) {
    headers.Authorization = `Bearer ${CONFIG.bearerToken}`;
  }
  if (CONFIG.cookie) {
    headers.Cookie = CONFIG.cookie;
  }
  return headers;
}

// ======================================
// HTTP CLIENT
// ======================================

async function call(fnName, body = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    const response = await fetch(`${CONFIG.baseUrl.replace(/\/+$/, "")}/${fnName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }
      console.error(`Error calling "${fnName}" [${response.status}]:`, payload);
      throw new Error(`Request failed with status ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    const message = error.name === "AbortError" ? "Request timed out" : error.message;
    console.error(`Error calling "${fnName}":`, message);
    throw error;
  }
}

// ======================================
// LOCAL WRITE HELPERS
// ======================================

function writeLocal(relativePath, content) {
  const fullPath = path.resolve(__dirname, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  console.log("Wrote:", relativePath);
}

function sanitizeFileName(name) {
  return String(name).replace(/[/\\?%*:|"<>]/g, "_");
}

// ======================================
// EXPORTERS
// ======================================

async function exportBackendFunctions() {
  console.log("=== EXPORTING BACKEND FUNCTIONS ===");
  const response = await call("getAllFunctionCodes");
  const fnList = Array.isArray(response?.data?.functions) ? response.data.functions : [];

  if (!fnList.length) {
    console.warn("No functions returned by getAllFunctionCodes.");
    return;
  }

  for (const fnName of fnList) {
    if (!fnName) continue;

    try {
      const data = await call("getFunctionCode", { functionName: fnName });
      const code = data?.data?.code;
      if (code && code.trim().length > 0) {
        const safeName = sanitizeFileName(fnName);
        writeLocal(`functions/${safeName}.js`, code);
      } else {
        console.warn(`⚠️  Empty code returned for function "${fnName}". Skipping.`);
      }
    } catch (error) {
      console.error(`Failed to export function "${fnName}". Continuing...`, error.message);
    }
  }
}

function wrapSnapshot(content) {
  return `module.exports = ${JSON.stringify(String(content))};\n`;
}

async function exportFrontendSnapshot() {
  console.log("\n=== EXPORTING FRONTEND SNAPSHOT ===");
  const front = await call("getFrontendSnapshot");
  const snapshot = front?.snapshot && typeof front.snapshot === "object" ? front.snapshot : front;

  if (!snapshot || typeof snapshot !== "object") {
    console.warn("No snapshot payload received from getFrontendSnapshot.");
    return;
  }

  for (const [name, content] of Object.entries(snapshot)) {
    if (!content || String(content).trim().length === 0) continue;
    const safeName = sanitizeFileName(name);
    writeLocal(`ui/${safeName}.js`, wrapSnapshot(content));
  }
}

// ======================================
// MAIN
// ======================================

async function main() {
  validateConfig();
  await exportBackendFunctions();
  await exportFrontendSnapshot();
  console.log("\n=== EXPORT COMPLETE ===");
}

main().catch((error) => {
  console.error("\nEXPORT FAILED:", error);
  process.exitCode = 1;
});

