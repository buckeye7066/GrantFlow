import { describe, expect, it } from 'vitest'
import { buildInstitutionalNewsletterBundle } from '../services/dissemination/institutionalNewsletter.js'

const baseInput = {
  institutionName: 'North <Research> University',
  editionDate: '2026-08-25',
  groups: [{
    id: 'health-faculty',
    name: 'Health Faculty',
    recipient_profile_ids: ['profile-1', 'profile-2', 'profile-3', 'profile-4', 'profile-5'],
    saved_opportunity_ids: ['saved-1'],
    topic_terms: ['oncology', 'rural health'],
  }],
  recipients: [
    {
      profile_id: 'profile-1',
      display_name: '=CMD()',
      email: 'faculty@university.edu',
      email_opt_in: true,
      email_consent_at: '2026-08-01T12:00:00Z',
    },
    { profile_id: 'profile-2', email: 'no-consent@university.edu', email_opt_in: false },
    { profile_id: 'profile-3', email: 'missing-date@university.edu', email_opt_in: true },
    {
      profile_id: 'profile-4',
      email: 'placeholder@example.com',
      email_opt_in: true,
      email_consent_at: '2026-08-01T12:00:00Z',
    },
    {
      profile_id: 'profile-5',
      active: false,
      email: 'inactive@university.edu',
      email_opt_in: true,
      email_consent_at: '2026-08-01T12:00:00Z',
    },
  ],
  opportunities: [
    {
      id: 'topic-1',
      title: '<script>Oncology & Rural Health</script>',
      funder: 'Public Health Foundation',
      application_url: 'https://funding.example.org/topic-1',
      deadline: '2026-11-01',
      score: 90,
      topics: ['oncology'],
    },
    {
      id: 'saved-1',
      title: 'Saved Translational Award',
      funder: 'Science Trust',
      application_url: 'https://funding.example.org/saved-1',
      score: 20,
    },
    {
      id: 'assigned-1',
      title: 'Faculty Seed Award',
      funder: 'Regional Trust',
      application_url: 'https://funding.example.org/assigned-1',
      profile_ids: ['profile-1'],
      score: 99,
    },
    {
      id: 'unsafe-1',
      title: 'Unsafe URL',
      application_url: 'javascript:alert(1)',
      topics: ['oncology'],
    },
    {
      id: 'unrelated-1',
      title: 'Unrelated Arts Award',
      application_url: 'https://funding.example.org/unrelated-1',
    },
  ],
}

describe('institutional newsletter bundle', () => {
  it('exports deterministic, consent-scoped editions without sending email', () => {
    const first = buildInstitutionalNewsletterBundle(baseInput)
    const second = buildInstitutionalNewsletterBundle(baseInput)

    expect(second).toEqual(first)
    expect(first.schema_version).toBe('grantflow-institutional-newsletter-v1')
    expect(first.eligible_recipient_count).toBe(1)
    expect(first.editions).toHaveLength(1)
    expect(first.editions[0]).toMatchObject({
      group_id: 'health-faculty',
      recipient_count: 1,
      opportunity_count: 3,
      opportunity_ids: ['saved-1', 'assigned-1', 'topic-1'],
    })
    expect(first.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

    const suppressionReasons = first.suppressed_recipients.map((entry) => entry.reason).sort()
    expect(suppressionReasons).toEqual([
      'deliverable_email_missing',
      'email_consent_not_recorded',
      'email_consent_timestamp_missing',
      'inactive_profile',
    ])
    const recipients = first.files.find((file) => file.media_type === 'text/csv').content
    expect(recipients).toContain("'=CMD()")
    expect(recipients).toContain('faculty@university.edu')
    expect(recipients).not.toContain('no-consent@university.edu')
  })

  it('escapes HTML and excludes unsafe or unselected opportunities', () => {
    const bundle = buildInstitutionalNewsletterBundle(baseInput)
    const html = bundle.files.find((file) => file.media_type === 'text/html').content

    expect(html).toContain('North &lt;Research&gt; University')
    expect(html).toContain('&lt;script&gt;Oncology &amp; Rural Health&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('Unrelated Arts Award')
  })

  it('rejects ambiguous group identities and invalid edition dates', () => {
    expect(() => buildInstitutionalNewsletterBundle({
      ...baseInput,
      groups: [{ id: 'duplicate' }, { id: 'duplicate' }],
    })).toThrow(/present and unique/)
    expect(() => buildInstitutionalNewsletterBundle({
      ...baseInput,
      editionDate: 'not-a-date',
    })).toThrow(/ISO calendar date/)
    expect(() => buildInstitutionalNewsletterBundle({
      ...baseInput,
      editionDate: '2026-02-31',
    })).toThrow(/ISO calendar date/)
  })
})
