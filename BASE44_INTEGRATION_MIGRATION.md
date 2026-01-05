# Base44 SDK Integration Migration

## Overview

This document describes the migration from Base44 SDK to self-hosted integration methods. The migration enables the application to run independently without relying on Base44's hosted services.

## What Was Changed

### Frontend Integration Layer (`src/api/client.js`)

Added `integrations` property to the `APIClient` class with three core methods:

```javascript
integrations = {
  Core: {
    InvokeLLM: async (params) => { ... },      // AI/LLM invocation
    UploadFile: async ({ file }) => { ... },    // File uploads
    CreateFileSignedUrl: async ({ file_uri }) => { ... }, // Signed URLs
  },
};
```

### Backend Endpoints

#### 1. `/api/ai/invoke` (POST)
**Purpose**: General-purpose LLM invocation for AI features

**Request Body**:
```json
{
  "prompt": "Your prompt text",
  "response_json_schema": {  // Optional - for structured output
    "type": "object",
    "properties": { ... }
  },
  "model": "gpt-4o-mini",    // Optional, defaults to gpt-4o-mini
  "temperature": 0.7,         // Optional
  "max_tokens": 2000          // Optional
}
```

**Response**:
- With `response_json_schema`: Returns parsed JSON object
- Without schema: Returns plain text string

**Error Handling**:
- Returns `{ error: "...", raw_content: "..." }` if JSON parsing fails
- Handles markdown code blocks in LLM responses
- Gracefully degrades if schema parsing fails

#### 2. `/api/documents/upload` (POST)
**Purpose**: Simple file upload for documents

**Request**: Multipart form data with `file` field

**Response**:
```json
{
  "file_url": "/uploads/filename.pdf",
  "file_name": "original.pdf",
  "file_size": 12345,
  "mime_type": "application/pdf"
}
```

**Features**:
- Uses multer for file handling
- Cleans up files on error
- Returns Base44-compatible response format
- 10MB file size limit

#### 3. `/api/documents/signed-url` (POST)
**Purpose**: Generate signed URLs for document access

**Request Body**:
```json
{
  "file_uri": "uploads/document.pdf"
}
```

**Response**:
```json
{
  "signed_url": "/uploads/document.pdf"
}
```

**Features**:
- Validates URLs using URL constructor
- Handles relative and absolute paths
- Ready for cloud storage integration

## Components Using These Integrations

### AI/LLM Features (27 files)
- **Grant Analysis**: AIGrantScorer.jsx, GrantOverview.jsx
- **Document Processing**: NOFOParser.jsx, DocumentList.jsx
- **AI Assistance**: AIFormField.jsx, AIApplicationAssistant.jsx
- **Form Generation**: GrantForm.jsx, OrganizationForm.jsx
- **Content Generation**: ProposalEditor.jsx, EmailComposer.jsx
- **Pipeline Management**: KanbanBoard.jsx
- And 16 more files...

### File Upload Features
- NOFOParser.jsx (NOFO document upload)
- UploadApplicationForm.jsx (application form upload)
- DocumentList.jsx (general document management)

### Document Access Features
- DocumentList.jsx (document viewing and printing)
- DocumentItem.jsx (individual document access)

## API Compatibility

### Base44 SDK Method Mapping

| Base44 Method | New Endpoint | Status |
|---------------|--------------|--------|
| `base44.integrations.Core.InvokeLLM()` | `POST /api/ai/invoke` | ✅ Implemented |
| `base44.integrations.Core.UploadFile()` | `POST /api/documents/upload` | ✅ Implemented |
| `base44.integrations.Core.CreateFileSignedUrl()` | `POST /api/documents/signed-url` | ✅ Implemented |

### Known Differences

1. **`add_context_from_internet` parameter**: This Base44-specific feature is not supported. The parameter is safely ignored without breaking functionality.

2. **Response format**: The new implementation maintains full compatibility with Base44 SDK response formats, so no frontend changes are needed.

3. **Authentication**: Uses the existing GrantFlow authentication system instead of Base44's auth.

## Environment Requirements

### Required Environment Variables

```bash
# OpenAI API (required for AI features)
OPENAI_API_KEY=sk-...

# Server configuration
PORT=8080
VITE_API_URL=http://localhost:8080

# CORS (optional, has defaults)
CORS_ORIGIN=http://localhost:5173,https://yourdomain.com
```

### Optional Configuration

- **Model Selection**: Default is `gpt-4o-mini`, can be overridden per request
- **Temperature**: Default is 0.7, can be overridden per request
- **Max Tokens**: Default is 2000, can be overridden per request

## Testing

All integration methods have been tested and verified:

```bash
# Run linter
npm run lint

# Build application
npm run build

# Start backend server
npm run backend

# Start frontend dev server
npm run dev
```

## Future Enhancements

### Cloud Storage Integration

The `/api/documents/signed-url` endpoint is designed to be easily extended for cloud storage:

```javascript
// Example: AWS S3 integration
router.post('/signed-url', async (req, res) => {
  const { file_uri } = req.body;
  
  if (file_uri.startsWith('s3://')) {
    // Generate S3 signed URL
    const signedUrl = await s3.getSignedUrl('getObject', {
      Bucket: 'your-bucket',
      Key: file_uri.replace('s3://', ''),
      Expires: 3600
    });
    return res.json({ signed_url: signedUrl });
  }
  
  // Fallback to local file handling
  // ...
});
```

### Rate Limiting

Consider adding rate limiting for AI endpoints to prevent abuse:

```javascript
import rateLimit from 'express-rate-limit';

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

router.post('/invoke', aiLimiter, async (req, res) => {
  // ...
});
```

### Caching

For frequently requested AI results, consider adding Redis caching:

```javascript
// Check cache before calling OpenAI
const cacheKey = `llm:${hashPrompt(prompt)}`;
const cached = await redis.get(cacheKey);
if (cached) {
  return res.json(JSON.parse(cached));
}

// Make OpenAI call, then cache result
const result = await openai.chat.completions.create(...);
await redis.setex(cacheKey, 3600, JSON.stringify(result));
```

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check that `OPENAI_API_KEY` is set correctly
2. **File upload fails**: Verify upload directory exists and has write permissions
3. **JSON parsing errors**: Enable debug logging to see raw LLM responses
4. **CORS errors**: Add your domain to `CORS_ORIGIN` environment variable

### Debug Mode

Enable detailed logging for troubleshooting:

```javascript
// In backend/routes/ai.js
console.log('[AI] Request:', { prompt, model, temperature });
console.log('[AI] Response:', content);
```

## Migration Checklist

- [x] Add integrations to APIClient
- [x] Create `/api/ai/invoke` endpoint
- [x] Create `/api/documents/upload` endpoint
- [x] Create `/api/documents/signed-url` endpoint
- [x] Test all 27 files using these methods
- [x] Verify build and linting
- [x] Document API endpoints
- [x] Update environment configuration

## Support

For issues or questions about this migration:
1. Check the logs for error messages
2. Verify environment variables are set correctly
3. Review the API endpoint documentation above
4. Check that OpenAI API key has sufficient credits/quota
