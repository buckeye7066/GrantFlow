import test from 'node:test'
import assert from 'node:assert/strict'
import { extractApkSignerSha256Digests } from '../../scripts/extract-apk-cert-fingerprints.mjs'

test('extracts the traditional numbered apksigner certificate label', () => {
  const output = 'Signer #1 certificate SHA-256 digest: AA:bb:01\n'

  assert.deepEqual(extractApkSignerSha256Digests(output), ['aabb01'])
})

test('extracts SDK-range signer labels emitted for rotated signing lineages', () => {
  const output = [
    'Signer (minSdkVersion=28, maxSdkVersion=32) certificate SHA-256 digest: ABCD01',
    'Signer (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647) certificate SHA-256 digest: EF:02',
  ].join('\n')

  assert.deepEqual(extractApkSignerSha256Digests(output), ['abcd01', 'ef02'])
})

test('ignores source-stamp and non-SHA-256 certificate lines', () => {
  const output = [
    'Source Stamp Signer certificate SHA-256 digest: DEAD',
    'Signer #1 certificate SHA-1 digest: BEEF',
    'Signer #1 public key SHA-256 digest: CAFE',
  ].join('\n')

  assert.deepEqual(extractApkSignerSha256Digests(output), [])
})

test('deduplicates equivalent signer certificates across signature schemes', () => {
  const output = [
    'Signer #1 certificate SHA-256 digest: AA:BB',
    'Signer (minSdkVersion=28, maxSdkVersion=2147483647) certificate SHA-256 digest: aabb',
  ].join('\n')

  assert.deepEqual(extractApkSignerSha256Digests(output), ['aabb'])
})
