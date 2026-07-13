// Public privacy policy page.
//
// IMPORTANT: this page is mounted OUTSIDE the authentication gate (it sits
// ABOVE the LayoutRoutes catch-all in src/pages/index.jsx, alongside /login and
// /welcome). Legal/store pages must be readable by anyone — app-store reviewers
// and logged-out visitors — without an account, and without the app
// shell/navigation (which assumes an authenticated user). Keep this component
// self-contained: no auth hooks, no API calls, no Layout wrapper, no Zustand.
//
// Content reflects GrantFlow's ACTUAL data practices as of the effective date
// below. If you change what data is collected or which processors are used,
// update this page — Google Play's Data safety form must stay consistent with it.

import React from 'react';

const EFFECTIVE_DATE = 'July 13, 2026';

function Section({ title, children }) {
  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-3 text-slate-700 leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <article className="mx-auto max-w-3xl">
        <header className="border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-bold text-slate-900">GrantFlow — Privacy Policy</h1>
          <p className="mt-2 text-sm text-slate-500">Effective {EFFECTIVE_DATE}</p>
        </header>

        <p className="mt-6 text-slate-700 leading-relaxed">
          This Privacy Policy explains how GrantFlow (&ldquo;GrantFlow,&rdquo; &ldquo;we,&rdquo;
          &ldquo;us,&rdquo; or &ldquo;our&rdquo;) collects, uses, and protects your information when
          you use our website and mobile application (together, the &ldquo;Service&rdquo;). GrantFlow
          helps individuals and organizations discover grant funding opportunities and prepare and
          manage grant applications. By using the Service, you agree to the practices described here.
        </p>

        <Section title="Information We Collect">
          <p>We collect only what we need to provide the Service:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>Account information</strong> — your email address and the name you provide when
              you register or are added to an organization.
            </li>
            <li>
              <strong>Applicant and organization profile data</strong> — the information you enter (or
              that you ask our assistant to gather during onboarding) to build your funding profile.
              Depending on the programs you pursue, this can include contact details, organizational
              details (such as nonprofit or business status), demographic and eligibility information,
              and financial information (such as household income or budget figures) that grant
              programs require to determine eligibility.
            </li>
            <li>
              <strong>Grant and application content</strong> — the funding opportunities, pipelines,
              proposals, tasks, notes, and documents you create, upload, or save in the Service. This
              content is stored so we can show it back to you and help you manage your applications.
            </li>
            <li>
              <strong>Payment information</strong> — if you purchase GrantFlow professional services on
              our website, payment is processed by our payment provider (Stripe). We do not receive or
              store your full card number. Purchases are not offered inside the mobile app.
            </li>
            <li>
              <strong>Basic technical data</strong> — standard server logs (such as timestamps, IP
              address, and error information) used to keep the Service secure and reliable. We do not
              use third-party advertising SDKs or advertising/tracking analytics.
            </li>
          </ul>
        </Section>

        <Section title="How We Use Your Information">
          <ul className="list-disc pl-6 space-y-2">
            <li>To create your account and sign you in securely.</li>
            <li>
              To match your profile against grant opportunities, and to help you build, organize, and
              submit grant applications.
            </li>
            <li>To generate, save, and display the content you create.</li>
            <li>To process payments for professional services purchased on our website.</li>
            <li>
              To send you essential account and service email (for example, password resets and
              account notifications).
            </li>
            <li>To protect the Service against abuse, fraud, and technical faults.</li>
          </ul>
          <p>We do not sell your personal information, and we do not use it for advertising.</p>
        </Section>

        <Section title="AI-Assisted Features">
          <p>
            GrantFlow uses artificial intelligence to help discover matching opportunities, draft
            proposal content, and power our in-app assistant. When you use these features, the profile
            or prompt information needed to produce your result is sent to our AI providers
            (Anthropic and OpenAI) solely to generate that result and return it to you. These providers
            act as our processors and do not use your content to train their models on our behalf.
            Please avoid submitting sensitive personal information in free-text prompts that you would
            not want processed by a third-party AI service.
          </p>
        </Section>

        <Section title="How We Share Information">
          <p>
            We share information only with the service providers that help us operate the Service, and
            only to the extent needed to provide it:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Anthropic and OpenAI</strong> — process profile and prompt data to generate AI-assisted results.</li>
            <li><strong>Stripe</strong> — processes website payments for professional services.</li>
            <li><strong>Resend</strong> — delivers transactional and account email.</li>
            <li><strong>Sentry</strong> — receives error and diagnostic reports from our website to help us fix faults.</li>
            <li><strong>Vercel and Railway</strong> — host the application and database.</li>
          </ul>
          <p>
            When you choose to submit a grant application through the Service, the application
            information you provide is sent to the relevant funder or application portal at your
            direction. We do not sell your data or share it with third parties for their own marketing
            or advertising. We may disclose information if required by law or to protect the rights,
            safety, and security of our users and the Service.
          </p>
        </Section>

        <Section title="Cookies">
          <p>
            On the website we use essential, secure cookies to keep you signed in and to protect
            against cross-site request forgery. We do not use advertising or third-party tracking
            cookies.
          </p>
        </Section>

        <Section title="Data Security">
          <p>
            We protect your account with industry-standard measures: passwords are stored using
            one-way hashing (bcrypt) and are never stored in plain text, and data is encrypted in
            transit using HTTPS. Stored credentials for third-party portals, where you provide them,
            are encrypted at rest. No method of transmission or storage is perfectly secure, but we
            work to safeguard your information.
          </p>
        </Section>

        <Section title="Your Choices and Data Retention">
          <ul className="list-disc pl-6 space-y-2">
            <li>You can review and update your account and profile details within the Service.</li>
            <li>
              You can delete a profile you created, and you can request deletion of your account, which
              revokes access and begins removal of your personal account data. Some records may be
              retained where required for legal, security, tax, or audit purposes.
            </li>
            <li>
              You may request a copy of your personal information, or ask us to delete it, by
              contacting us using the details below.
            </li>
          </ul>
        </Section>

        <Section title="Children's Privacy">
          <p>
            The Service is intended for adults managing grant funding and is not directed to children
            under 13. We do not knowingly collect personal information from children under 13. If you
            believe a child has provided us personal information, please contact us and we will delete
            it.
          </p>
        </Section>

        <Section title="Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. When we do, we will revise the
            &ldquo;Effective&rdquo; date at the top of this page. Your continued use of the Service
            after changes take effect constitutes acceptance of the updated policy.
          </p>
        </Section>

        <Section title="Contact Us">
          <p>
            If you have questions about this Privacy Policy or your data, contact us by email at{' '}
            <a className="text-blue-600 underline" href="mailto:dr.johnwhite@axiombiolabs.org">
              dr.johnwhite@axiombiolabs.org
            </a>
            .
          </p>
        </Section>

        <footer className="mt-12 border-t border-slate-200 pt-6 text-sm text-slate-500">
          &copy; {new Date().getFullYear()} GrantFlow. All rights reserved.
        </footer>
      </article>
    </main>
  );
}
