# Profile data points (canonical comprehensive application schema)

GrantFlow stores “comprehensive application” data as JSON sections in `profile_sections.data`.

This repo now has a **single source of truth** for every profile data point and its meaning:

- `backend/config/profileSchema.js`

The backend also exposes it for UI/ops tooling:

- `GET /api/profiles/schema`

## Sections + fields

The schema is the authoritative list. In short:

- **basic_information**: identity + contact + location (name, email, phone, address, city/state/zip, DOB/age, gender, category, notes)
- **organization_details**: org identifiers and capacity (type, EIN/UEI/CAGE, budget, staff, mission, notes)
- **financial_information**: income/need signals (household income/size, need level, low-income/unemployed/displaced-worker flags, notes)
- **government_assistance**: benefits flags (Medicaid/Medicare/SSI/SSDI/SNAP/TANF/Section 8, other programs)
- **health_medical**: health/disability flags and types (dialysis/transplant/HIV/TBI/amputee/neurodivergent/etc.)
- **demographics**: demographic identifiers (race/ethnicity flags, tribal affiliation, LGBTQ+, immigrant status, notes)
- **family_life**: family and life situation flags (single parent, foster youth, widowed, homeless, DV survivor, etc.)
- **military_service**: veteran/military family flags + notes
- **occupation**: job/role flags + notes
- **location_focus**: rural/Appalachia/underserved + geographic focus + notes
- **university_applications**: student application tracking array
- **narrative**: mission/story/goal fields used heavily for matching

For exact field names, defaults, and human-readable explanations, use:

- `GET /api/profiles/schema`

