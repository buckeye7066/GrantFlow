import { Link } from "react-router-dom"
import {
  ArrowRight,
  BarChart3,
  Building2,
  CheckCircle2,
  Hospital,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react"
import { Button } from "../components/ui/button"
import { Badge } from "../components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs"

export default function Home() {
  return (
    <div className="space-y-24 bg-background text-foreground">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary/10 via-primary/5 to-primary/20 px-6 py-16 shadow-sm">
        <div className="mx-auto flex max-w-6xl flex-col gap-10 lg:flex-row lg:items-center">
          <div className="space-y-6">
            <Badge className="w-fit bg-primary text-primary-foreground">Grant intelligence platform</Badge>
            <div className="space-y-4">
              <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                Find, win, and manage grants in one modern workspace.
              </h1>
              <p className="text-base text-muted-foreground sm:text-lg">
                GrantFlow surfaces aligned opportunities, automates the busywork, and keeps every stakeholder on the same page.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/pricing">
                  Start a guided tour
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg">
                <Link to="#features">Explore the feature set</Link>
              </Button>
            </div>
          </div>
          <Card className="relative w-full max-w-xl border-none bg-background/80 backdrop-blur">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Sparkles className="h-5 w-5 text-primary" aria-hidden />
                Why teams choose GrantFlow
              </CardTitle>
              <CardDescription>
                "GrantFlow didn't just streamline applications - it made our entire funding operation predictable."
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <div className="flex items-start gap-3">
                <Search className="mt-1 h-4 w-4 text-primary" aria-hidden />
                <p>Opportunity engine trained on healthcare, education, and workforce datasets.</p>
              </div>
              <div className="flex items-start gap-3">
                <Layers className="mt-1 h-4 w-4 text-primary" aria-hidden />
                <p>Workflow guardrails with approval checkpoints and real-time collaboration.</p>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-1 h-4 w-4 text-primary" aria-hidden />
                <p>Security that meets HIPAA expectations and funder documentation requirements.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-6xl space-y-12 px-6">
        <div className="space-y-3 text-center">
          <Badge variant="secondary" className="mx-auto w-fit">Core capabilities</Badge>
          <h2 className="text-3xl font-semibold tracking-tight">Everything you need to run grant operations</h2>
          <p className="mx-auto max-w-2xl text-muted-foreground">
            Skip spreadsheets. GrantFlow keeps discovery, decisioning, and compliance in one organized, auditable system.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Search className="h-5 w-5 text-primary" aria-hidden />
                Precision matching
              </CardTitle>
              <CardDescription>Surface leads using mission alignment, geography, eligibility, and award size.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Blend public datasets with your historical wins to find the best-fit opportunities automatically.</p>
              <p>Save custom views for different program teams or funding priorities.</p>
            </CardContent>
          </Card>
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BarChart3 className="h-5 w-5 text-primary" aria-hidden />
                Pipeline forecasting
              </CardTitle>
              <CardDescription>Track probability, effort, and projected impact across every open grant.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Spot at-risk submissions with automated reminders and color-coded urgency states.</p>
              <p>Share tailored snapshots with finance or executive stakeholders instantly.</p>
            </CardContent>
          </Card>
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
                Compliance built-in
              </CardTitle>
              <CardDescription>HIPAA-aware storage, permissioned collaboration, and audit-ready exports.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Version every document with clear attribution. Lock final submissions for historical reference.</p>
              <p>Generate compliance packets for funders or internal reviews in seconds.</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mx-auto max-w-6xl space-y-8 px-6">
        <Tabs defaultValue="nonprofit" className="space-y-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-3">
              <h2 className="text-3xl font-semibold tracking-tight">Adaptable to how your team works</h2>
              <p className="max-w-2xl text-muted-foreground">
                Toggle to see how different sectors rely on GrantFlow to accelerate their funding pipeline.
              </p>
            </div>
            <TabsList>
              <TabsTrigger value="nonprofit">Community orgs</TabsTrigger>
              <TabsTrigger value="health">Healthcare</TabsTrigger>
              <TabsTrigger value="education">Education</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="nonprofit" className="mt-0">
            <Card className="border-muted">
              <CardHeader className="flex flex-col gap-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Building2 className="h-5 w-5 text-primary" aria-hidden />
                  Nonprofit alliances
                </CardTitle>
                <CardDescription>Coordinate partners, volunteers, and rotating grant writers with ease.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Shared opportunity library with notes and eligibility criteria stored alongside each record.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Role-based permissions so partner staff can collaborate without exposing sensitive data.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Track commitments across fiscal years to prove impact to board members and donors.</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="health" className="mt-0">
            <Card className="border-muted">
              <CardHeader className="flex flex-col gap-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Hospital className="h-5 w-5 text-primary" aria-hidden />
                  Health systems
                </CardTitle>
                <CardDescription>Protect PHI, align stakeholders, and speed reimbursement programs.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Store templates for narratives, budgets, and letters while keeping sensitive data locked down.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Route fundraising, compliance, and finance approvals in one checklist.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Track clinical program outcomes for faster reporting back to funders.</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="education" className="mt-0">
            <Card className="border-muted">
              <CardHeader className="flex flex-col gap-2">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Layers className="h-5 w-5 text-primary" aria-hidden />
                  Schools & workforce
                </CardTitle>
                <CardDescription>Connect classroom initiatives to regional economic development goals.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Bundle federal, state, and private grants into coordinated funding calendars.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Keep career services, academics, and finance aligned through shared dashboards.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-1 h-4 w-4 text-primary" aria-hidden />
                  <span>Roll up outcomes and budget utilization for board and accreditation reporting.</span>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </section>

      <section className="mx-auto max-w-5xl rounded-3xl border border-muted bg-card px-6 py-16 text-center shadow-sm">
        <div className="space-y-4">
          <Badge variant="secondary" className="mx-auto w-fit">Ready to move faster?</Badge>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Let GrantFlow run point on your next funding cycle</h2>
          <p className="mx-auto max-w-2xl text-muted-foreground">
            Launch with a curated opportunity list, workflows tailored to your organization, and built-in compliance guardrails.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link to="/pricing">View plans and onboarding timelines</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/contact">Chat with a specialist</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}
