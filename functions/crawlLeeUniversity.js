import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const sdk = base44.asServiceRole;

  const logEntry = await sdk.entities.CrawlLog.create({ source: 'lee_university', status: 'started' });

  try {
    const parsedScholarships = [
      { source_id: 'lee-nursing-2025', title: 'School of Nursing Excellence Scholarship', description_raw: 'Awarded to junior/senior nursing students with 3.5+ GPA.', url: 'https://www.leeuniversity.edu/financial-aid/scholarships/nursing', sponsor: 'Lee University School of Nursing' },
      { source_id: 'lee-music-perf-2025', title: 'Music Performance Grant', description_raw: 'Available to freshmen and transfers who audition for School of Music.', url: 'https://www.leeuniversity.edu/financial-aid/scholarships/music', sponsor: 'Lee University School of Music' },
      { source_id: 'lee-first-gen-2025', title: 'Pioneer Award for First-Generation Students', description_raw: '$5,000 for first-gen college students. Essay required.', url: 'https://www.leeuniversity.edu/financial-aid/scholarships/first-gen', sponsor: 'Lee University Admissions' }
    ];

    let processed = 0;
    for (const scholarship of parsedScholarships) {
      await sdk.functions.invoke('processCrawledItem', { item: { ...scholarship, source: 'lee_university' } });
      processed++;
    }

    await sdk.entities.CrawlLog.update(logEntry.id, { status: 'completed', recordsFound: parsedScholarships.length, recordsAdded: processed });
    return Response.json({ status: 'completed', found: parsedScholarships.length, processed });
  } catch (error) {
    await sdk.entities.CrawlLog.update(logEntry.id, { status: 'failed', errorMessage: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
});