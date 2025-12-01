/**
 * Calculates the dot product of two vectors.
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number}
 */
function dotProduct(vecA, vecB) {
  let product = 0;
  for (let i = 0; i < vecA.length; i++) {
    product += vecA[i] * vecB[i];
  }
  return product;
}

/**
 * Calculates the magnitude (or length) of a vector.
 * @param {number[]} vec
 * @returns {number}
 */
function magnitude(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * Calculates the cosine similarity between two vectors.
 * Returns a value between -1 and 1.
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number}
 */
export function cosineSimilarity(vecA, vecB) {
  // Basic validation
  if (!vecA || !vecB || !Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  const product = dotProduct(vecA, vecB);
  const magA = magnitude(vecA);
  const magB = magnitude(vecB);

  // Handle case where one or both vectors have zero magnitude
  if (magA === 0 || magB === 0) {
    return 0;
  }

  return product / (magA * magB);
}