import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { organization_id, grant_id, profile_id, type, status, processing_status } = req.query;
    let query = 'SELECT * FROM documents WHERE 1=1';
    const params = [];
    if (organization_id) { query += ' AND organization_id = ?'; params.push(organization_id); }
    if (grant_id) { query += ' AND grant_id = ?'; params.push(grant_id); }
    if (profile_id) { query += ' AND profile_id = ?'; params.push(profile_id); }
    if (type) { query += ' AND type = ?'; params.push(type); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (processing_status) { query += ' AND processing_status = ?'; params.push(processing_status); }
    query += ' ORDER BY created_at DESC';
    res.json(req.db.prepare(query).all(...params));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const doc = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const id = crypto.randomUUID();
    const {
      organization_id,
      grant_id,
      profile_id,
      name,
      type,
      file_url,
      file_path,
      file_size,
      mime_type,
      status = 'draft',
      notes = null,
    } = req.body ?? {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    req.db
      .prepare(
        `INSERT INTO documents (
            id,
            organization_id,
            grant_id,
            profile_id,
            name,
            type,
            file_url,
            file_path,
            file_size,
            mime_type,
            status,
            notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        organization_id ?? null,
        grant_id ?? null,
        profile_id ?? null,
        name,
        type ?? null,
        file_url ?? null,
        file_path ?? null,
        file_size ?? null,
        mime_type ?? null,
        status,
        notes,
      );

    if (profile_id) {
      req.db
        .prepare(
          `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
        )
        .run(profile_id, id);
    }

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ingest', (req, res) => {
  try {
    const {
      profile_id,
      organization_id,
      grant_id,
      name,
      type,
      file_url,
      file_path,
      file_size,
      mime_type,
      extracted_text,
      notes = null,
      source = null,
    } = req.body ?? {};

    if (!profile_id) {
      return res.status(400).json({ error: 'profile_id is required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const profile = req.db
      .prepare('SELECT id FROM profiles WHERE id = ?')
      .get(profile_id);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const id = crypto.randomUUID();
    req.db
      .prepare(
        `INSERT INTO documents (
          id,
          organization_id,
          grant_id,
          profile_id,
          name,
          type,
          file_url,
          file_path,
          file_size,
          mime_type,
          extracted_text,
          processing_status,
          status,
          notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'draft', ?)`
      )
      .run(
        id,
        organization_id ?? null,
        grant_id ?? null,
        profile_id,
        name,
        type ?? null,
        file_url ?? null,
        file_path ?? null,
        file_size ?? null,
        mime_type ?? null,
        extracted_text ?? null,
        notes,
      );

    req.db
      .prepare(
        `INSERT OR IGNORE INTO profile_documents (profile_id, document_id) VALUES (?, ?)`
      )
      .run(profile_id, id);

    const parameters = JSON.stringify({
      document_id: id,
      source,
    });

    req.db
      .prepare(
        `INSERT INTO crawler_jobs (
          type,
          status,
          profile_id,
          organization_id,
          parameters,
          requested_by
        ) VALUES ('document_ingest', 'queued', ?, ?, ?, ?)`
      )
      .run(profile_id, organization_id ?? null, parameters, profile_id);

    const document = req.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    res.status(202).json(document);
  } catch (error) {
    console.error('Document ingestion enqueue failed:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    req.db.prepare(`UPDATE documents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values, req.params.id);
    res.json(req.db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    req.db.prepare('DELETE FROM profile_documents WHERE document_id = ?').run(req.params.id);
    req.db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
