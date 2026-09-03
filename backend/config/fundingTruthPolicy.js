/**
 * Backend facade for the Crawler OS four-truth funding contract.
 *
 * Keep all callers on this stable config path while the implementation remains
 * inside Crawler OS, where discovery can enforce it without crossing the OS
 * package boundary. Re-exporting preserves one predicate authority repo-wide.
 */
export {
  fundingTruthProofFrom,
  hasPositiveFourTruthProof,
  isVerifiedDirectFundingRecommendation,
} from '../crawler-os/fundingTruthPolicy.js'

export { default } from '../crawler-os/fundingTruthPolicy.js'
