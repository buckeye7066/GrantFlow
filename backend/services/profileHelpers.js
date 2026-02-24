const normalizeStateName = (state) => {
    const stateMapping = {
        'California': 'CA',
        // add more states accordingly
    };
    return stateMapping[state] || state;
};