export default function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store')
  response.status(503).json({
    ok: false,
    error: 'preview_backend_not_configured',
    message: 'This preview is isolated from production. Configure VITE_PREVIEW_API_URL for a staging backend.',
  })
}
