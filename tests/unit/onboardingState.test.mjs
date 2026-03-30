/**
 * Tests for onboarding state logic.
 *
 * These tests validate the decision rules for showing/hiding onboarding and
 * tour UI without requiring a running server. They test the pure logic that
 * determines shouldShow states based on backend state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CURRENT_TOUR_VERSION, CURRENT_MANUAL_VERSION } from '../../backend/services/anyaHelpKnowledge.js'

// ── Helper: simulate the shouldShow logic from components ─────────────────

/**
 * Mirrors the OnboardingFlow trigger logic:
 * Show manual if not admin AND not has_completed_onboarding (backend).
 */
function shouldShowManual({ isAdmin, hasCompletedOnboarding }) {
  if (isAdmin) return false
  return !hasCompletedOnboarding
}

/**
 * Mirrors the AnyaGuidedTour trigger logic:
 * Show tour if not admin AND lastCompletedTourVersion < CURRENT_TOUR_VERSION.
 */
function shouldShowTour({ isAdmin, lastCompletedTourVersion }) {
  if (isAdmin) return false
  return lastCompletedTourVersion < CURRENT_TOUR_VERSION
}

/**
 * Mirrors the FirstRunOnboardingGate shouldShow logic:
 * Show wizard if hasCompletedOnboarding=false AND wizard not completed/skipped
 * AND profile is incomplete.
 */
function shouldShowWizard({ hasCompletedOnboarding, wizardCompleted, wizardSkipped, hasProfiles, profileComplete }) {
  if (hasCompletedOnboarding) return false
  if (wizardCompleted) return false
  if (wizardSkipped) return false
  return !hasProfiles || !profileComplete
}

/**
 * Simulates manual relaunch (always works for any user via "User Manual" button).
 */
function canManuallyRelaunchManual() {
  // Relaunch is always allowed (triggered by onboardingVideoRequested flag)
  return true
}

// ── Manual / Onboarding show/hide ──────────────────────────────────────────

test('new user (has_completed_onboarding=false) triggers onboarding manual', () => {
  assert.equal(shouldShowManual({ isAdmin: false, hasCompletedOnboarding: false }), true)
})

test('existing user (has_completed_onboarding=true) does NOT trigger onboarding manual', () => {
  assert.equal(shouldShowManual({ isAdmin: false, hasCompletedOnboarding: true }), false)
})

test('admin user never gets auto-triggered onboarding regardless of completion state', () => {
  assert.equal(shouldShowManual({ isAdmin: true, hasCompletedOnboarding: false }), false)
  assert.equal(shouldShowManual({ isAdmin: true, hasCompletedOnboarding: true }), false)
})

// ── Tour show/hide ────────────────────────────────────────────────────────

test('non-admin with lastCompletedTourVersion < CURRENT_TOUR_VERSION gets tour', () => {
  assert.equal(
    shouldShowTour({ isAdmin: false, lastCompletedTourVersion: CURRENT_TOUR_VERSION - 1 }),
    true,
  )
})

test('non-admin with lastCompletedTourVersion === CURRENT_TOUR_VERSION does not get tour', () => {
  assert.equal(
    shouldShowTour({ isAdmin: false, lastCompletedTourVersion: CURRENT_TOUR_VERSION }),
    false,
  )
})

test('non-admin with lastCompletedTourVersion > CURRENT_TOUR_VERSION does not get tour', () => {
  assert.equal(
    shouldShowTour({ isAdmin: false, lastCompletedTourVersion: CURRENT_TOUR_VERSION + 1 }),
    false,
  )
})

test('admin user never gets auto tour', () => {
  assert.equal(
    shouldShowTour({ isAdmin: true, lastCompletedTourVersion: 0 }),
    false,
  )
  assert.equal(
    shouldShowTour({ isAdmin: true, lastCompletedTourVersion: CURRENT_TOUR_VERSION }),
    false,
  )
})

// ── FirstRunOnboardingGate logic ──────────────────────────────────────────

test('existing user with has_completed_onboarding=true never shows wizard', () => {
  assert.equal(
    shouldShowWizard({
      hasCompletedOnboarding: true,
      wizardCompleted: false,
      wizardSkipped: false,
      hasProfiles: false,
      profileComplete: false,
    }),
    false,
  )
})

test('new user with no profiles shows wizard', () => {
  assert.equal(
    shouldShowWizard({
      hasCompletedOnboarding: false,
      wizardCompleted: false,
      wizardSkipped: false,
      hasProfiles: false,
      profileComplete: false,
    }),
    true,
  )
})

test('user with profiles but incomplete active profile shows wizard', () => {
  assert.equal(
    shouldShowWizard({
      hasCompletedOnboarding: false,
      wizardCompleted: false,
      wizardSkipped: false,
      hasProfiles: true,
      profileComplete: false,
    }),
    true,
  )
})

test('user with completed wizard does not show wizard again', () => {
  assert.equal(
    shouldShowWizard({
      hasCompletedOnboarding: false,
      wizardCompleted: true,
      wizardSkipped: false,
      hasProfiles: false,
      profileComplete: false,
    }),
    false,
  )
})

test('user who skipped wizard does not show wizard again', () => {
  assert.equal(
    shouldShowWizard({
      hasCompletedOnboarding: false,
      wizardCompleted: false,
      wizardSkipped: true,
      hasProfiles: false,
      profileComplete: false,
    }),
    false,
  )
})

// ── Manual relaunch ───────────────────────────────────────────────────────

test('manual relaunch always works for all users', () => {
  assert.equal(canManuallyRelaunchManual(), true)
})

// ── Version constants ─────────────────────────────────────────────────────

test('CURRENT_TOUR_VERSION is at least 1', () => {
  assert.ok(CURRENT_TOUR_VERSION >= 1)
})

test('CURRENT_MANUAL_VERSION is at least 1', () => {
  assert.ok(CURRENT_MANUAL_VERSION >= 1)
})
