function calculateMatchScore(profile, opportunity) {
    const matchedSignals = [];
    const scores = {};
    const reasons = {};

    // Build a searchable text blob from the opportunity object fields
    const opportunityText = [
        opportunity?.title || '',
        opportunity?.description || '',
        ...(Array.isArray(opportunity?.categories) ? opportunity.categories : []),
        ...(Array.isArray(opportunity?.keywords) ? opportunity.keywords : []),
    ].join(' ').toLowerCase();

    // Support both profile.signals.keywordSet (enrichedProfile) and bare signals
    const effectiveSignals = profile?.signals || profile;

    // Match each keyword against the opportunity text using whole-word boundaries
    if (effectiveSignals?.keywordSet) {
        for (const keyword of effectiveSignals.keywordSet) {
            // Escape special regex chars so keywords like "501(c)(3)" don't throw
            const escaped = String(keyword).replace(/[.*+?^${}()|[\\]\]/g, '\$&');
            const regex = new RegExp(`\b${escaped}\b`, 'g'); // \b = word boundary
            if (regex.test(opportunityText)) {
                matchedSignals.push(`kw:${keyword}`);
            }
        }
    }

    return {
        score: scores,
        reasons: reasons,
        matchedSignals: matchedSignals,
    };
}