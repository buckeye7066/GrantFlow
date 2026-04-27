# Profile Fields

`src/config/sectionMetadata.js` is the canonical source of truth for profile
section fields. Every persisted profile field must be declared there with:

- `name`
- `label`
- `format`
- `help`
- optional section or field applicability rules

Labels use sentence case. The first character is uppercase and later words are
lowercase unless they are approved acronyms or proper nouns such as GPA, SAT,
ACT, EIN, CAGE, NICRA, NTEE, EMS, HIV, AIDS, TBI, SSDI, SSI, SNAP, TANF, IEP,
ESL, FAFSA, IRS, DUNS, UEI, NIH, NSF, DOD, VA, USDA, HHS, ZIP, USD, LGBTQ,
Appalachian, Gold Star, 501(c)(3), and Section 8.

Renderers and save guards must not invent labels or accept fields that are not
declared in metadata. Add a metadata row before adding any new AI-filled,
user-entered, imported, or migrated profile field.
