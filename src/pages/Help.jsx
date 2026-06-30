import React, { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Search, ExternalLink } from "lucide-react";
import { createPageUrl } from "@/utils";
import { searchHelpRegistry, HELP_REGISTRY } from "@/config/helpRegistry";

const BIG_BUTTONS = [
  {
    title: "Start here (Set up my organization)",
    description: "Add your organization and profiles.",
    links: [
      { label: "Organizations", url: createPageUrl("Organizations") },
      { label: "My Profiles", url: createPageUrl("MyProfiles") },
    ],
  },
  {
    title: "Find grants",
    description: "Search for funding that fits you.",
    links: [
      { label: "Discover Grants", url: createPageUrl("DiscoverGrants") },
      { label: "Funding Opportunities", url: createPageUrl("FundingOpportunities") },
    ],
  },
  {
    title: "Work my pipeline",
    description: "Track applications and manage documents.",
    links: [
      { label: "Pipeline", url: createPageUrl("Pipeline") },
      { label: "Documents", url: createPageUrl("Documents") },
    ],
  },
  {
    title: "Track deadlines & reports",
    description: "Never miss a due date. See your reports.",
    links: [
      { label: "Grant Deadline", url: createPageUrl("GrantDeadline") },
      { label: "Reports", url: createPageUrl("Reports") },
    ],
  },
];

/** Derive common-tasks list from the help registry so descriptions stay in sync. */
function buildCommonTasks() {
  const routeOrder = [
    'Dashboard', 'Calendar', 'Settings', 'MyProfiles', 'Organizations',
    'DiscoverGrants', 'SmartMatcher', 'ProfileMatcher', 'FundingOpportunities',
    'Funder', 'Pipeline', 'Proposals', 'Documents', 'PrintableApplication',
    'GrantDeadline', 'GrantMonitoring', 'Reports', 'Outreach', 'Stewardship',
    'DataSources', 'SourceDirectory',
  ]
  return routeOrder.map((key) => {
    const entry = HELP_REGISTRY.find((e) => e.key === key)
    if (!entry) return null
    return {
      key,
      title: entry.title,
      desc: entry.description,
      url: createPageUrl(key),
    }
  }).filter(Boolean)
}

const COMMON_TASKS = buildCommonTasks()

const FAQ_ITEMS = [
  {
    q: "What is a Profile?",
    a: "A profile describes who you are when applying—like your organization, or yourself as a student. You need at least one profile to find grants.",
  },
  {
    q: "What's the Pipeline?",
    a: "The Pipeline is where you track grants from discovery to submission. Add grants you like and move them through stages as you work.",
  },
  {
    q: "What does Smart Matcher do?",
    a: "Smart Matcher analyses your saved profile, including location, needs, applicant type, and eligibility details, and runs them through GrantFlow's matching engine to surface grants you are likely to qualify for. You can also describe a specific need in your own words on that page and use Understand & search to turn it into catalog keywords. The more complete your profile, the better the matches.",
  },
  {
    q: "Where do my uploaded documents go?",
    a: "Documents you upload go to the Documents page. They stay there so you can reuse them for different applications.",
  },
  {
    q: "How do I come back later?",
    a: "Just log in again. Your data is saved. Use the left menu to go back to any page you were on.",
  },
  {
    q: "Why can't I see Admin tools?",
    a: "Admin tools are only for account administrators. If you need access, ask your organization's admin to add you.",
  },
  {
    q: "How do I find grants?",
    a: "Go to Discover Grants to search. Or use Smart Matcher to get AI suggestions based on your profile.",
  },
  {
    q: "What is a Funder?",
    a: "A funder is the organization that gives the money—like a foundation or government agency. The Funder page lets you explore them.",
  },
];

function FaqItem({ question, answer, isOpen, onToggle }) {
  return (
    <Collapsible open={isOpen} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-left text-base font-medium hover:bg-muted/50 transition-colors"
        >
          {question}
          {isOpen ? (
            <ChevronDown className="h-5 w-5 shrink-0" />
          ) : (
            <ChevronRight className="h-5 w-5 shrink-0" />
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-lg border bg-muted/30 px-4 py-3 text-base text-muted-foreground">
          {answer}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function Help() {
  const [searchQuery, setSearchQuery] = useState("");
  const [openFaqIndex, setOpenFaqIndex] = useState(null);

  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return COMMON_TASKS;
    const results = searchHelpRegistry(searchQuery);
    const resultKeys = new Set(results.map((r) => r.key));
    return COMMON_TASKS.filter((t) => {
      const key = HELP_REGISTRY.find((e) => e.title === t.title)?.key;
      return resultKeys.has(key);
    });
  }, [searchQuery]);

  // The "Get started" cards must respond to the search box too — previously they
  // rendered unfiltered, so a search like "deadline" appeared to do nothing.
  const filteredBigButtons = useMemo(() => {
    if (!searchQuery.trim()) return BIG_BUTTONS;
    const q = searchQuery.trim().toLowerCase();
    return BIG_BUTTONS.filter((btn) =>
      (btn.title || "").toLowerCase().includes(q) ||
      (btn.description || "").toLowerCase().includes(q) ||
      (Array.isArray(btn.links) && btn.links.some((link) => (link.label || "").toLowerCase().includes(q)))
    );
  }, [searchQuery]);

  const filteredFaqs = useMemo(() => {
    if (!searchQuery.trim()) return FAQ_ITEMS;
    const q = searchQuery.trim().toLowerCase();
    return FAQ_ITEMS.filter(
      (f) =>
        f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-950 dark:to-slate-900 p-6 md:p-10">
      <div className="max-w-4xl mx-auto space-y-10">
        {/* Header */}
        <div>
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-3">
            Help Center
          </h1>
          <p className="text-xl text-slate-600">
            Pick what you're trying to do. We'll keep it simple.
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search Help"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-4 text-lg border rounded-xl bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            aria-label="Search Help"
          />
        </div>

        {/* Big Buttons */}
        {filteredBigButtons.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Get started</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredBigButtons.map((btn) => (
              <Card
                key={btn.title}
                className="border-2 hover:border-primary/50 hover:shadow-md transition-all"
              >
                <CardHeader>
                  <CardTitle className="text-xl">{btn.title}</CardTitle>
                  <p className="text-base text-muted-foreground">{btn.description}</p>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {btn.links.map((link) => (
                    <Link key={link.url} to={link.url}>
                      <Button size="lg" variant="outline" className="text-base">
                        {link.label}
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </Button>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
        )}

        {/* Common Tasks */}
        <section>
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Common Tasks</h2>
          <p className="text-base text-muted-foreground mb-4">
            Click Open to go straight to that page.
          </p>
          <div className="space-y-2">
            {filteredTasks.length > 0 ? (
              filteredTasks.map((task) => (
                <div
                  key={task.url}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border bg-white p-4"
                >
                  <div>
                    <p className="font-semibold text-lg">{task.title}</p>
                    <p className="text-base text-muted-foreground">{task.desc}</p>
                  </div>
                  <Link to={task.url} className="shrink-0">
                    <Button size="lg">Open</Button>
                  </Link>
                </div>
              ))
            ) : (
              <p className="text-base text-muted-foreground py-4">
                No tasks match your search.
              </p>
            )}
          </div>
        </section>

        {/* FAQ */}
        <section>
          <h2 className="text-2xl font-bold text-slate-900 mb-4">
            Frequently asked questions
          </h2>
          <div className="space-y-2">
            {filteredFaqs.length > 0 ? (
              filteredFaqs.map((faq) => (
                <FaqItem
                  key={faq.q}
                  question={faq.q}
                  answer={faq.a}
                  isOpen={openFaqIndex === faq.q}
                  onToggle={() => setOpenFaqIndex(openFaqIndex === faq.q ? null : faq.q)}
                />
              ))
            ) : (
              <p className="text-base text-muted-foreground py-4">
                No FAQs match your search.
              </p>
            )}
          </div>
        </section>

        {/* Still stuck */}
        <Card className="border-2 border-amber-200 bg-amber-50/50">
          <CardHeader>
            <CardTitle className="text-xl">Still stuck?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-base">
            <p>
              Email us for support. We're happy to help.
            </p>
            <p>
              Please include a screenshot and tell us what page you were on. That helps us fix things faster.
            </p>
            <a
              href="mailto:dr.johnwhite@axiombiolabs.org"
              className="inline-flex"
            >
              <Button size="lg" className="text-base">
                Email support
              </Button>
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
