import { createClientFromRequest } from "npm:@base44/sdk@0.8.4";

const PAGE_SIZE = 100;

function isRollingDeadline(opportunity = {}) {
  const raw = opportunity.deadline_type ?? opportunity.deadlineType ?? "";
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return false;
  return [
    "rolling",
    "ongoing",
    "open",
    "continuous",
  ].includes(normalized);
}

function isExpired(opportunity) {
  if (!opportunity?.deadlineAt) return false;
  if (isRollingDeadline(opportunity)) return false;
  try {
    const deadline = new Date(opportunity.deadlineAt).getTime();
    if (Number.isNaN(deadline)) return false;
    return deadline < Date.now();
  } catch {
    return false;
  }
}

async function fetchBatch(sdk, offset) {
  return await sdk.entities.FundingOpportunity.filter(
    {
      status: "open",
    },
    {
      limit: PAGE_SIZE,
      offset,
      order: [{ column: "deadlineAt", ascending: true }],
    },
  );
}

async function expireOpportunity(sdk, opportunity) {
  try {
    await sdk.entities.FundingOpportunity.update(opportunity.id, {
      status: "expired",
      expired_at: new Date().toISOString(),
    });
    return { id: opportunity.id, updated: true };
  } catch (error) {
    return { id: opportunity.id, updated: false, error: error.message };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { test_mode = false, sample_size = PAGE_SIZE } = await req.json()
      .catch(() => ({}));
    const sdk = base44.asServiceRole;

    const updates = [];
    let offset = 0;
    let processed = 0;

    while (processed < sample_size) {
      const batch = await fetchBatch(sdk, offset);
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const opportunity of batch) {
        if (!isExpired(opportunity)) continue;

        if (test_mode) {
          updates.push({ id: opportunity.id, updated: false, preview: true });
        } else {
          const result = await expireOpportunity(sdk, opportunity);
          updates.push(result);
        }

        processed += 1;
        if (processed >= sample_size) break;
      }

      offset += PAGE_SIZE;
    }

    return Response.json({
      ok: true,
      result: {
        processed,
        updates,
        sample_size,
        mode: test_mode ? "preview" : "execute",
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
