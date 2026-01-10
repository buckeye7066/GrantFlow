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
    // Parsing failures are common when reading user/DB input; keep this utility quiet by default.
    // Opt-in logging for debugging by setting SAFE_JSON_LOG=1.
    if (process?.env?.SAFE_JSON_LOG === '1') {
      console.warn('Failed to parse JSON:', error.message);
    }
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
    // Opt-in logging for debugging by setting SAFE_JSON_LOG=1.
    if (process?.env?.SAFE_JSON_LOG === '1') {
      console.warn('Failed to stringify JSON:', error.message);
    }
    return fallback;
  }
}
