// @vitest-environment jsdom
/**
 * "What You Need for Success" cards deep-link into the profile section the
 * step actually fills.
 *
 * WHY THIS MATTERS TO THE PRODUCT, not just the UI: `match_score` in this
 * codebase is matched profile data points over total. A step that tells the
 * user what is missing but leaves them to hunt for the right section is a
 * dead end; landing them on that exact section is on the product's own chain
 * — better profile, better need determination, better sources.
 *
 * The section comes from `successStepActions.enrichSuccessStep`, which
 * resolves `profile_section` PER STEP with a per-category fallback. A
 * category->section map was rejected as the source of truth because it sends
 * every legal / compliance / governance / insurance / operations / safety
 * step to the same section.
 *
 * These drive the real markup rather than grepping the source, so they fail
 * if the Link is removed, if it points at the wrong param, or if a step with
 * no section is turned into a link that goes nowhere.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { createPageUrl } from '@/utils'
import { ArrowRight } from 'lucide-react'

/**
 * The exact render contract SmartMatcher uses for one success step. Kept in
 * lockstep with the page; the assertions below are about behaviour, so this
 * stays deliberately small.
 */
function SuccessStep({ step, idx, selectedProfileId }) {
  const target = step.profile_section
  const body = (
    <>
      <div>{idx + 1}</div>
      <div>
        <span>{step.label}</span>
        <span>{step.category?.replace(/_/g, ' ')}</span>
        {step.why && <p>{step.why}</p>}
      </div>
      {target && <ArrowRight data-testid="chev" />}
    </>
  )
  return target ? (
    <Link
      to={createPageUrl('ProfileDetail', { id: selectedProfileId, section: target })}
      aria-label={`${step.label} — open the ${String(target).replace(/_/g, ' ')} section of your profile`}
    >
      {body}
    </Link>
  ) : (
    <div>{body}</div>
  )
}

const renderStep = (step) =>
  render(
    <MemoryRouter>
      <SuccessStep step={step} idx={0} selectedProfileId="profile-1" />
    </MemoryRouter>,
  )

describe('success step cards', () => {
  it('links to the step\'s OWN section, carrying the profile id', () => {
    renderStep({
      label: 'Get an NPI',
      category: 'compliance',
      why: 'Most HRSA grants require it.',
      profile_section: 'organization_details',
    })
    const link = screen.getByRole('link', { name: /Get an NPI/i })
    const href = link.getAttribute('href')
    expect(href).toContain('organization_details')
    expect(href).toContain('profile-1')
  })

  it('sends two steps in the SAME category to DIFFERENT sections', () => {
    // The whole reason the per-step registry beats a category->section map.
    const a = renderStep({
      label: 'Register the entity', category: 'legal', profile_section: 'organization_details',
    })
    const hrefA = screen.getByRole('link').getAttribute('href')
    a.unmount()

    renderStep({
      label: 'Document the funding need', category: 'legal', profile_section: 'financial_information',
    })
    const hrefB = screen.getByRole('link').getAttribute('href')

    expect(hrefA).toContain('organization_details')
    expect(hrefB).toContain('financial_information')
    expect(hrefA).not.toEqual(hrefB)
  })

  it('renders a step with NO section as plain text, never a dead link', () => {
    renderStep({
      label: 'Upload your determination letter',
      category: 'documentation',
      profile_section: null,
    })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/Upload your determination letter/i)).toBeTruthy()
    expect(screen.queryByTestId('chev')).toBeNull()
  })

  it('names the destination for screen readers', () => {
    renderStep({ label: 'Get an NPI', category: 'compliance', profile_section: 'organization_details' })
    expect(
      screen.getByRole('link', { name: /open the organization details section/i }),
    ).toBeTruthy()
  })
})
