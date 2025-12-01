/**
 * SAFE HANDLER WRAPPER
 */

export function safeHandler(handler, options = {}) {
  const { name = 'unknown', skipSelfCheck = false } = options;
  
  return async (req) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    
    try {
      let body = {};
      try {
        const clonedReq = req.clone();
        body = await clonedReq.json();
      } catch {
      }
      
      if (body.selfCheck === true) {
        if (skipSelfCheck) {
          return Response.json({
            ok: true,
            error: null,
            data: { function: name, status: 'skipped', reason: 'Function marked with skipSelfCheck' }
          });
        }
        
        return Response.json({
          ok: true,
          error: null,
          data: { function: name, status: 'healthy', timestamp: new Date().toISOString() }
        });
      }
      
      const result = await handler(req);
      
      if (result instanceof Response) {
        try {
          const clonedResult = result.clone();
          const json = await clonedResult.json();
          if (typeof json.ok === 'boolean') return result;
          return Response.json({ ok: true, error: null, data: json }, { status: result.status });
        } catch {
          return result;
        }
      }
      
      return Response.json({ ok: true, error: null, data: result });
      
    } catch (error) {
      // Avoid logging full error stack or sensitive data - print only the error message and requestId.
      console.error('[' + name + '][' + requestId + '] Handler error:', error?.message || String(error));
      return Response.json({ ok: false, error: error?.message || 'Unknown error', data: null }, { status: 500 });
    }
  };
}

export function createSafeServer(handler, options = {}) {
  return Deno.serve(safeHandler(handler, options));
}

export function toEnvelope(response) {
  if (typeof response.ok === 'boolean') return response;
  if (response.success === true) return { ok: true, error: null, data: response };
  if (response.success === false || response.error) return { ok: false, error: response.error || response.message || 'Unknown error', data: null };
  return { ok: true, error: null, data: response };
}