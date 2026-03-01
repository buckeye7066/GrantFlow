function calculateMatchScore(opportunityText, effectiveSignals) {
    const matchedSignals = [];
    const scores = {};
    const reasons = {};

    // Existing logic to calculate scores and reasons...

    // Adding matched signals
    for (const keyword of effectiveSignals.keywordSet) {
        const regex = new RegExp(`\b${keyword}\b`, 'g'); // match whole word
        if (regex.test(opportunityText)) {
            matchedSignals.push(`kw:${keyword}`);
        }
    }

    return {
        score: scores,
        reasons: reasons,
        matchedSignals: matchedSignals
    };
}