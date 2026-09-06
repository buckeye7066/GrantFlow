/**
 * Backend facade for the POINTER half of the Crawler OS four-gate contract.
 *
 * Twin of `config/fundingTruthPolicy.js`: keep every caller on this stable
 * config path while the implementation stays inside Crawler OS, where
 * discovery can enforce the contract without crossing the OS package boundary.
 * Re-exporting preserves one predicate authority repo-wide.
 */
export {
  pointerMatchedNeeds,
  pointerGeoEvidence,
  pointerProfileEvidence,
  pointerTruthVerdict,
  hasPositivePointerTruth,
} from '../crawler-os/pointerTruthPolicy.js'

export { default } from '../crawler-os/pointerTruthPolicy.js'
