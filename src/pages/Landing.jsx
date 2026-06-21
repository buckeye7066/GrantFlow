/**
 * Landing — the public "Funding Current" marketing page.
 *
 * This brings the approved mockup (design/grantflow-landing.html) into the live
 * app. It is a PUBLIC, unauthenticated route (/welcome) mounted above the gated
 * Layout — it does NOT change where authenticated users land.
 *
 * Design identity (reused tokens, all already live on main):
 *   - Tailwind `current-*` colors (emerald=ready, amber=awarded, coral=needs-you)
 *   - `font-display` (Bricolage Grotesque), `money` / `font-mono-money` (Space Mono)
 *   - <StatusDot> for the status-language dots
 *
 * The signature motif is the "funding current": scattered sources (a grant,
 * TN HOPE, SNAP, FAFSA, a vehicle grant) drift into a flowing pipeline that
 * tallies a mono $ total and exits as an amber "awarded" chip. All motion is
 * guarded by prefers-reduced-motion (the keyframes are gated with @media in the
 * scoped style block, and interactive affordances use motion-reduce: utilities).
 */

import React from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { StatusDot } from "@/components/ui/StatusDot"
import { Money } from "@/components/ui/Money"

// Scoped, prefers-reduced-motion-aware keyframes for the funding-current motif.
// Tailwind's config is owned elsewhere (do-not-edit), so the two bespoke
// animations live here in a component-scoped <style> tag. Everything degrades to
// a static layout when motion is reduced.
const MOTIF_CSS = `
.fc-src { animation: fc-drift 6s ease-in-out infinite; }
.fc-src:nth-child(2) { animation-delay: .6s; }
.fc-src:nth-child(3) { animation-delay: 1.2s; }
.fc-src:nth-child(4) { animation-delay: 1.8s; }
.fc-src:nth-child(5) { animation-delay: 2.4s; }
@keyframes fc-drift { 0%,100% { transform: translateX(0); } 50% { transform: translateX(4px); } }
.fc-pipe::before {
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(180deg, transparent 0 16px, rgba(255,255,255,.08) 16px 17px);
  animation: fc-flow 1.1s linear infinite;
}
@keyframes fc-flow { to { transform: translateY(17px); } }
@media (prefers-reduced-motion: reduce) {
  .fc-src, .fc-pipe::before { animation: none !important; }
}
`

const SOURCES = [
  { tag: "grant", label: "USDA Rural Facilities" },
  { tag: "schol", label: "TN HOPE" },
  { tag: "benefit", label: "SNAP" },
  { tag: "form", label: "FAFSA" },
  { tag: "item", label: "Vehicle grant" },
]

const STEPS = [
  {
    k: "find",
    h: "It already knows what fits",
    p: "Tailored to who you are and where you live — a TN student sees TN aid; a nonprofit needing a van sees real vehicle grants. No noise, nothing out of state.",
  },
  {
    k: "track",
    h: "Your pipeline, in dollars",
    p: null, // rendered with inline mono spans below
  },
  {
    k: "win",
    h: "Hamilton does the applying",
    p: "It signs in to your portals and fills the applications. You just approve the 2FA. Mail-only funders get a ready-to-send packet.",
  },
]

const PORTALS = [
  { tone: "ready", name: "Middle Tennessee State University", status: "Ready" },
  { tone: "ready", name: "FAFSA — studentaid.gov", status: "Ready" },
  { tone: "needs", name: "AcademicWorks scholarships", status: "Needs login" },
  { tone: "needs", name: "TN SNAP / benefits", status: "Needs login" },
]

const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-full bg-current-emerald px-5 py-2.5 text-[15px] font-semibold text-white shadow-[0_1px_0_#0c5236,0_10px_24px_-12px_rgba(22,121,78,.7)] transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"

const ghostBtn =
  "inline-flex items-center justify-center gap-2 rounded-full border border-current-line bg-transparent px-5 py-2.5 text-[15px] font-semibold text-current-ink transition-colors hover:border-current-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2"

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="relative inline-block h-[22px] w-[22px] rounded-md bg-gradient-to-br from-current-emerald to-current-sage"
    >
      <span className="absolute inset-y-[6px] left-1 right-1 -skew-x-12 border-b-2 border-l-2 border-current-paper" />
    </span>
  )
}

export default function Landing() {
  return (
    <div className="min-h-screen scroll-smooth bg-current-paper font-sans text-current-ink antialiased">
      <style>{MOTIF_CSS}</style>

      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-current-line bg-current-paper/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-6">
          <div className="flex items-center gap-2.5 font-display text-[20px] font-extrabold tracking-[-0.01em]">
            <BrandMark />
            GrantFlow
          </div>
          <nav className="hidden items-center gap-6 text-[15px] md:flex">
            <a href="#how" className="opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2">
              How it works
            </a>
            <a href="#breadth" className="opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2">
              What it finds
            </a>
            <a href="#hamilton" className="opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current-amber focus-visible:ring-offset-2">
              Hamilton
            </a>
            <Link to="/start" className={primaryBtn}>
              Set up your profile
            </Link>
          </nav>
        </div>
      </header>

      {/* hero */}
      <section className="px-6 pb-10 pt-[72px]">
        <div className="mx-auto grid max-w-[1120px] items-center gap-12 lg:grid-cols-[1.05fr_.95fr]">
          <div>
            <span className="font-mono-money text-xs uppercase tracking-[0.12em] text-current-emerald">
              Your AI funding team
            </span>
            <h1 className="mt-3.5 font-display text-[clamp(40px,6vw,76px)] font-extrabold leading-[.98] tracking-[-0.025em]">
              There&rsquo;s money with your <span className="text-current-emerald">name on it.</span>
            </h1>
            <p className="mb-7 mt-5 max-w-[30ch] text-[clamp(17px,2.2vw,20px)] text-current-ink/80">
              GrantFlow finds the grants, scholarships, and benefits you actually qualify for — then helps you win them.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link to="/start" className={primaryBtn}>
                Set up your profile <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <a href="#how" className={ghostBtn}>
                See how it works
              </a>
            </div>
            <div className="mt-[18px] flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-current-ink/60">
              <span className="flex items-center gap-2">
                <StatusDot tone="ready" size="sm" /> Only what you qualify for
              </span>
              <span className="flex items-center gap-2">
                <StatusDot tone="awarded" size="sm" /> Hamilton applies for you
              </span>
              <span className="flex items-center gap-2">
                <StatusDot tone="needs" size="sm" /> You approve what matters
              </span>
            </div>
          </div>

          {/* SIGNATURE: the funding current */}
          <div
            className="rounded-[22px] border border-current-line bg-current-card p-5 shadow-[0_30px_60px_-40px_rgba(20,36,31,.5)]"
            aria-label="Scattered funding sources flowing into your pipeline"
          >
            <h2 className="mx-1 mb-3.5 mt-0.5 font-mono-money text-xs font-bold uppercase tracking-[0.1em] text-current-ink/60">
              The funding current
            </h2>
            <div className="grid grid-cols-[1fr_72px_1fr] items-center gap-0 sm:grid-cols-[1fr_88px_1fr]">
              <div className="flex flex-col gap-2.5">
                {SOURCES.map((s) => (
                  <div
                    key={s.tag}
                    className="fc-src flex items-center gap-2.5 rounded-[10px] border border-current-line bg-current-paper px-2.5 py-2 text-[13.5px]"
                  >
                    <span className="rounded-[5px] border border-current-emeraldSoft bg-current-emeraldSoft px-1.5 py-px font-mono-money text-[10.5px] text-current-emerald">
                      {s.tag}
                    </span>
                    {s.label}
                  </div>
                ))}
              </div>

              <div className="fc-pipe relative my-1.5 flex min-h-[200px] items-center justify-center self-stretch overflow-hidden rounded-xl bg-gradient-to-b from-current-emerald to-[#0f5e3c]">
                <span className="relative font-mono-money text-[11px] uppercase tracking-[0.14em] text-[#dff0e7] [writing-mode:vertical-rl]">
                  your pipeline
                </span>
              </div>

              <div className="flex flex-col items-end gap-2.5 text-right">
                <div className="leading-none">
                  <Money className="text-[clamp(28px,4.4vw,40px)] font-bold text-current-ink">$48,250</Money>
                  <span className="mt-1.5 block font-mono-money text-[11px] uppercase tracking-[0.1em] text-current-ink/60">
                    found for you
                  </span>
                </div>
                <Money className="rounded-lg border border-current-amber/50 bg-current-amberSoft px-2.5 py-1.5 text-[13px] text-[#a76a16]">
                  $12,000 awarded
                </Money>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* breadth strip */}
      <div id="breadth" className="border-y border-current-line bg-current-card">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 py-[18px]">
          <b className="font-mono-money text-[13px] tracking-[0.06em]">Whole-life funding</b>
          <span className="text-sm text-current-ink/70">Federal &amp; state grants</span>
          <span className="text-sm text-current-ink/70">Scholarships</span>
          <span className="text-sm text-current-ink/70">Benefits — SNAP, Medicaid, TANF</span>
          <span className="text-sm text-current-ink/70">Item funding — a van, a laptop</span>
          <span className="text-sm text-current-ink/70">Local foundations</span>
        </div>
      </div>

      {/* how it works */}
      <section id="how" className="px-6 py-[76px]">
        <div className="mx-auto max-w-[1120px]">
          <div className="max-w-[62ch]">
            <span className="font-mono-money text-xs uppercase tracking-[0.12em] text-current-emerald">
              How it works
            </span>
            <h2 className="mt-2.5 font-display text-[clamp(28px,4vw,44px)] font-bold leading-[1.04] tracking-[-0.02em]">
              Set it up once. The funding finds its way to you.
            </h2>
            <p className="mt-3.5 text-[18px] text-current-ink/75">
              You build one profile. GrantFlow does the hunting, the matching, and most of the applying — and shows you exactly where every dollar stands.
            </p>
          </div>

          <div className="mt-10 grid gap-[18px] md:grid-cols-3">
            {STEPS.map((step) => (
              <div
                key={step.k}
                className="rounded-2xl border border-current-line bg-current-card p-[22px]"
              >
                <div className="font-mono-money text-xs tracking-[0.1em] text-current-emerald">{step.k}</div>
                <h3 className="mb-1.5 mt-3 font-display text-[21px] font-bold tracking-[-0.01em]">{step.h}</h3>
                {step.k === "track" ? (
                  <p className="text-[15px] text-current-ink/75">
                    Every opportunity, what it&rsquo;s worth, and where it stands — from{" "}
                    <span className="font-mono-money">preparing</span> to{" "}
                    <span className="font-mono-money">applied</span> to{" "}
                    <span className="font-mono-money">awarded</span>.
                  </p>
                ) : (
                  <p className="text-[15px] text-current-ink/75">{step.p}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* dark Hamilton band */}
      <section id="hamilton" className="bg-current-ink text-[#e8efe9]">
        <div className="mx-auto grid max-w-[1120px] items-center gap-10 px-6 py-16 md:grid-cols-2">
          <div>
            <span className="font-mono-money text-xs uppercase tracking-[0.12em] text-current-sage">
              Meet Hamilton
            </span>
            <h2 className="mt-2 font-display text-[clamp(28px,4vw,42px)] font-bold tracking-[-0.02em] text-white">
              One page. Green means go.
            </h2>
            <p className="mt-3.5 max-w-[42ch] text-[17px] text-[#aebdb4]">
              Every login you need, in one place. Green is ready — Hamilton can sign in. Red means click it once, enter your password and 2FA, and you&rsquo;re done. After that, it&rsquo;s handled.
            </p>
            <Link to="/start" className={`${primaryBtn} mt-5`}>
              Set up your profile
            </Link>
          </div>
          <div className="flex flex-col gap-2.5" aria-label="Example portals">
            {PORTALS.map((portal) => {
              const ready = portal.tone === "ready"
              return (
                <div
                  key={portal.name}
                  className="flex items-center gap-3 rounded-xl border border-[#2b4239] bg-[#1c302a] px-3.5 py-3"
                >
                  <StatusDot tone={ready ? "ready" : "needs"} size="sm" />
                  <span className="text-[15px] font-semibold">{portal.name}</span>
                  <span
                    className={`ml-auto rounded-full border px-2.5 py-1 font-mono-money text-[11px] uppercase tracking-[0.08em] ${
                      ready
                        ? "border-[#2f7a57] bg-current-emerald/30 text-[#bff0d6]"
                        : "border-[#94402f] bg-current-coral/20 text-[#ffd2c7]"
                    }`}
                  >
                    {portal.status}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* final CTA */}
      <section id="start" className="px-6 py-[84px] text-center">
        <div className="mx-auto max-w-[1120px]">
          <span className="font-mono-money text-xs uppercase tracking-[0.12em] text-current-emerald">
            Stop leaving it on the table
          </span>
          <h2 className="mx-auto mt-2.5 max-w-[18ch] font-display text-[clamp(34px,5.4vw,64px)] font-extrabold leading-none tracking-[-0.025em]">
            Stop searching. Start receiving.
          </h2>
          <p className="mx-auto mb-7 mt-4.5 max-w-[40ch] text-[18px] text-current-ink/75">
            Set up your profile and let GrantFlow find — and win — the funding you&rsquo;re owed.
          </p>
          <Link to="/start" className={`${primaryBtn} px-6 py-3.5 text-[17px]`}>
            Set up your profile <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </section>

      {/* footer */}
      <footer className="border-t border-current-line py-7 text-[13.5px] text-current-ink/60">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-3 px-6">
          <div className="flex items-center gap-2.5 font-display text-[16px] font-extrabold">
            <BrandMark />
            GrantFlow
          </div>
          <div className="font-mono-money text-xs">
            Fees are for professional services — never a percentage of your award.
          </div>
        </div>
      </footer>
    </div>
  )
}
