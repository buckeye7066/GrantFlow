import { createClientFromRequest } from "npm:@base44/sdk@0.8.4";

const DEFAULT_CRAWLERS = [
  "crawlLocalSources",
  "crawlBenefitsGov",
  "crawlGrantsGov",
  "crawlDSIRE",
];

async function invokeCrawler(base44, functionName, payload) {
  try {
    const response = await base44.functions.invoke(functionName, payload);
    if (response?.error) {
      return {
        functionName,
        ok: false,
        error: response.error,
      };
    }

    const result = response?.result ?? response ?? {};
    const count = Array.isArray(result?.opportunities)
      ? result.opportunities.length
      : (
        result?.regions?.reduce?.(
          (acc, region) => acc + (region.count ?? 0),
          0,
        ) ?? 0
      );

    return {
      functionName,
      ok: true,
      count,
      details: result,
    };
  } catch (error) {
    return {
      functionName,
      ok: false,
      error: error.message,
    };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { profile_id, crawlers = DEFAULT_CRAWLERS, test_mode = true } =
      await req.json();

    if (!profile_id) {
      return Response.json({ ok: false, error: "profile_id is required" }, {
        status: 400,
      });
    }

    const payload = { profile_id, test_mode };
    const results = [];

    for (const functionName of crawlers) {
      const outcome = await invokeCrawler(base44, functionName, payload);
      results.push(outcome);
    }

    const failures = results.filter((r) => !r.ok);

    return Response.json({
      ok: failures.length === 0,
      result: {
        profile_id,
        crawlers: results,
        failures: failures.length,
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
