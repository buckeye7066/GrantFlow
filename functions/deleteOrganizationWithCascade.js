import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Delete Organization With Cascade - Removes organization and all related data
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { organization_id } = await req.json();
    if (!organization_id) return Response.json({ error: 'organization_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const org = await sdk.entities.Organization.get(organization_id);
    if (!org) return Response.json({ success: true, message: 'Already deleted', deleted: {} });

    let deleted = { grants: 0, documents: 0, contacts: 0, invoices: 0 };

    const grants = await sdk.entities.Grant.filter({ organization_id });
    for (const g of grants) {
      const sections = await sdk.entities.ProposalSection.filter({ grant_id: g.id });
      for (const s of sections) await sdk.entities.ProposalSection.delete(s.id);
      const budgets = await sdk.entities.Budget.filter({ grant_id: g.id });
      for (const b of budgets) await sdk.entities.Budget.delete(b.id);
      await sdk.entities.Grant.delete(g.id);
      deleted.grants++;
    }

    const docs = await sdk.entities.Document.filter({ organization_id });
    for (const d of docs) { await sdk.entities.Document.delete(d.id); deleted.documents++; }

    const contacts = await sdk.entities.ContactMethod.filter({ organization_id });
    for (const c of contacts) { await sdk.entities.ContactMethod.delete(c.id); deleted.contacts++; }

    const invoices = await sdk.entities.Invoice.filter({ organization_id });
    for (const i of invoices) { await sdk.entities.Invoice.delete(i.id); deleted.invoices++; }

    await sdk.entities.Organization.delete(organization_id);

    return Response.json({ success: true, deleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});