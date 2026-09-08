/**
 * The boolean-format trap (found 2026-09-08): SECTION_METADATA declared ~58
 * toggle fields (org certifications, race/heritage flags, military flags,
 * health flags, "Good credit score (700+)") as format "text", and the guard
 * accepts only strings for that format — so every Switch value the editor
 * sent was rejected as `format_mismatch` and the PUT answered 200 with the
 * field silently dropped. Nobody could save a credit score, a certification,
 * a heritage, or a military status.
 */
import { describe, expect, it } from "vitest"
import { guardProfileSectionPayload, SECTION_METADATA } from "../../../shared/profileSuggestionGuards.js"

const guard = (sectionKey, data, profile = { primary_type: "senior" }) =>
  guardProfileSectionPayload(data, { sectionKey, profile, sections: {} })

describe("boolean toggles are SAVED, never silently dropped", () => {
  it.each([
    ["demographics", { jewish_heritage: true, lgbtq: false, african_american: true }],
    ["military_service", { veteran: true, active_duty_military: false, disabled_veteran: true, national_guard: false }],
    ["health_medical", { dialysis_patient: true, tbi_survivor: true, neurodivergent: false }],
    ["family_life", { widow_widower: true, formerly_incarcerated: false }],
    ["location_focus", { rural_resident: true, appalachian_region: true }],
    ["education", { rotc_jrotc: true, first_generation_college_student: true, dual_enrollment: false }],
  ])("%s accepts every toggle it renders", (sectionKey, data) => {
    const r = guard(sectionKey, data, sectionKey === "education" ? { primary_type: "college_student" } : undefined)
    expect(r.rejected).toEqual([])
    expect(r.data).toEqual(data)
  })

  it("organization certifications and place designations save for an org", () => {
    const data = { cert_8a: true, cert_hubzone: false, cert_mbe: true, cert_dbe: true, cert_sbe: false, in_qct: true, in_opportunity_zone: false, sam_gov_registered: true, charitable_solicitation_registered: true }
    const r = guard("organization_details", data, { primary_type: "nonprofit" })
    expect(r.rejected).toEqual([])
    expect(r.data).toEqual(data)
  })

  // TOTALITY over the questions the form actually ASKS. Two guard behaviours
  // are deliberate and are asserted below rather than skipped past:
  //   - an occupation flag needs corroborating employer evidence, so the probe
  //     supplies it (a claim of being a firefighter is not self-certifying);
  //   - a DEPRECATED legacy spelling is renamed onto its canonical key by
  //     `selfTargetFor`, which is the guard's job, not a dropped save.
  it("every LIVE boolean_tri question round-trips true through the guard under its own key", () => {
    const failures = []
    for (const [sectionKey, section] of Object.entries(SECTION_METADATA)) {
      for (const f of section.fields ?? []) {
        if (f.format !== "boolean_tri" || f.applies_to_field || f.deprecated) continue
        const payload = sectionKey === "occupation"
          ? { [f.name]: true, employer_name: "Cleveland Fire Department", start_date: "2019-04-01" }
          : { [f.name]: true }
        const r = guard(sectionKey, payload, { primary_type: "nonprofit" })
        const rejectedThis = r.rejected.filter((x) => x.key === f.name)
        if (rejectedThis.length || r.data[f.name] !== true) {
          failures.push(`${sectionKey}.${f.name}:${rejectedThis.map((x) => x.reason).join(",") || "dropped"}`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it("an occupation flag with NO employer evidence is refused LOUDLY, never silently dropped", () => {
    const r = guard("occupation", { firefighter: true }, { primary_type: "senior" })
    expect(r.rejected.map((x) => x.reason)).toEqual(["missing_employer_evidence"])
    expect(r.data.firefighter).toBeUndefined()
  })

  // The benefit questions point the way the GUARD stores them: `selfTargetFor`
  // rewrites the legacy spelling onto `<base>_recipient_self` on every save, so
  // `_self` is the live question and the legacy key is the mirrored duplicate.
  it("a benefit answer lands on the canonical _self key the guard stores", () => {
    const r = guard("government_assistance", { ssi_recipient_self: true })
    expect(r.rejected).toEqual([])
    expect(r.data.ssi_recipient_self).toBe(true)
  })

  it("the legacy benefit spelling is still accepted and routed, never dropped", () => {
    const r = guard("government_assistance", { ssi_recipient: true })
    expect(r.data.ssi_recipient_self).toBe(true)
  })

})

describe("credit score is an answerable, bounded number", () => {
  it("accepts a real score as a number or a typed string", () => {
    expect(guard("financial_information", { credit_score: 720 }).data.credit_score).toBe(720)
    expect(guard("financial_information", { credit_score: "685" }).data.credit_score).toBe(685)
    expect(guard("financial_information", { credit_score: "" }).rejected).toEqual([])
  })

  it("rejects an impossible score loudly (never a silent 200)", () => {
    for (const bad of [900, 12, "abc", 3.7]) {
      const r = guard("financial_information", { credit_score: bad })
      expect(r.rejected.map((x) => x.reason)).toEqual(["format_mismatch"])
      expect(r.data.credit_score).toBeUndefined()
    }
  })

  it("the old 700+ toggle is hidden (deprecated) but still preserved when a client sends it", () => {
    const field = SECTION_METADATA.demographics.fields.find((f) => f.name === "good_credit_score")
    expect(field.deprecated).toBe(true)
    const r = guard("demographics", { good_credit_score: true })
    expect(r.rejected).toEqual([])
    expect(r.data.good_credit_score).toBe(true)
  })
})
