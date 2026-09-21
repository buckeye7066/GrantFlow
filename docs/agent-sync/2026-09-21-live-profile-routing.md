# Preserve registered identity during live crawler planning

The authenticated five-profile audit found a declared small business routed as
family/nonprofit/business/government. Its unregistered organization description
overrode the registered business identity. Crawler OS then fell back to scanning
profile prose, treating the county in its geographic focus as government identity.

resolveEffectiveProfileType now prefers specific registered candidates before
unregistered descriptions. Existing precedence between registered section types
and generic defaults remains. Unknown descriptions remain available when no
specific registered identity exists. No stored applicant facts were rewritten.

The regression follows type resolution through the production thesis bridge and
asserts business routing without family/government buckets. Eleven Node tests and
42 profile/version tests passed. PROFILE_SIGNAL_VERSION advances so stored
explanations are rescored after deployment. Live rerun acceptance remains pending.
