/**
 * Native-app detection (Capacitor Android/iOS builds).
 *
 * Google Play's payments policy requires Play Billing for in-app purchases of
 * digital goods, and Apple applies the equivalent IAP rule. GrantFlow bills
 * clients on the web via Stripe, which is only store-compliant if the
 * installed app never offers a purchase flow or steers users toward an
 * external one (the "reader app" model). Every purchase surface (public
 * Pricing page, PricingCheckoutPanel) checks this flag and renders a neutral
 * notice in native builds instead.
 *
 * The same web bundle ships to Vercel and Capacitor; only the Capacitor
 * runtime injects window.Capacitor, so this is a runtime check.
 */
export function isNativeApp() {
  const cap = typeof window !== 'undefined' ? window.Capacitor : undefined
  if (!cap) return false
  return typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : !!cap.isNative
}
