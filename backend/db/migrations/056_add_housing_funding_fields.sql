-- Add housing funding classification fields to funding_opportunities
-- These columns support the off-campus living expense discovery feature:
-- funding_category classifies how funds can be used
-- usable_for_housing indicates funds can cover rent/utilities/food
-- refund_potential indicates excess funds may be refunded to the student
-- eligibility_signals stores structured eligibility criteria (GPA, faith, talent, etc.)
-- verification_status tracks URL/data verification state

ALTER TABLE funding_opportunities ADD COLUMN funding_category TEXT;
ALTER TABLE funding_opportunities ADD COLUMN usable_for_housing INTEGER DEFAULT 0;
ALTER TABLE funding_opportunities ADD COLUMN refund_potential INTEGER DEFAULT 0;
ALTER TABLE funding_opportunities ADD COLUMN eligibility_signals TEXT;
ALTER TABLE funding_opportunities ADD COLUMN verification_status TEXT DEFAULT 'needs_review';

CREATE INDEX IF NOT EXISTS idx_fo_funding_category ON funding_opportunities(funding_category);
CREATE INDEX IF NOT EXISTS idx_fo_usable_for_housing ON funding_opportunities(usable_for_housing);
CREATE INDEX IF NOT EXISTS idx_fo_verification_status ON funding_opportunities(verification_status);

-- Backfill funding_category from existing opportunity_type and funding_type data
UPDATE funding_opportunities SET funding_category = CASE
  WHEN opportunity_type = 'scholarship' AND (
    description LIKE '%refund%' OR description LIKE '%excess%' OR
    description LIKE '%remaining balance%' OR description LIKE '%disbursed to student%' OR
    description LIKE '%direct to student%' OR description LIKE '%stipend%'
  ) THEN 'refund_eligible'
  WHEN opportunity_type = 'scholarship' AND (
    description LIKE '%tuition only%' OR description LIKE '%tuition-only%' OR
    description LIKE '%applied directly to tuition%' OR description LIKE '%pays tuition%'
  ) THEN 'tuition_only'
  WHEN funding_type = 'benefit' AND (
    description LIKE '%stipend%' OR description LIKE '%living%' OR
    description LIKE '%monthly payment%'
  ) THEN 'stipend'
  WHEN description LIKE '%housing%' OR description LIKE '%dormitor%' OR
    description LIKE '%resident%advisor%' OR description LIKE '%RA position%' OR
    description LIKE '%room and board%'
  THEN 'housing_direct'
  WHEN description LIKE '%faith%' OR description LIKE '%church%' OR
    description LIKE '%christian%' OR description LIKE '%ministry%' OR
    description LIKE '%religious%' OR title LIKE '%faith%' OR title LIKE '%church%'
  THEN 'faith_based'
  WHEN description LIKE '%music%' OR description LIKE '%art%' OR
    description LIKE '%athletic%' OR description LIKE '%talent%' OR
    description LIKE '%perform%' OR title LIKE '%music%' OR title LIKE '%talent%'
  THEN 'talent_based'
  WHEN description LIKE '%cost of attendance%' OR description LIKE '%COA%' OR
    description LIKE '%financial aid appeal%' OR description LIKE '%adjustment%'
  THEN 'coa_adjustment'
  ELSE NULL
END
WHERE funding_category IS NULL;

-- Backfill usable_for_housing based on funding_category
UPDATE funding_opportunities SET usable_for_housing = 1
WHERE funding_category IN ('refund_eligible', 'stipend', 'housing_direct', 'coa_adjustment')
  AND usable_for_housing = 0;

-- Backfill refund_potential for scholarship types
UPDATE funding_opportunities SET refund_potential = 1
WHERE funding_category = 'refund_eligible'
  AND refund_potential = 0;

-- Mark scholarships that exceed typical tuition as refund_potential
UPDATE funding_opportunities SET refund_potential = 1
WHERE opportunity_type = 'scholarship'
  AND amount_max > 10000
  AND refund_potential = 0
  AND funding_category IS NULL;
