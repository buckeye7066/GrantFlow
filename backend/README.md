# GrantFlow Backend

A Node.js/Express backend providing RESTful APIs for grant lifecycle management, document processing, and AI-powered features.

## Overview

The GrantFlow backend serves as the foundation for a complete grant management platform. It provides:

- **RESTful APIs** for grants, organizations, documents, and opportunities
- **AI Integration** via Anya runtime for intelligent automation
- **Document Processing** with parsing, OCR, and data extraction
- **Secure Authentication** with admin token middleware
- **Database Persistence** using SQLite with WAL mode

## Architecture

```
backend/
├── server.js              # Express app and main entry point
├── db/
│   ├── index.js          # Database connection and initialization
│   └── schema.sql        # SQLite database schema
├── routes/
│   ├── profiles.js       # Organization/profile management
│   ├── documents.js      # Document upload and processing
│   └── opportunities.js  # Grant opportunity listings
├── middleware/
│   └── adminAuth.js      # Authentication middleware
├── services/             # Business logic services
├── runtime/
│   └── anyaRuntime.js    # AI runtime controller
├── parser/               # Document parsing utilities
├── storage/              # File storage
│   └── profiles/         # Profile document storage
└── data/
    ├── grantflow.db      # SQLite database
    ├── opportunities.json # Fallback opportunity data
    └── anya-log.json     # AI action logs
```

---

## Database Schema

### Profiles (Organizations)

The `profiles` table stores information about organizations and individuals applying for grants.

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  profile_type TEXT NOT NULL DEFAULT 'organization',
  display_name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  full_name TEXT,
  dob TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT
);
```

**Key Fields:**
- `profile_type`: 'organization' or 'individual'
- `display_name`: Organization name or individual name
- `notes`: Free-form notes about the profile
- Address fields: For location-based grant matching

### Documents

The `documents` table tracks uploaded files and their processing status.

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'unknown',
  extracted_json TEXT,
  suggested_patches_json TEXT,
  applied_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES profiles(id)
);
```

**Document Lifecycle:**
1. `uploaded` - File received and stored
2. `parsed` - Content extracted and analyzed
3. `applied` - Data patches applied to profile

**Key Fields:**
- `status`: Tracks document processing state
- `doc_type`: Classified document type (e.g., tax form, bank statement)
- `extracted_json`: Structured data extracted from document
- `suggested_patches_json`: Proposed updates to profile
- `sha256`: File integrity hash

### Funding Sources (Opportunities)

The `funding_sources` table stores available grant opportunities.

```sql
CREATE TABLE funding_sources (
  id TEXT PRIMARY KEY,
  state TEXT,
  zip_code TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount TEXT,
  deadline TEXT,
  contact_url TEXT,
  source_url TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(state, zip_code, title)
);
```

**Key Fields:**
- `state`, `zip_code`: Geographic targeting
- `title`, `description`: Opportunity details
- `amount`: Grant funding amount
- `deadline`: Application deadline
- Contact information: URLs, phone, email

**Indexes:**
- `idx_funding_sources_state` - Efficient state-based queries
- `idx_funding_sources_updated` - Recent opportunities sorting

---

## API Endpoints

### Health Check

**GET /api/health**

Returns service health status. No authentication required.

```json
{
  "status": "ok",
  "timestamp": "2024-12-31T06:00:00.000Z",
  "service": "grantflow-backend",
  "version": "1.0.0"
}
```

---

### Profiles (Organizations)

All profile endpoints require admin authentication.

#### List Profiles

**GET /api/profiles**

Returns all profiles sorted by most recently updated.

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "profile_type": "organization",
      "display_name": "Axiom BioLabs",
      "notes": "Healthcare research organization",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-15T12:00:00.000Z",
      "full_name": null,
      "address_line1": "123 Main St",
      "city": "Columbus",
      "state": "OH",
      "zip": "43215"
    }
  ]
}
```

#### Create Profile

**POST /api/profiles**

Creates a new organization or individual profile.

**Request Body:**
```json
{
  "display_name": "New Organization",
  "profile_type": "organization",
  "notes": "Optional notes",
  "address_line1": "123 Main St",
  "city": "Columbus",
  "state": "OH",
  "zip": "43215"
}
```

**Response:** `201 Created`
```json
{
  "data": {
    "id": "generated-uuid",
    "display_name": "New Organization",
    ...
  }
}
```

#### Get Profile

**GET /api/profiles/:id**

Retrieves a specific profile by ID.

**Response:** `200 OK` or `404 Not Found`

#### Update Profile

**PATCH /api/profiles/:id**

Updates profile fields. Only provided fields are updated.

**Request Body:**
```json
{
  "display_name": "Updated Name",
  "notes": "New notes"
}
```

**Response:** `200 OK`

---

### Documents

All document endpoints require admin authentication.

#### Upload Document

**POST /api/profiles/:profileId/documents**

Uploads a file and associates it with a profile. Uses multipart/form-data.

**Request:**
- Field name: `file`
- Max file size: 25MB
- Any file type accepted

**Response:** `201 Created`
```json
{
  "data": {
    "id": "document-uuid",
    "profile_id": "profile-uuid",
    "original_filename": "tax-return.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 1024000,
    "status": "uploaded",
    "doc_type": "unknown",
    "sha256": "hash...",
    "created_at": "2024-01-01T00:00:00.000Z"
  }
}
```

#### List Profile Documents

**GET /api/profiles/:profileId/documents**

Returns all documents for a profile, sorted by upload date (newest first).

#### Get Document Details

**GET /api/documents/:documentId**

Retrieves document metadata and processing results.

**Response:** `200 OK` or `404 Not Found`

#### Parse Document

**POST /api/documents/:documentId/parse**

Triggers document parsing to extract structured data.

**Process:**
1. Reads document from storage
2. Extracts text content (OCR for images)
3. Classifies document type
4. Generates suggested data patches
5. Updates document status to 'parsed'

**Response:** `200 OK`
```json
{
  "data": {
    "id": "document-uuid",
    "status": "parsed",
    "doc_type": "bank_statement",
    "extracted_json": {
      "account_number": "****1234",
      "balance": "50000.00"
    },
    "suggested_patches_json": {
      "financial_info": {
        "bank_account": "****1234"
      }
    }
  }
}
```

#### Apply Document Patches

**POST /api/documents/:documentId/apply**

Applies suggested patches from a parsed document to the profile.

**Response:** `200 OK`
```json
{
  "data": {
    "id": "document-uuid",
    "status": "applied",
    "applied_at": "2024-01-01T12:00:00.000Z"
  }
}
```

---

### Opportunities

#### List Opportunities

**GET /api/opportunities**

Returns all available grant opportunities. Requires admin authentication.

**Data Source:**
1. Tries database (`funding_sources` table)
2. Falls back to JSON file (`data/opportunities.json`)

**Response:**
```json
{
  "data": [
    {
      "id": "opp-uuid",
      "title": "Small Business Grant Program",
      "description": "Funding for small businesses...",
      "amount": "$50,000",
      "deadline": "2024-06-30",
      "contact_url": "https://example.com/apply",
      "source_url": "https://example.com",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### Anya AI Runtime

The Anya runtime provides AI-powered automation capabilities.

#### Get Anya Status

**GET /api/anya/status**

Returns current runtime status. No authentication required.

```json
{
  "status": "idle",
  "currentAction": null,
  "lastError": null,
  "lastAction": {
    "id": "action-uuid",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "action": "scan",
    "status": "completed"
  }
}
```

**Status Values:**
- `idle` - Ready for new actions
- `running` - Currently executing an action
- `error` - Last action failed

#### Get Anya Logs

**GET /api/anya/logs**

Returns recent AI action logs. Requires admin authentication.

**Query Parameters:**
- `limit` - Number of entries (default: 50, max: 1000)

**Response:**
```json
{
  "entries": [
    {
      "id": "log-uuid",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "actor": "admin",
      "action": "scan",
      "status": "completed",
      "message": "Scan completed successfully",
      "input": { "target": "repository" },
      "data": { "issuesFound": 3 }
    }
  ]
}
```

#### Trigger Repository Scan

**POST /api/anya/scan**

Initiates a repository scan. Requires admin authentication.

**Request Body:**
```json
{
  "target": "repository",
  "autoFix": false,
  "approve": false
}
```

**Response:** `202 Accepted`

#### Trigger Data Crawl

**POST /api/anya/crawl**

Starts data collection from external sources. Requires admin authentication.

**Request Body:**
```json
{
  "scope": "default-datasets",
  "depth": 1
}
```

**Response:** `202 Accepted`

#### Request Explanation

**POST /api/anya/explain**

Generates AI explanation for a given context. Requires admin authentication.

**Request Body:**
```json
{
  "context": "latest-scan"
}
```

**Response:** `202 Accepted`

---

## Authentication

### Admin Token Authentication

All authenticated endpoints require the `Authorization` header with a Bearer token.

**Header:**
```
Authorization: Bearer YOUR_ANYA_ADMIN_TOKEN
```

**Configuration:**
Set `ANYA_ADMIN_TOKEN` in your `.env` file:
```bash
ANYA_ADMIN_TOKEN=your-secure-random-token-here
```

**Generate Secure Token:**
```bash
openssl rand -hex 32
```

**Unauthenticated Response:** `401 Unauthorized`
```json
{
  "error": "Admin authorization required"
}
```

---

## AI Integration (Anya Runtime)

### Overview

The Anya runtime (`backend/runtime/anyaRuntime.js`) provides a foundation for AI-powered automation. Currently implemented as a simulation layer, it's ready for integration with OpenAI or other AI services.

### Current Actions

1. **scan** - Repository or data scanning
2. **crawl** - External data collection
3. **explain** - Generate explanations
4. **run-query** - Execute data queries
5. **update-setting** - Modify configuration
6. **generate-report** - Create reports
7. **clear-cache** - Clear cached data
8. **rebuild-search-index** - Rebuild search indexes

### AI Service Integration

The backend is configured for OpenAI integration via environment variable:

```bash
OPENAI_API_KEY=sk-proj-your-key-here
```

**Future AI Capabilities:**
- Proposal content generation
- Grant opportunity matching
- Document classification
- Data extraction enhancement
- Smart recommendations

### Action Logging

All Anya actions are logged to `backend/data/anya-log.json` with:
- Timestamp
- Actor (user who triggered)
- Action type
- Input parameters
- Status (started, completed, failed)
- Result data

---

## Document Processing

### Supported Formats

- **PDF**: Text extraction via pdf-parse
- **DOCX**: Text extraction via mammoth
- **Images**: OCR via tesseract.js (PNG, JPG, TIFF)

### Processing Pipeline

1. **Upload** - File received and stored in `backend/storage/profiles/:profileId/:documentId/`
2. **Hash** - SHA256 calculated for integrity
3. **Parse** - Content extraction based on file type
4. **Classify** - Document type detection (tax form, bank statement, etc.)
5. **Extract** - Structured data extraction
6. **Suggest** - Generate profile update patches
7. **Apply** - User confirms and applies patches to profile

### Document Types

Current classifications:
- `tax_return` - Tax documents
- `bank_statement` - Bank statements
- `identification` - ID documents
- `financial_document` - General financial
- `legal_document` - Legal forms
- `unknown` - Unclassified

### Storage Structure

```
backend/storage/profiles/
└── {profileId}/
    └── {documentId}/
        └── {originalFilename}
```

---

## Configuration

### Environment Variables

**Required:**
```bash
ANYA_ADMIN_TOKEN=your-secure-token    # Admin API authentication
PORT=4000                              # Server port
CORS_ORIGIN=http://localhost:5173     # Allowed frontend origin
```

**Optional:**
```bash
OPENAI_API_KEY=sk-proj-...           # OpenAI API for AI features
ANYA_LOG_LIMIT=1000                   # Max log entries (default: 1000)
NODE_ENV=production                   # Environment (development/production)
HOST=0.0.0.0                          # Bind host
```

### CORS Configuration

Multiple origins can be configured with comma separation:
```bash
CORS_ORIGIN=http://localhost:5173,https://grantflow.com
```

---

## Error Handling

### Standard Error Response

```json
{
  "error": "Descriptive error message"
}
```

### Status Codes

- `200` - Success
- `201` - Created
- `202` - Accepted (async operation started)
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid auth)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (e.g., database not ready)

### Database Unavailable

If `better-sqlite3` is not installed, database-dependent endpoints return:

```json
{
  "error": "Database unavailable. Install better-sqlite3 on the server."
}
```

**Status:** `503 Service Unavailable`

---

## Security Features

### Rate Limiting

API routes are rate-limited to 100 requests per 15-minute window per IP address.

**Configuration:**
```javascript
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
```

**Exceeded Response:** `429 Too Many Requests`

### Cookie Security

- Cookies require HTTPS in production
- SameSite and Secure flags enabled
- HTTP-only for session cookies

### Input Validation

- All user inputs sanitized
- SQL injection prevention via parameterized queries
- File upload size limits (25MB)
- MIME type validation

---

## Performance

### Database Optimization

- **WAL Mode**: Write-Ahead Logging for concurrent access
- **Indexes**: Strategic indexes on frequently queried columns
- **Connection Pooling**: Single connection with transaction support

### Caching Strategy

- Static files served with cache headers
- JSON opportunity data cached in memory
- Future: Redis integration for distributed caching

---

## Deployment

### Railway Deployment

The backend is production-deployed on Railway with:
- Automatic deployments from GitHub
- Environment variables configured via Railway dashboard
- Health check monitoring at `/api/health`
- Systemd service for process management

### Systemd Service

```ini
[Unit]
Description=GrantFlow Backend
After=network.target

[Service]
Type=simple
User=grantflow
WorkingDirectory=/home/grantflow/app
ExecStart=/usr/bin/node backend/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Commands:**
```bash
sudo systemctl start grantflow-backend
sudo systemctl enable grantflow-backend
sudo systemctl status grantflow-backend
```

### Nginx Configuration

```nginx
location /grantflow/api/ {
    proxy_pass http://localhost:4000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

---

## Development

### Setup

```bash
cd backend
npm install
```

### Running Locally

```bash
# Start backend server
npm start

# Or use nodemon for development
npm install -g nodemon
nodemon backend/server.js
```

### Running Tests

```bash
npm test
```

---

## Future Backend Enhancements

Based on the [Feature Parity Analysis](../docs/FEATURE_PARITY.md) and [Development Roadmap](../docs/DEVELOPMENT_ROADMAP.md), planned backend additions include:

### Database Schema Extensions
- `grants` - Grant pipeline tracking
- `proposals` - Proposal content and versioning
- `submissions` - Submission tracking
- `milestones` - Grant milestones
- `expenses` - Budget tracking
- `users` - User accounts
- `roles` - RBAC permissions

### New API Endpoints
- Grant CRUD and pipeline management
- Proposal creation and AI generation
- Submission tracking and checklists
- Analytics and reporting
- User authentication and authorization

### Enhanced AI Integration
- OpenAI proposal generation
- Document classification improvement
- Smart grant matching
- Predictive analytics

### Infrastructure
- PostgreSQL migration for scale
- Redis for caching and sessions
- Background job processing
- Email notification service

---

## Troubleshooting

### Database Connection Issues

**Error:** `better-sqlite3` not installed

**Solution:**
```bash
cd backend
npm install better-sqlite3
npm start
```

### Authentication Failures

**Error:** `Admin authorization required`

**Check:**
1. `ANYA_ADMIN_TOKEN` is set in `.env`
2. Token matches in Authorization header
3. Header format: `Authorization: Bearer YOUR_TOKEN`

### File Upload Failures

**Common Issues:**
- File size exceeds 25MB limit
- Insufficient disk space
- Permission issues on `storage/` directory

**Solution:**
```bash
# Check available space
df -h

# Fix permissions
chmod -R 755 backend/storage
```

### Port Already in Use

**Error:** `EADDRINUSE: address already in use`

**Solution:**
```bash
# Find process using port 4000
lsof -i :4000

# Kill process
kill -9 <PID>
```

---

## API Testing

### Using cURL

```bash
# Health check
curl http://localhost:4000/api/health

# List profiles (requires auth)
curl -H "Authorization: Bearer YOUR_TOKEN" \
     http://localhost:4000/api/profiles

# Create profile
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"display_name":"Test Org","profile_type":"organization"}' \
     http://localhost:4000/api/profiles

# Upload document
curl -X POST \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -F "file=@/path/to/document.pdf" \
     http://localhost:4000/api/profiles/PROFILE_ID/documents
```

### Using JavaScript (fetch)

```javascript
const API_URL = 'http://localhost:4000/api';
const TOKEN = 'your-token';

// List profiles
fetch(`${API_URL}/profiles`, {
  headers: {
    'Authorization': `Bearer ${TOKEN}`
  }
})
  .then(res => res.json())
  .then(data => console.log(data));

// Create profile
fetch(`${API_URL}/profiles`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    display_name: 'New Organization',
    profile_type: 'organization'
  })
})
  .then(res => res.json())
  .then(data => console.log(data));
```

---

## Contributing

When adding new backend features:

1. **Database Changes**: Update `backend/db/schema.sql` and create migrations
2. **New Routes**: Add router in `backend/routes/` and register in `server.js`
3. **Authentication**: Use `adminAuth` middleware for protected endpoints
4. **Error Handling**: Use consistent error responses and status codes
5. **Documentation**: Update this README with new endpoints
6. **Testing**: Add unit and integration tests
7. **Logging**: Use Anya runtime for action logging where appropriate

---

## Resources

- [Main README](../README.md)
- [Feature Parity Analysis](../docs/FEATURE_PARITY.md)
- [Development Roadmap](../docs/DEVELOPMENT_ROADMAP.md)
- [UI Architecture](../docs/UI_ARCHITECTURE.md)
- [Deployment Guide](../docs/DEPLOYMENT.md)

---

## License

Copyright © 2024 Axiom BioLabs. All rights reserved.
