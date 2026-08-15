import { describe, it, expect } from 'vitest'
import {
  extractAwardAmountsFromText,
  resolveOpportunityAmounts,
} from '../services/awardAmountExtractor.js'

describe('extractAwardAmountsFromText — per-award dollar extraction', () => {
  it('parses an explicit range', () => {
    expect(extractAwardAmountsFromText('Awards range from $1,000 to $5,000 per student.'))
      .toMatchObject({ amount_min: 1000, amount_max: 5000, matched: 'range', amount_status: 'range' })
    expect(extractAwardAmountsFromText('Grants between $500 and $2,500 are available.'))
      .toMatchObject({ amount_min: 500, amount_max: 2500, matched: 'range' })
    expect(extractAwardAmountsFromText('Scholarships of $1,000-$10,000.'))
      .toMatchObject({ amount_min: 1000, amount_max: 10000, matched: 'range' })
  })

  it('parses "up to" as a ceiling', () => {
    expect(extractAwardAmountsFromText('Apply for up to $10,000 in scholarship support.'))
      .toMatchObject({ amount_min: null, amount_max: 10000, matched: 'up_to', amount_status: 'range' })
    expect(extractAwardAmountsFromText('A maximum of $7,500 will be awarded per applicant.'))
      .toMatchObject({ amount_min: null, amount_max: 7500, matched: 'up_to' })
    expect(extractAwardAmountsFromText('Requests may not exceed $25,000.'))
      .toMatchObject({ amount_min: null, amount_max: 25000, matched: 'up_to' })
  })

  it('parses exact single-award phrasings (both orders)', () => {
    expect(extractAwardAmountsFromText('One-time scholarship of $2,500 for paramedic students.'))
      .toMatchObject({ amount_min: 2500, amount_max: 2500, matched: 'single', amount_status: 'known' })
    expect(extractAwardAmountsFromText('The foundation offers a $1,500 grant to local churches.'))
      .toMatchObject({ amount_min: 1500, amount_max: 1500, matched: 'single' })
    expect(extractAwardAmountsFromText('Selected students receive $3,000 per year.'))
      .toMatchObject({ amount_min: 3000, amount_max: 3000, matched: 'single' })
  })

  it('parses labeled amounts ("award amount: $X") as exact', () => {
    expect(extractAwardAmountsFromText('Scholarship amount: $2,500 per academic year.'))
      .toMatchObject({ amount_min: 2500, amount_max: 2500, matched: 'labeled', amount_status: 'known' })
    expect(extractAwardAmountsFromText('The grant amount is $10,000.'))
      .toMatchObject({ amount_min: 10000, amount_max: 10000, matched: 'labeled' })
  })

  it('parses minimum/floor-only phrasings as a range floor', () => {
    expect(extractAwardAmountsFromText('Minimum award of $500; larger requests considered.'))
      .toMatchObject({ amount_min: 500, amount_max: null, matched: 'minimum', amount_status: 'range' })
    expect(extractAwardAmountsFromText('Awards start at $1,000.'))
      .toMatchObject({ amount_min: 1000, amount_max: null, matched: 'minimum' })
  })

  it('parses average award as an ESTIMATE (not an exact amount)', () => {
    expect(extractAwardAmountsFromText('The average award is $4,500.'))
      .toMatchObject({ amount_min: 4500, amount_max: 4500, matched: 'average', amount_status: 'estimated' })
    expect(extractAwardAmountsFromText('Typical grant size of $25,000 for first-time applicants.'))
      .toMatchObject({ matched: 'average', amount_status: 'estimated' })
    // lower confidence than an explicit range
    const avg = extractAwardAmountsFromText('Average award of $5,000.')
    const range = extractAwardAmountsFromText('Awards range from $1,000 to $5,000.')
    expect(avg.amount_confidence).toBeLessThan(range.amount_confidence)
  })

  it('handles stipend / reimbursement / matching-funds phrasings', () => {
    expect(extractAwardAmountsFromText('Monthly stipend of $1,200 for fellows.'))
      .toMatchObject({ amount_min: 1200, matched: 'single' })
    expect(extractAwardAmountsFromText('Reimbursement of $2,000 for approved expenses.'))
      .toMatchObject({ amount_min: 2000, matched: 'single' })
    expect(extractAwardAmountsFromText('Tuition reimbursement up to $5,250 per year.'))
      .toMatchObject({ amount_max: 5250, matched: 'up_to' })
    expect(extractAwardAmountsFromText('Matching funds up to $50,000 available for capital projects.'))
      .toMatchObject({ amount_max: 50000, matched: 'up_to' })
  })

  it('understands k / million multipliers', () => {
    expect(extractAwardAmountsFromText('Grants of up to $1.5 million for research infrastructure.').amount_max)
      .toBe(1500000)
    expect(extractAwardAmountsFromText('A $10k award recognizes community leadership.').amount_max)
      .toBe(10000)
  })

  it('REJECTS program-total phrasings as amounts (precision over recall)', () => {
    expect(extractAwardAmountsFromText('The foundation has awarded a total of $2,000,000 since 1998.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('More than $5,000,000 in scholarships awarded annually.').matched)
      .toBeNull()
    expect(extractAwardAmountsFromText('With an endowment of $40,000, the fund supports local students... ').matched)
      .toBeNull()
  })

  it('preserves a program-total EXCERPT as amount_text (status stays not_listed)', () => {
    const r = extractAwardAmountsFromText('Total funding available: $500,000 for the 2026 cycle.')
    expect(r.matched).toBeNull()
    expect(r.amount_min).toBeNull()
    expect(r.amount_max).toBeNull()
    expect(r.amount_status).toBe('not_listed')
    expect(r.amount_text).toContain('$500,000')
  })

  it('detects "varies" and "contact funder" statuses without inventing numbers', () => {
    const varies = extractAwardAmountsFromText('Award amounts vary based on demonstrated need.')
    expect(varies).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'varies' })
    expect(varies.amount_text).toBeTruthy()

    const contact = extractAwardAmountsFromText('Contact the funder for award amounts and deadlines.')
    expect(contact).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'contact_required' })
  })

  it('rejects implausible values and empty text', () => {
    expect(extractAwardAmountsFromText('Scholarship of $25 for essay entries.').matched).toBeNull()
    expect(extractAwardAmountsFromText('Award of $999,999,999 for everyone.').matched).toBeNull()
    expect(extractAwardAmountsFromText('').matched).toBeNull()
    expect(extractAwardAmountsFromText(null).matched).toBeNull()
    expect(extractAwardAmountsFromText('').amount_status).toBe('not_listed')
  })

  describe('AGGREGATE / program-total precision (the Coca-Cola Scholars class, 2026-07-17)', () => {
    // A rich funder page carries a real per-award figure AND several program
    // aggregates. The extractor used to grab the biggest matching aggregate — a
    // WRONG amount, worse than a blank (precision-over-recall). It must skip the
    // aggregates and return the real per-award figure.
    it('skips "N stipends (up to $X) annually across N tiers" and finds the real award', () => {
      const text = '150 Coca-Cola Scholars are selected each year to receive this $20,000 scholarship. ' +
        'The Program awards 200 stipends (up to $237,500) annually across four tiers of recognition.'
      const r = extractAwardAmountsFromText(text)
      expect(r.amount_max).toBe(20000)
    })

    it('skips "annual scholarships of $X million" (plural = program total)', () => {
      const text = 'We support exceptional students each year, with annual scholarships of $3.55 million ' +
        'awarded through the program. Each scholar receives a $20,000 scholarship.'
      const r = extractAwardAmountsFromText(text)
      expect(r.amount_max).toBe(20000)
    })

    it('excludes a pure program total ("$X in scholarships annually") with no per-award figure', () => {
      const r = extractAwardAmountsFromText('The foundation awards $15 million in scholarships annually to students nationwide.')
      expect(r.amount_min).toBeNull()
      expect(r.amount_max).toBeNull()
    })

    it('PRESERVES a singular "annual scholarship of $X" (a real per-award figure)', () => {
      // The plural discriminator must not swallow legitimate singular per-award phrasing.
      expect(extractAwardAmountsFromText('Recipients receive an annual scholarship of $5,000.').amount_max).toBe(5000)
    })

    it('PRESERVES a genuine per-award "up to $X" with no count', () => {
      expect(extractAwardAmountsFromText('Apply for up to $10,000 in scholarship support.').amount_max).toBe(10000)
    })

    it('PRESERVES "$X to each recipient" (per-award, no count before the figure)', () => {
      expect(extractAwardAmountsFromText('Grants of $5,000 to each recipient are available.').amount_max).toBe(5000)
    })
  })

  describe('TUITION-COVERAGE awards (the NM Lottery/Opportunity class, amount_recall_miss:high_school_student 2026-08-03)', () => {
    // These four strings are the REAL prod ingest descriptions of the rows named
    // by Amy's finding excerpt ("New Mexico Lottery Scholarship; TheDream.US
    // Scholarship; UAlbany Alumni Association Scholarships; New Mexico
    // Opportunity Scholarship"). Each states the award IS tuition coverage — an
    // explicit per-award semantic with no fixed dollar figure — so the honest
    // extraction is status 'varies' with the phrase as amount_text, NEVER a
    // number ('not_listed' silence made these rows count as extraction misses
    // every night, and a fabricated figure would be strictly worse).
    it('reads "covers 100% of tuition" as an explicit varies-by-institution award', () => {
      const r = extractAwardAmountsFromText(
        'The Lottery Scholarship covers 100% of tuition for recent New Mexico high school graduates who enroll full time at a New Mexico public college or university.',
      )
      expect(r).toMatchObject({ amount_min: null, amount_max: null, matched: null, amount_status: 'varies' })
      expect(r.amount_text).toMatch(/covers 100% of tuition/i)
    })

    it('reads "pays tuition" as tuition coverage', () => {
      const r = extractAwardAmountsFromText(
        'This scholarship pays tuition and is awarded beginning with the second semester of enrollment, renewable for a maximum of seven semesters and three summer semesters.',
      )
      expect(r).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'varies' })
      expect(r.amount_text).toMatch(/pays tuition/i)
    })

    it('reads "covers any gap in tuition … up to 100% of tuition and allowable fees" (both prod NM Opportunity rows)', () => {
      const a = extractAwardAmountsFromText(
        'This scholarship covers any gap in tuition and allowable fees owed by a student after other forms of state aid are applied, potentially covering up to 100% of tuition and allowable fees.',
      )
      expect(a).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'varies' })
      const b = extractAwardAmountsFromText(
        'Covers any gap in tuition and fees owed by a student after other forms of state aid are applied, can cover up to 100% of tuition and fees.',
      )
      expect(b).toMatchObject({ amount_min: null, amount_max: null, amount_status: 'varies' })
    })

    it('NEVER claims tuition coverage from a bare mention (eligibility phrasing, "help pay for college")', () => {
      // Real prod rows that genuinely state nothing about the award value —
      // these must STAY not_listed (silence), not become a fake answer.
      expect(extractAwardAmountsFromText(
        'UAlbany has partnered with TheDream.US to offer additional scholarships to undergraduate students without permanent legal status who are eligible for in-state tuition.',
      ).amount_status).toBe('not_listed')
      expect(extractAwardAmountsFromText(
        'The Opportunity Scholarship is available to New Mexico residents to help pay for college, with eligibility based on established need and academic performance.',
      ).amount_status).toBe('not_listed')
      expect(extractAwardAmountsFromText(
        'Current UAlbany students are eligible to apply for UAlbany Alumni Association scholarships, several of which are offered each academic year.',
      ).amount_status).toBe('not_listed')
    })

    it('NEVER claims tuition coverage from a negated or excluded claim', () => {
      expect(extractAwardAmountsFromText('This grant does not cover tuition or fees.').amount_status)
        .toBe('not_listed')
      expect(extractAwardAmountsFromText('Funds may be used for books and housing but cannot cover tuition.').amount_status)
        .toBe('not_listed')
      expect(extractAwardAmountsFromText('The stipend covers everything excluding tuition.').amount_status)
        .toBe('not_listed')
    })

    it('a NUMERIC per-award figure still wins over a tuition-coverage phrase', () => {
      // "Tuition reimbursement up to $5,250 per year" carries a real ceiling —
      // the status-only route must not pre-empt it.
      const r = extractAwardAmountsFromText('Pays tuition costs — tuition reimbursement up to $5,250 per year.')
      expect(r.amount_max).toBe(5250)
      expect(r.amount_status).toBe('range')
    })

    // "TUITION-FREE" — the Tennessee Promise class (Amy
    // amount_recall_miss:high_school_student, 2026-08-15). The claim is stated
    // as an ADJECTIVE, so the coverage-verb rule cannot reach it, yet it is the
    // same explicit no-fixed-figure per-award semantic.
    it('reads "tuition-free" as an explicit varies award (the real Tennessee Promise ingest text)', () => {
      const r = extractAwardAmountsFromText(
        'A scholarship providing two years of tuition-free college for eligible students in Tennessee.',
      )
      expect(r.amount_status).toBe('varies')
      expect(r.amount_text).toMatch(/tuition-free/i)
      expect(r.amount_min).toBeNull()
      expect(r.amount_max).toBeNull()
    })

    it('reads the space form "tuition free" too, and a NUMERIC figure still wins over it', () => {
      expect(extractAwardAmountsFromText('Attend college tuition free through this program.').amount_status)
        .toBe('varies')
      const r = extractAwardAmountsFromText('Tuition-free enrollment plus a stipend award of $1,500 per year.')
      expect(r.amount_status).toBe('known')
      expect(r.amount_min).toBe(1500)
    })

    it('NEVER claims tuition-free from a negated claim or a bare "tuition"/"free" mention', () => {
      expect(extractAwardAmountsFromText('This program is not tuition-free; students pay standard rates.').amount_status)
        .toBe('not_listed')
      // Bare mentions with no compound and no coverage verb stay silence.
      expect(extractAwardAmountsFromText('Standard tuition rates apply, and the application itself is free.').amount_status)
        .toBe('not_listed')
    })
  })
})

describe('resolveOpportunityAmounts — structured wins, extraction fills', () => {
  it('keeps structured adapter numbers untouched (status derived, high confidence)', () => {
    const r = resolveOpportunityAmounts({
      amount_min: 100, amount_max: 900,
      description: 'up to $50,000', // must NOT override structured values
    })
    expect(r).toMatchObject({
      amount_min: 100, amount_max: 900, extracted: false, amount_status: 'range',
    })
    expect(r.amount_confidence).toBeGreaterThan(0.9)
  })

  it('marks structured exact amounts (min === max) as known', () => {
    const r = resolveOpportunityAmounts({ amount_min: 2500, amount_max: 2500 })
    expect(r.amount_status).toBe('known')
  })

  it('extracts from title/description only when both structured fields are absent', () => {
    const r = resolveOpportunityAmounts({
      title: 'Community Paramedic Scholarship',
      description: 'Awards of up to $5,000 for EMS students in Bradley County.',
    })
    expect(r).toMatchObject({
      amount_min: null, amount_max: 5000, extracted: true, amount_status: 'range',
    })
    expect(r.amount_text).toContain('$5,000')
  })

  it('preserves a short human amount_description as text with an honest status', () => {
    const r = resolveOpportunityAmounts({
      title: 'Local Grant',
      amount_description: 'Varies',
    })
    expect(r.amount_min).toBeNull()
    expect(r.amount_text).toBe('Varies')
    expect(r.amount_status).toBe('varies')
  })

  it('honestly returns not_listed when nothing is derivable', () => {
    const r = resolveOpportunityAmounts({ title: 'Local Grant', description: 'Serving our community since 1985.' })
    expect(r).toMatchObject({
      amount_min: null, amount_max: null, extracted: false,
      amount_text: null, amount_status: 'not_listed', amount_confidence: null,
    })
  })

  // THE STRUCTURED-ZERO ARTIFACT (Amy amount_recall_miss:high_school_student,
  // prod rows read 2026-08-04). Two live NM Opportunity Scholarship rows carry
  // `amount_min: 0` (one also `amount_max: 0`) beside descriptions that state a
  // REAL per-award semantic ("covers 100% of tuition and course-specific
  // fees"). `typeof 0 === 'number'` took the structured branch, demoted the
  // zero to "$0 (program funding level)" text, and the tuition-coverage
  // phrasing was NEVER consulted — the row stayed an unanswerable miss.
  describe('a structured ZERO is an absence, not an amount', () => {
    it('PROD ROW (reachhighernm.com): amount_min 0 / amount_max 0 + tuition coverage text → varies, never $0', () => {
      const r = resolveOpportunityAmounts({
        source: 'web_search',
        amount_min: 0,
        amount_max: 0,
        title: 'New Mexico Opportunity Scholarship',
        description:
          'The Opportunity Scholarship covers 100% of tuition and course-specific fees at New Mexico public colleges and universities for eligible students.',
      })
      expect(r.amount_min).toBe(null)
      expect(r.amount_max).toBe(null)
      expect(r.amount_status).toBe('varies')
      expect(r.amount_text).toMatch(/covers 100% of tuition/i)
    })

    it('PROD ROW (gallup.unm.edu): amount_min 0 alone must not block extraction', () => {
      const r = resolveOpportunityAmounts({
        source: 'web_search',
        amount_min: 0,
        amount_max: null,
        title: 'New Mexico Opportunity Scholarship',
        description:
          'The Opportunity Scholarship covers tuition and required fees for eligible New Mexico residents pursuing career training certificates, associate degrees, and bachelor’s degrees at New Mexico public colleges and universities.',
      })
      expect(r.amount_status).toBe('varies')
      expect(r.amount_min).toBe(null)
    })

    it('does NOT over-reach: a zero floor beside a REAL ceiling keeps the structured ceiling', () => {
      // {0, 5000} means "no floor stated, ceiling $5,000" — the zero is
      // dropped, the real number stays structured, and extraction never runs.
      const r = resolveOpportunityAmounts({
        amount_min: 0,
        amount_max: 5000,
        description: 'up to $50,000', // must still NOT override structured
      })
      expect(r.amount_min).toBe(null)
      expect(r.amount_max).toBe(5000)
      expect(r.amount_status).toBe('range')
      expect(r.extracted).toBe(false)
    })

    it('does NOT invent a figure when the zero-amount row has no per-award text (stays not_listed)', () => {
      // The negative case: a zero artifact on a row whose text states nothing
      // must stay honest silence — never a number, never a fabricated status.
      const r = resolveOpportunityAmounts({
        source: 'web_search',
        amount_min: 0,
        title: 'Opportunity Scholarship',
        description:
          'The Opportunity Scholarship is available to New Mexico residents to help pay for college, with eligibility based on established need and academic performance.',
      })
      expect(r.amount_min).toBe(null)
      expect(r.amount_max).toBe(null)
      expect(r.amount_status).toBe('not_listed')
    })
  })
})

describe('resolveOpportunityAmounts — untrusted-source plausibility guard (the HUD Section 4 class)', () => {
  it('demotes an implausible untrusted structured range to text-only (program funding level)', () => {
    // The $84M-of-fake-pipeline case: a web/LLM row carried HUD Section 4's
    // $42M PROGRAM APPROPRIATION as its per-award ceiling.
    const r = resolveOpportunityAmounts({
      source: 'web_search',
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })
    expect(r.amount_min).toBe(null)
    expect(r.amount_max).toBe(null)
    expect(r.amount_status).toBe('not_listed')
    expect(r.amount_text).toContain('42,000,000')
    expect(r.amount_text).toContain('program funding level')
    expect(r.amount_confidence).toBe(null)
  })

  it('keeps implausibly large amounts when the source is an OFFICIAL feed', () => {
    const byTier = resolveOpportunityAmounts({
      source: 'web_search',
      source_trust_tier: 'OFFICIAL_API',
      amount_min: 1_000_000,
      amount_max: 42_000_000,
    })
    expect(byTier).toMatchObject({ amount_min: 1_000_000, amount_max: 42_000_000, amount_status: 'range' })
    const bySource = resolveOpportunityAmounts({
      source: 'grants_gov',
      amount_max: 25_000_000,
    })
    expect(bySource.amount_max).toBe(25_000_000)
  })

  it('keeps plausible untrusted structured amounts unchanged', () => {
    const r = resolveOpportunityAmounts({ source: 'web_search', amount_min: 1000, amount_max: 5000 })
    expect(r).toMatchObject({ amount_min: 1000, amount_max: 5000, amount_status: 'range' })
  })

  it('demotes a sub-$100 untrusted "award" the same way', () => {
    const r = resolveOpportunityAmounts({ source: 'web_search', amount_min: 5, amount_max: 20 })
    expect(r.amount_min).toBe(null)
    expect(r.amount_max).toBe(null)
    expect(r.amount_status).toBe('not_listed')
  })
})
