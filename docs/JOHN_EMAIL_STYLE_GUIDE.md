# John — Email Style Guide

This guide documents exactly how John writes outreach emails so reviewers,
auditors, and future contributors can hold John to a consistent bar.

## Approved tone

- warm
- specific
- respectful
- human
- plain-English
- concise (10–14 sentences max)
- mission-minded
- non-pushy
- honest

## Forbidden tone

- automated
- spammy
- exaggerated
- desperate
- manipulative
- high-pressure
- guaranteed (any wording that implies certainty of funding)
- fake-personal ("I noticed you recently…" without a real Yana evidence URL)
- deceptive
- overly corporate
- generic team/list greetings such as `Hey Team,`, `Hi Team,`, or `Dear Team,`

## Email anatomy

Every John email contains, in order:

1. **Salutation** — a safe person-level greeting when Yana has a usable name
   or natural title (`Hello Allen,`, `Hello Dr. Karen Smith,`,
   `Hello Chief Allen,`). If no person or natural role is known, use the
   neutral professional fallback `Hello,`, never `Hey Team,` or `Hi team,`.
2. **Specific reference** — one sentence noting the organisation and the
   public evidence Yana surfaced (e.g. "doing meaningful work around
   replacing 25-year-old SCBA gear").
3. **What GrantFlow is** — a short, plain-English description.
4. **What caught my attention** — a sentence quoting or paraphrasing the
   most specific evidence item.
5. **How GrantFlow may help** — a practical sentence about how the profile
   fit translates into actionable funding sources.
6. **No-promise disclaimer** — "I'm not writing to promise funding…".
7. **Soft CTA** — "Would it be worth sending you a short example…".
8. **Signature** — `Dr. John White / GrantFlow / Axiom BioLabs /
   Ellie@axiombiolabs.org`.
9. **Opt-out line** — `If this is not relevant, you can reply "no thanks"
   and I will not follow up.`.
10. **Physical address** — the configured `JOHN_PHYSICAL_ADDRESS`.

The classifier (`classifyBody`) blocks any draft missing the opt-out line
or the physical address.

## Subject lines

### Approved patterns

- `Possible funding help for [Organization Name]`
- `Funding discovery idea for [Organization Name]`
- `A possible GrantFlow fit for [Organization Name]`
- `Grant and funding search help for [Organization Name]`
- `Quick note about [project / need]`

### Blocked patterns

- `You have been approved for funding`
- `Grant money waiting for you`
- `Urgent funding opportunity`
- `Re: Your grant application` (we never reply to a thread that doesn't exist)
- `Guaranteed grants for your organization`

The classifier (`classifySubject`) refuses any of these and a few related
forms (`Congratulations`, anything starting with `urgent`, anything
starting with `Re:` since John never sends a reply).

## Forbidden phrases (body)

| Pattern | Reason |
| --- | --- |
| `we guarantee`, `100% funding`, `you will receive funding` | implies certainty |
| `as we discussed`, `per our call`, `nice meeting you` | claims a relationship that does not exist |
| `desperate`, `last chance`, `don't miss out` | predatory framing |
| `Hey Team`, `Hi Team`, `Dear Team` | generic list-style greeting |

If any of those appear in the rendered body, John blocks the draft.

## No-guarantee wording

When writing about possible benefits, prefer hedged phrasing:

| Don't say | Do say |
| --- | --- |
| "GrantFlow will get you funding." | "GrantFlow is built for situations like that." |
| "We guarantee approval." | "I'm not writing to promise funding." |
| "You'll receive a grant." | "It uses a profile of the organization, location, needs, and eligibility factors to identify grants, scholarships, benefits, foundation programs, and other funding sources." |

## Sample emails by client type

The default template renders identically across organisation types — the
specificity comes from the evidence John quotes. The examples below show
what the body looks like for each client type when Yana has surfaced
appropriate evidence.

### Volunteer fire department

> Hello Chief Allen,
>
> I came across Riverbend Volunteer Fire Department while looking at
> organizations doing meaningful work around replacing 25-year-old SCBA
> gear.
>
> I'm Dr. John White, and I'm building GrantFlow — a funding discovery and
> application-tracking tool designed to help churches, nonprofits, schools,
> volunteer fire departments, ministries, families, students, and small
> organizations find real funding sources that fit their actual needs.
>
> What caught my attention was replacing 25-year-old SCBA gear. GrantFlow
> is built for situations like that. It uses a profile of the
> organization, location, needs, and eligibility factors to identify
> grants, scholarships, benefits, foundation programs, and other funding
> sources, then helps track deadlines, documents, and application
> progress.
>
> I'm not writing to promise funding. I just thought your work looked like
> the kind of mission GrantFlow is being built to support.
>
> Would it be worth sending you a short example of what a funding scan
> could look like for Riverbend Volunteer Fire Department?
>
> Respectfully,
>
> Dr. John White
> GrantFlow / Axiom BioLabs
> Ellie@axiombiolabs.org
>
> If this is not relevant, you can reply "no thanks" and I will not follow up.
>
> 123 Mission Way, Anywhere, USA

### Church / ministry

Identical structure; the salutation should use a safe person/title greeting
when available (for example, `Hello Pastor Smith,`) or the neutral
professional fallback `Hello,`. The hook points at the ministry program
Yana found (e.g. "after-school tutoring at the church" with a `source_url`).

### Nonprofit (general)

Identical structure with the program-specific evidence (e.g. "veteran
re-employment program").

### School / booster club

Identical structure; salutation typically resolves to a safe person/title
form such as `Hello Principal Adams,` or to the neutral fallback `Hello,`.
The hook references the specific school program Yana found.

### Food pantry / free clinic

Identical structure; hook references the specific service expansion or
location change Yana found.

### Small business / sole proprietor

Identical structure; tone stays mission-minded ("communities you serve")
rather than commercial.

### Community organisation

Identical structure; hook references the specific local project.

## Opt-out language

The opt-out line must appear verbatim or be a near-paraphrase containing
the literal phrase `no thanks` (or `unsubscribe`, `remove me`, `opt out`,
`reply`). The classifier checks for those tokens in lower-case form.

## Personalisation rules

- Personalise only from Yana-supplied public evidence.
- Never invent a fact.
- Never say "I noticed you recently…" without a Yana evidence item that
  carries a `source_url`.
- Never reference private information (birthdays, medical, family) even
  if Yana surfaces it — only compliance-approved evidence is allowed.
- The full source-URL set is recorded in `source_evidence_json` on the
  draft for audit; the email body does not need to display the URL unless
  contextually appropriate.

## Defaults John never bends

- Always include the opt-out line.
- Always include the configured physical address (when
  `JOHN_PHYSICAL_ADDRESS_REQUIRED=true`, which is the default).
- Always sign as Dr. John White / GrantFlow.
- Never claim to have spoken to or met the recipient.
- Never imply funding is guaranteed.
- Never use a generic team/list greeting such as `Hey Team,` or `Hi team,`.
