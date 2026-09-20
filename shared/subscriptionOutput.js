// Subscription usage counters are accounting, not proof of truncation.
// Native process output remains bounded separately; accepted text has this hard cap.
export const MAX_SUBSCRIPTION_OUTPUT_BYTES = 262144;
export function withinSubscriptionOutputLimit(result, requestedTokens) {
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens < 2 ||
      result?.complete !== true || typeof result.raw !== 'string' || !result.raw.trim() ||
      new TextEncoder().encode(result.raw).byteLength > MAX_SUBSCRIPTION_OUTPUT_BYTES ||
      !Number.isSafeInteger(result.usage?.output_tokens) || result.usage.output_tokens <= 0) return false;
  if (result.provider === 'subscription:codex') return true;
  // Claude's CLI receives an actual output-token limit. Preserve that contract.
  return result.provider === 'subscription:claude' && result.usage.output_tokens < requestedTokens;
}
