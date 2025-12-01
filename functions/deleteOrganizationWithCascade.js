import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { organization_id } = await req.json();
    if (!organization_id) return Response.json({ error: 'organization_id required' }, { status: 400 });

    const sdk = base44.asServiceRole;
    const org = await sdk.entities.Organization.get(organization_id);
    if (!org) return Response.json({ success: true, message: 'Already deleted' });

    let deleted = { grants: 0, documents: 0, contacts: 0, timeEntries: 0, expenses: 0, invoices: 0 };

    // Delete grants and related data
    const grants = await sdk.entities.Grant.filter({ organization_id });
    for (const grant of grants) {
      const sections = await sdk.entities.ProposalSection.filter({ grant_id: grant.id });
      for (const s of sections) await sdk.entities.ProposalSection.delete(s.id);
      
      const budgets = await sdk.entities.Budget.filter({ grant_id: grant.id });
      for (const b of budgets) await sdk.entities.Budget.delete(b.id);
      
      const milestones = await sdk.entities.Milestone.filter({ grant_id: grant.id });
      for (const m of milestones) await sdk.entities.Milestone.delete(m.id);
      
      await sdk.entities.Grant.delete(grant.id);
      deleted.grants++;
    }

    // Delete documents
    const documents = await sdk.entities.Document.filter({ organization_id });
    for (const doc of documents) await sdk.entities.Document.delete(doc.id);
    deleted.documents = documents.length;

    // Delete contact methods
    const contactMethods = await sdk.entities.ContactMethod.filter({ organization_id });
    for (const c of contactMethods) await sdk.entities.ContactMethod.delete(c.id);
    deleted.contacts = contactMethods.length;

    // Delete time entries
    const timeEntries = await sdk.entities.TimeEntry.filter({ organization_id });
    for (const t of timeEntries) await sdk.entities.TimeEntry.delete(t.id);
    deleted.timeEntries = timeEntries.length;

    // Delete expenses
    const expenses = await sdk.entities.Expense.filter({ organization_id });
    for (const e of expenses) await sdk.entities.Expense.delete(e.id);
    deleted.expenses = expenses.length;

    // Delete invoices
    const invoices = await sdk.entities.Invoice.filter({ organization_id });
    for (const inv of invoices) {
      const lines = await sdk.entities.InvoiceLine.filter({ invoice_id: inv.id });
      for (const l of lines) await sdk.entities.InvoiceLine.delete(l.id);
      await sdk.entities.Invoice.delete(inv.id);
      deleted.invoices++;
    }

    // Delete organization
    await sdk.entities.Organization.delete(organization_id);

    return Response.json({ success: true, message: 'Organization deleted', deleted });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});