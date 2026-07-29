import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(
  new URL('../../src/components/onboarding/OnboardingVideo.jsx', import.meta.url),
  'utf8',
)

test('onboarding never requests the retired empty local MP4', () => {
  assert.doesNotMatch(source, /Grant Flow_ Get Started\. ?mp4/)
  assert.doesNotMatch(source, /VIDEO_FILENAMES/)
  assert.match(source, /VITE_ONBOARDING_VIDEO_URL/)
})

test('no configured video renders a complete in-app walkthrough', () => {
  assert.match(source, /const showVideo = Boolean\(videoUrl\) && !videoError/)
  assert.match(source, /Your three-step GrantFlow walkthrough/)
  assert.match(source, /No video download or external media is required/)
  assert.match(source, /Continue to GrantFlow/)
})

test('a configured media failure falls back without a console error', () => {
  assert.match(source, /console\.warn\('\[onboarding-video\]/)
  assert.doesNotMatch(source, /console\.error\('\[onboarding-video\]/)
  assert.match(source, /setVideoError\(true\)/)
})
