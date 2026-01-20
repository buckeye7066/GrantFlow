/**
 * Safely parse JSON with fallback value
 * @param {string} value - The JSON string to parse
 * @param {*} fallback - The fallback value to return if parsing fails
 * @returns {*} Parsed JSON or fallback value
 */
export function safeParseJSON(value, fallback = null) {
  if (value == null || value === '') {
    return fallback;
  }
  
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('Failed to parse JSON:', error.message);
    return fallback;
  }
}

/**
 * Safely stringify JSON
 * @param {*} value - The value to stringify
 * @param {string} fallback - The fallback string to return if stringification fails
 * @returns {string} JSON string or fallback
 */
export function safeStringifyJSON(value, fallback = '{}') {
  if (value == null) {
    return fallback;
  }
  
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('Failed to stringify JSON:', error.message);
    return fallback;
  }
}
