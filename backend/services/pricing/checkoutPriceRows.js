/** Milestone total rows describe the contract; only its installments are sold. */
export async function listCheckoutPriceRows(db) {
  return db.prepare(`
    SELECT sci.id AS service_id, sci.slug, sci.slug AS service_slug,
           sci.name, sci.name AS service_name, sci.pricing_model,
           sp.id AS service_price_id, sp.client_category, sp.amount_cents,
           sp.currency, sp.milestone_phase, sp.stripe_price_id, sp.active
      FROM service_catalog_items sci
      JOIN service_prices sp ON sp.service_id = sci.id
     WHERE sci.is_active = TRUE AND sp.active = TRUE
       AND NOT (sci.pricing_model = 'milestone' AND COALESCE(sp.milestone_phase, '') = '')
     ORDER BY sci.name, sp.client_category, sp.milestone_phase
  `).all()
}
