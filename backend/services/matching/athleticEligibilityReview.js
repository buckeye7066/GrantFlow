/**
 * Athletic awards require recipient eligibility, not merely a sports interest.
 * The current profile schema has interests/extracurriculars but no verified
 * team, recruitment, or governing-body eligibility record. Keep explicit
 * athletic awards in REVIEW until that evidence can be confirmed.
 */
export function requiresAthleticEligibilityReview(opportunity = {}) {
  const title = String(opportunity.title ?? '')
  if (/\b(?:athletic(?:s)?\s+(?:endowed\s+)?scholarships?|endowment for (?:women['’]s |men['’]s )?athletics)\b/i.test(title)) return true
  let bullets = opportunity.eligibility_bullets ?? []
  if (typeof bullets === 'string') { try { bullets = JSON.parse(bullets) } catch { bullets = [] } }
  const fragments = [opportunity.eligibility_text, opportunity.description, ...(Array.isArray(bullets) ? bullets : [])]
  return fragments.some((fragment) => String(fragment ?? '').split(/[.!?;\n]+/).some((sentence) => {
    const text = sentence.trim()
    if (/\b(?:not|need not|all students|all majors|regardless|encouraged|preferred)\b/i.test(text)) return false
    return /^(?:this |the )?(?:scholarship|award|endowment) (?:is |will be )?(?:(?:available|designated|intended|awarded|restricted|limited) (?:to|for)|(?:supports?|aimed at supporting|provides? financial support to)) (?:[a-z-]+ )?(?:student[- ]athletes?|athletes?)\b/i.test(text)
      || /^(?:applicants?|recipients?|students?) must be (?:[a-z-]+ )?(?:student[- ]athletes?|athletes?)\b/i.test(text)
      || /^(?:this |the )?scholarship is part of (?:the )?[\w ]+ athletics endowed scholarships\b/i.test(text)
  }))
}
