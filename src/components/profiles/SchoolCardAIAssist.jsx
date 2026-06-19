/* eslint-disable react-refresh/only-export-components */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/api/client";
// The pure mapping/merge logic lives in a sibling .js file so Node's
// --test runner (which doesn't transform JSX) can import it directly in
// unit tests. We re-export it here so existing call sites stay unchanged.
import { mapAIDataToApplicationPatch as _mapAIDataToApplicationPatch } from "./schoolCardAIAssistPatch.js";
export const mapAIDataToApplicationPatch = _mapAIDataToApplicationPatch;

const FIELD_KEYS = [
  { key: "acceptanceRate", label: "ACCEPTANCE RATE" },
  { key: "avgGPA", label: "AVG GPA" },
  { key: "satRange", label: "SAT RANGE" },
  { key: "tuition", label: "TUITION" },
  { key: "fafsaCode", label: "FAFSA CODE" },
  { key: "applicationType", label: "APPLICATION TYPE" },
  { key: "graduationRate", label: "GRADUATION RATE" },
  { key: "studentTeacher", label: "STUDENT/TEACHER" },
  { key: "avgClassSize", label: "AVG CLASS SIZE" },
  { key: "estCost", label: "EST. COST" },
];

const EXTRA_FIELDS = [
  { key: "enrollment", label: "ENROLLMENT" },
  { key: "founded", label: "FOUNDED" },
  { key: "type", label: "TYPE" },
  { key: "setting", label: "SETTING" },
  { key: "mascot", label: "MASCOT" },
  { key: "cheerLine", label: "CHEER" },
  { key: "primaryColor", label: "PRIMARY COLOR" },
  { key: "secondaryColor", label: "SECONDARY COLOR" },
];

// Portal URL keys the AI now also returns. Mapped onto application.portals.*
// by mapAIDataToApplicationPatch. They're tracked separately so the UI can
// render them as link buttons rather than table cells.
const PORTAL_FIELDS = [
  { key: "websiteUrl",      target: "website_url",                  label: "WEBSITE" },
  { key: "admissionsUrl",   target: "portals.admissions_url",       label: "ADMISSIONS" },
  { key: "financialAidUrl", target: "portals.financial_aid_url",    label: "FINANCIAL AID" },
  { key: "scholarshipsUrl", target: "portals.scholarship_url",      label: "SCHOLARSHIPS" },
  { key: "housingUrl",      target: "portals.housing_url",          label: "HOUSING" },
  { key: "studentPortalUrl",target: "portals.student_portal_url",   label: "STUDENT PORTAL" },
];

const ALL_FIELDS = [...FIELD_KEYS, ...EXTRA_FIELDS, ...PORTAL_FIELDS];

function SparkleIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.912 5.813a2 2 0 001.275 1.275L21 12l-5.813 1.912a2 2 0 00-1.275 1.275L12 21l-1.912-5.813a2 2 0 00-1.275-1.275L3 12l5.813-1.912a2 2 0 001.275-1.275L12 3z" />
    </svg>
  );
}

function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Spinner({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: "school-ai-spin 1s linear infinite" }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="50 20" strokeLinecap="round" />
    </svg>
  );
}

function PulsingDot() {
  return (
    <span style={{
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: "#f59e0b",
      animation: "school-ai-pulse 1.2s ease-in-out infinite",
      marginRight: 6,
      verticalAlign: "middle",
    }} />
  );
}

// mapAIDataToApplicationPatch is re-exported from ./schoolCardAIAssistPatch.js
// at the top of this module. The .jsx file keeps only the React UI; the pure
// mapping/merge logic lives in the .js sibling so unit tests can import it
// directly under Node's --test runner (which doesn't transform JSX).

/**
 * Hook for AI-assisted school data lookup.
 * Returns { status, log, runLookup, reset }.
 */
export function useSchoolAIAssist() {
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [data, setData] = useState(null);

  const runLookup = useCallback(async (schoolName) => {
    if (!schoolName) return null;
    setStatus("loading");
    setLog(["Searching for school data..."]);
    setData(null);

    try {
      const response = await apiFetch("/api/ai/school-lookup", {
        method: "POST",
        body: JSON.stringify({ school_name: schoolName }),
      });

      if (!response?.success || !response?.data) {
        throw new Error(response?.error || "No data returned");
      }

      setLog((prev) => [...prev, "AI response received, parsing..."]);

      const parsed = response.data;
      const entries = Object.entries(parsed).filter(([, v]) => v && v !== "—");

      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        const label =
          FIELD_KEYS.find((f) => f.key === key)?.label ||
          EXTRA_FIELDS.find((f) => f.key === key)?.label ||
          key;
        await new Promise((r) => setTimeout(r, 120));
        setLog((prev) => [...prev, `✓ ${label}: ${value}`]);
      }

      setData(parsed);
      setStatus("done");
      setLog((prev) => [...prev, "All available data populated."]);
      return parsed;
    } catch (err) {
      console.error("[SchoolAIAssist]", err);
      setStatus("error");
      setLog((prev) => [...prev, `Error: ${err.message}. Please try again.`]);
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setLog([]);
    setData(null);
  }, []);

  return { status, log, data, runLookup, reset };
}

/**
 * Standalone SchoolCard component with AI Assist functionality.
 * Can be used independently or within the university applications flow.
 */
export function SchoolCard({ school, index = 0 }) {
  const [fields, setFields] = useState(() => {
    const init = {};
    FIELD_KEYS.forEach((f) => {
      init[f.key] = f.key === "applicationType" ? school.applicationType || school.application_type || "—" : "—";
    });
    EXTRA_FIELDS.forEach((f) => { init[f.key] = "—"; });
    return init;
  });
  const [status, setStatus] = useState("idle");
  const [log, setLog] = useState([]);
  const [filledKeys, setFilledKeys] = useState(new Set());
  const [showExtra, setShowExtra] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const schoolName = school.name || school.school_name || "Unknown School";
  const interests = school.interests || [];

  const runAIAssist = async () => {
    setStatus("loading");
    setLog(["Searching for school data..."]);
    setFilledKeys(new Set());

    try {
      const response = await apiFetch("/api/ai/school-lookup", {
        method: "POST",
        body: JSON.stringify({ school_name: schoolName }),
      });

      if (!response?.success || !response?.data) {
        throw new Error(response?.error || "No data returned");
      }

      const parsed = response.data;
      setLog((prev) => [...prev, "Data found! Populating fields..."]);

      let delay = 0;
      for (const f of ALL_FIELDS) {
        if (f.key === "applicationType") continue;
        if (parsed[f.key] && parsed[f.key] !== "—") {
          delay += 180;
          ((k, v, d) => {
            setTimeout(() => {
              setFields((prev) => ({ ...prev, [k]: v }));
              setFilledKeys((prev) => new Set([...prev, k]));
              setLog((prev) => [
                ...prev,
                `✓ ${FIELD_KEYS.find((x) => x.key === k)?.label || EXTRA_FIELDS.find((x) => x.key === k)?.label}: ${v}`,
              ]);
            }, d);
          })(f.key, parsed[f.key], delay);
        }
      }

      setTimeout(() => {
        setStatus("done");
        setShowExtra(true);
        setLog((prev) => [...prev, "All available data populated."]);
      }, delay + 300);
    } catch (err) {
      console.error(err);
      setStatus("error");
      setLog((prev) => [...prev, `Error: ${err.message}. Please try again.`]);
    }
  };

  const fieldValue = (key) => fields[key];
  const isNewlyFilled = (key) => filledKeys.has(key);

  return (
    <div style={{
      background: "#fff",
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      overflow: "hidden",
      marginBottom: 24,
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      animationDelay: `${index * 120}ms`,
      animation: "school-ai-fadeSlideIn 0.5s ease both",
    }}>
      <div style={{
        padding: "20px 24px 16px",
        borderBottom: "1px solid #f3f4f6",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#1a1a2e", fontFamily: "'DM Sans', sans-serif" }}>
              {schoolName}
            </h2>
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "3px 10px",
              borderRadius: 6,
              background: "#fef3c7",
              color: "#92400e",
            }}>Planning</span>
            <span style={{
              fontSize: 11,
              fontWeight: 500,
              padding: "3px 10px",
              borderRadius: 6,
              background: "#f0f0f5",
              color: "#6b7280",
            }}>university</span>
          </div>
          <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>App Deadline: —</span>
            <span>Aid Deadline: —</span>
            <span>Decision: —</span>
            <span>Application Fee: $0</span>
          </div>
        </div>

        <AIAssistButton status={status} onClick={runAIAssist} />
      </div>

      <div style={{ padding: "16px 24px 20px", display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 340px", minWidth: 280 }}>
          <h3 style={{
            fontSize: 13,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "#6b7280",
            marginBottom: 12,
            fontFamily: "'DM Sans', sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}>
            <span style={{ fontSize: 15 }}>🏫</span> Admissions Snapshot
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 20px" }}>
            {FIELD_KEYS.map((f) => (
              <FieldCell key={f.key} label={f.label} value={fieldValue(f.key)} highlight={isNewlyFilled(f.key)} />
            ))}
          </div>

          {showExtra && (
            <div style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px dashed #e5e7eb",
              animation: "school-ai-fadeSlideIn 0.4s ease both",
            }}>
              <h4 style={{
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#f59e0b",
                marginBottom: 8,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}>
                <SparkleIcon size={12} /> Additional AI-Discovered Info
              </h4>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 20px" }}>
                {EXTRA_FIELDS.map((f) => (
                  <FieldCell key={f.key} label={f.label} value={fieldValue(f.key)} highlight={isNewlyFilled(f.key)} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 260px", minWidth: 220 }}>
          {interests.length > 0 && (
            <>
              <h3 style={{
                fontSize: 13,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#6b7280",
                marginBottom: 10,
                fontFamily: "'DM Sans', sans-serif",
              }}>Interests</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                {interests.map((i) => (
                  <span key={i} style={{
                    fontSize: 12,
                    fontWeight: 500,
                    padding: "4px 12px",
                    borderRadius: 20,
                    background: "#f3f4f6",
                    color: "#374151",
                  }}>{i}</span>
                ))}
              </div>
            </>
          )}

          <AIAssistLog status={status} log={log} logRef={logRef} />
        </div>
      </div>
    </div>
  );
}

/**
 * Inline AI Assist button — can be embedded in existing ApplicationCard.
 */
export function AIAssistButton({ status, onClick, className = "" }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      disabled={status === "loading"}
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "9px 18px",
        borderRadius: 10,
        border: "none",
        cursor: status === "loading" ? "wait" : "pointer",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "'DM Sans', sans-serif",
        transition: "all 0.25s ease",
        flexShrink: 0,
        background: status === "done"
          ? "linear-gradient(135deg, #059669, #10b981)"
          : status === "error"
          ? "linear-gradient(135deg, #dc2626, #ef4444)"
          : "linear-gradient(135deg, #f59e0b, #f97316)",
        color: "#fff",
        boxShadow: status === "loading"
          ? "0 0 0 3px rgba(245,158,11,0.2)"
          : "0 2px 8px rgba(245,158,11,0.25)",
        transform: status === "loading" ? "scale(0.97)" : "scale(1)",
      }}
      onMouseEnter={(e) => { if (status !== "loading") e.currentTarget.style.transform = "scale(1.03)"; }}
      onMouseLeave={(e) => { if (status !== "loading") e.currentTarget.style.transform = "scale(1)"; }}
    >
      {status === "loading" ? <Spinner size={15} /> : status === "done" ? <CheckIcon /> : <SparkleIcon size={15} />}
      {status === "loading" ? "Searching..." : status === "done" ? "Data Found" : status === "error" ? "Retry AI Assist" : "AI Assist"}
    </button>
  );
}

/**
 * AI Assist log panel — shows progress of the AI lookup.
 */
export function AIAssistLog({ status, log, logRef }) {
  if (status === "idle") return null;

  return (
    <div style={{
      background: "#fafaf9",
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: 12,
      animation: "school-ai-fadeSlideIn 0.3s ease both",
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "#9ca3af",
        marginBottom: 8,
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}>
        {status === "loading" && <PulsingDot />}
        AI Assist Log
      </div>
      <div
        ref={logRef}
        style={{
          maxHeight: 160,
          overflowY: "auto",
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          color: "#6b7280",
          lineHeight: 1.7,
        }}
      >
        {log.map((l, i) => (
          <div key={i} style={{
            animation: "school-ai-fadeSlideIn 0.25s ease both",
            color: l.startsWith("✓") ? "#059669" : l.startsWith("Error") ? "#dc2626" : "#6b7280",
          }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function FieldCell({ label, value, highlight }) {
  return (
    <div style={{ padding: "8px 0", transition: "all 0.4s ease" }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: "#9ca3af",
        marginBottom: 2,
      }}>{label}</div>
      <div style={{
        fontSize: 14,
        fontWeight: value === "—" ? 400 : 600,
        color: value === "—" ? "#d1d5db" : "#1a1a2e",
        transition: "all 0.4s ease",
        display: "flex",
        alignItems: "center",
        gap: 5,
      }}>
        {highlight && (
          <span style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#10b981",
            animation: "school-ai-pulse 1.5s ease-in-out 1",
            flexShrink: 0,
          }} />
        )}
        <span style={{
          animation: highlight ? "school-ai-fadeSlideIn 0.3s ease both" : "none",
        }}>{value}</span>
      </div>
    </div>
  );
}

/**
 * CSS keyframes injector — call once at app level or let SchoolCard handle it.
 */
export function SchoolAIAssistStyles() {
  return (
    <style>{`
      @keyframes school-ai-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes school-ai-fadeSlideIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes school-ai-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.4); }
      }
    `}</style>
  );
}

export { FIELD_KEYS, EXTRA_FIELDS };
