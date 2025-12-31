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
# GrantFlow Backend API

This document provides comprehensive documentation for the GrantFlow backend API, including available endpoints, authentication, database schema, and development guidelines.

## Table of Contents

1. [Overview](#overview)
2. [Technology Stack](#technology-stack)
3. [Getting Started](#getting-started)
4. [Authentication](#authentication)
5. [API Endpoints](#api-endpoints)
6. [Database Schema](#database-schema)
7. [Document Processing](#document-processing)
8. [ANYA AI Assistant](#anya-ai-assistant)
9. [Crawlers & Data Import](#crawlers--data-import)
10. [Error Handling](#error-handling)
11. [Development Guidelines](#development-guidelines)

---

## Overview

The GrantFlow backend is a RESTful API built with Express.js and SQLite, providing grant discovery, application tracking, document processing, and AI-powered assistance capabilities.

**Base URL:**
- Development: `http://localhost:8080`
- Production: `https://www.axiombiolabs.org/api`

**API Version:** v1 (implicit, no version prefix currently)

---

## Technology Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js 4.19.2
- **Database:** SQLite 3 (via better-sqlite3 11.8.1)
- **Document Processing:**
  - PDF: pdf-parse 1.1.1
  - DOCX: mammoth 1.8.0
  - OCR: tesseract.js 7.0.0
- **AI Integration:** OpenAI API (via custom integration)
- **Authentication:** Token-based (ANYA_ADMIN_TOKEN)
- **File Uploads:** multer 2.0.2
- **Security:** cors, express-rate-limit

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- SQLite3

### Installation

```bash
cd backend
npm install
```

### Environment Variables

Create a `.env` file in the backend directory:

```env
# Server Configuration
PORT=8080
NODE_ENV=development

# Security
ANYA_ADMIN_TOKEN=your-secure-token-here

# CORS
CORS_ORIGIN=http://localhost:5173,http://localhost:3000

# Database
DATABASE_URL=./backend/data/grantflow.db

# AI Integration
OPENAI_API_KEY=your-openai-api-key
```

### Starting the Server

```bash
# Development
npm run start

# Or from root directory
npm run backend

# Full stack (frontend + backend)
npm run dev:full
```

The server will start on `http://localhost:8080` (or the PORT specified in .env).

---

## Authentication

### ANYA Admin Token

Protected endpoints require the `X-Admin-Token` header with the value of `ANYA_ADMIN_TOKEN` environment variable.

**Example:**
```bash
curl -H "X-Admin-Token: your-token-here" \
     http://localhost:8080/api/anya/status
```

**Protected Endpoints:**
- `POST /api/anya/chat`
- `GET /api/anya/status`
- `POST /api/ai/analyze-document`
- All document processing endpoints

### Future Authentication

User-based authentication (JWT) is planned for Phase 1 of the development roadmap. Current implementation uses a single admin token for API access.

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
#### `GET /health`

Check if the API server is running.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

### Organizations

#### `GET /api/organizations`

Get list of organizations.

**Query Parameters:**
- `search` (optional): Search term for organization name

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
  "organizations": [
    {
      "id": 1,
      "name": "Axiom BioLabs",
      "type": "research",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `GET /api/organizations/:id`

Get a specific organization by ID.

#### `POST /api/organizations`

Create a new organization.

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
  "name": "Organization Name",
  "type": "nonprofit",
  "description": "Organization description",
  "contact_email": "contact@example.com",
  "contact_phone": "555-1234",
  "website": "https://example.com"
}
```

---

### Grants

#### `GET /api/grants`

Get list of grants with optional filtering.

**Query Parameters:**
- `search` (optional): Full-text search across title and description
- `status` (optional): Filter by status (`active`, `closed`, `upcoming`)
- `category` (optional): Filter by category
- `organization_id` (optional): Filter by organization
- `limit` (optional, default: 50): Number of results
- `offset` (optional, default: 0): Pagination offset

**Response:**
```json
{
  "grants": [
    {
      "id": 1,
      "organization_id": 1,
      "title": "Research Innovation Grant",
      "description": "Funding for innovative research projects",
      "category": "research",
      "amount_min": 50000,
      "amount_max": 250000,
      "deadline": "2024-12-31",
      "status": "active",
      "eligibility_requirements": "Must be 501(c)(3) organization",
      "application_url": "https://example.com/apply",
      "created_at": "2024-01-01T00:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

#### `GET /api/grants/:id`

Get detailed information about a specific grant.

#### `POST /api/grants`

Create a new grant (admin only).

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
  "organization_id": 1,
  "title": "Grant Title",
  "description": "Detailed description",
  "category": "education",
  "amount_min": 10000,
  "amount_max": 50000,
  "deadline": "2024-12-31",
  "eligibility_requirements": "Requirements text",
  "application_url": "https://example.com/apply"
}
```

---

### Opportunities

The opportunities endpoint provides access to grant opportunities (similar to grants but from external sources).

#### `GET /api/opportunities`

Get list of grant opportunities.

**Response:**
```json
{
  "opportunities": [
    {
      "id": 1,
      "title": "Small Business Grant",
      "description": "Grant for small businesses",
      "source": "grants.gov",
      "amount": 25000,
      "deadline": "2024-06-30",
      "category": "business",
      "location": "California"
    }
  ]
}
```

#### `GET /api/opportunities/:id`

Get specific opportunity details.

---

### Milestones

Track grant application milestones and deadlines.

#### `GET /api/milestones`

Get list of milestones.

**Query Parameters:**
- `grant_id` (optional): Filter by grant
- `status` (optional): Filter by status (`pending`, `completed`, `overdue`)

#### `POST /api/milestones`

Create a new milestone.

**Request Body:**
```json
{
  "grant_id": 1,
  "title": "Submit preliminary proposal",
  "description": "Complete and submit initial proposal",
  "due_date": "2024-03-15",
  "status": "pending"
}
```

#### `PUT /api/milestones/:id`

Update milestone status.

---

### Documents

Document upload, processing, and management.

#### `POST /api/documents/upload`

Upload and process a document.

**Request:**
- Method: `POST`
- Content-Type: `multipart/form-data`
- Headers: `X-Admin-Token: <token>`
- Body: File in `document` field

**Supported Formats:**
- PDF (`.pdf`)
- Microsoft Word (`.docx`)
- Images (`.jpg`, `.jpeg`, `.png`) - OCR processing

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
  "success": true,
  "document": {
    "id": "abc123",
    "filename": "tax_return.pdf",
    "type": "tax_return",
    "extracted_data": {
      "income": 50000,
      "filing_status": "single",
      "tax_year": 2023
    },
    "text": "Full extracted text...",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

#### `GET /api/documents`

List uploaded documents.

#### `GET /api/documents/:id`

Get specific document details and extracted data.

#### `DELETE /api/documents/:id`

Delete a document.

---

### Expenses

Track expenses related to grants.

#### `GET /api/expenses`

Get list of expenses.

**Query Parameters:**
- `grant_id` (optional): Filter by grant
- `category` (optional): Filter by expense category

#### `POST /api/expenses`

Record a new expense.

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
  "grant_id": 1,
  "category": "equipment",
  "amount": 1500.00,
  "description": "Laboratory equipment",
  "date": "2024-01-15",
  "receipt_url": "https://example.com/receipt.pdf"
}
```

---

### AI Integration

#### `POST /api/ai/analyze-document`

Analyze document content using AI.

**Headers:**
- `X-Admin-Token: <token>`

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
  "text": "Document text to analyze",
  "analysis_type": "extract_entities"
}
```

**Response:**
```json
{
  "entities": {
    "names": ["John Doe"],
    "dates": ["2024-01-15"],
    "amounts": [50000]
  },
  "summary": "AI-generated summary"
}
```

---

### ANYA AI Assistant

ANYA is the AI-powered grant assistance chatbot.

#### `POST /api/anya/chat`

Send a message to ANYA and get a response.

**Headers:**
- `X-Admin-Token: <token>`

**Request Body:**
```json
{
  "message": "What grants am I eligible for?",
  "context": {
    "user_profile": {
      "income": 50000,
      "location": "California",
      "occupation": "teacher"
    }
  }
}
```

**Response:**
```json
{
  "response": "Based on your profile as a teacher in California with an income of $50,000, you may be eligible for several education-related grants...",
  "suggestions": [
    "Tell me more about education grants",
    "What documents do I need?"
  ],
  "conversation_id": "conv_abc123"
}
```

#### `GET /api/anya/status`

Get ANYA service status and statistics.

**Headers:**
- `X-Admin-Token: <token>`

**Response:**
```json
{
  "status": "operational",
  "total_conversations": 150,
  "total_messages": 1200,
  "uptime": "99.9%"
}
```

---

## Database Schema

### Tables

#### Organizations
```sql
CREATE TABLE Organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT,
  description TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  website TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Grants
```sql
CREATE TABLE Grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  amount_min INTEGER,
  amount_max INTEGER,
  deadline DATE,
  status TEXT DEFAULT 'active',
  eligibility_requirements TEXT,
  application_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES Organizations(id)
);
```

#### Opportunities
```sql
CREATE TABLE Opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT,
  external_id TEXT,
  amount INTEGER,
  deadline DATE,
  category TEXT,
  location TEXT,
  eligibility TEXT,
  url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Milestones
```sql
CREATE TABLE Milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT DEFAULT 'pending',
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (grant_id) REFERENCES Grants(id)
);
```

#### Expenses
```sql
CREATE TABLE Expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER,
  category TEXT,
  amount REAL NOT NULL,
  description TEXT,
  date DATE,
  receipt_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (grant_id) REFERENCES Grants(id)
);
```

#### Documents
```sql
CREATE TABLE Documents (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  filename TEXT NOT NULL,
  file_path TEXT,
  file_type TEXT,
  document_type TEXT,
  extracted_text TEXT,
  extracted_data TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Full schema:** See `/backend/db/schema.sql`

---

## Document Processing

### Overview

The document processing pipeline automatically extracts text and structured data from uploaded documents.

### Processing Pipeline

1. **File Upload** → Receives file via multipart/form-data
2. **Format Detection** → Identifies file type (PDF, DOCX, Image)
3. **Text Extraction** → Extracts raw text using appropriate parser
4. **Document Classification** → Identifies document type (tax return, driver's license, etc.)
5. **Field Extraction** → Extracts structured data based on document type
6. **Storage** → Saves file and extracted data to database

### Supported Document Types

#### Tax Returns
**Extracted Fields:**
- Income
- Filing status
- Tax year
- Deductions
- Credits

#### Driver's License
**Extracted Fields:**
- Name
- Date of birth
- License number
- Address
- Expiration date

#### Scholarship Letters
**Extracted Fields:**
- Student name
- Award amount
- Institution name
- Award date

### Parser Modules

**Location:** `/backend/parser/`

- `text/pdf.js` - PDF text extraction
- `text/docx.js` - Word document extraction
- `text/ocr.js` - OCR for scanned documents and images
- `classify.js` - Document type classification
- `extract/common.js` - Common extraction utilities
- `extract/driversLicense.js` - Driver's license field extraction
- `extract/scholarshipLetter.js` - Scholarship letter extraction

### Example Usage

```javascript
import { parseDocument } from './parser/index.js';

const result = await parseDocument(filePath, mimeType);

console.log(result);
// {
//   text: "Full extracted text...",
//   documentType: "tax_return",
//   extractedData: {
//     income: 50000,
//     filingStatus: "single",
//     taxYear: 2023
//   }
// }
```

---

## ANYA AI Assistant

### Overview

ANYA (AI Network for Your Application) is an intelligent assistant that helps users find grants, understand requirements, and complete applications.

### Capabilities

- **Grant Discovery:** Recommend grants based on user profile
- **Eligibility Checking:** Determine if user qualifies for specific grants
- **Application Assistance:** Help answer application questions
- **Document Guidance:** Explain required documents
- **General Q&A:** Answer questions about the grant process

### Implementation

**Location:** `/backend/anya/`

The ANYA system uses:
- OpenAI GPT models for natural language understanding
- Context management for conversation history
- Audit logging for compliance

### Conversation Flow

1. User sends message via `/api/anya/chat`
2. System retrieves conversation context
3. Constructs prompt with user profile and grant data
4. Sends to OpenAI API
5. Processes and formats response
6. Logs interaction for audit
7. Returns response with suggestions

### Audit Trail

All ANYA interactions are logged to `/backend/data/anya-log.json` including:
- Timestamp
- User message
- ANYA response
- Context provided
- Model used

---

## Crawlers & Data Import

### Overview

Crawlers automatically collect grant data from external sources.

**Location:** `/backend/crawlers/`

### Available Crawlers

#### Local Funding Crawler
**File:** `localFundingCrawler.js`

Scrapes local government and foundation websites for grant opportunities.

**Features:**
- Configurable source URLs
- Rate limiting
- Data normalization
- Deduplication

### Running Crawlers

```bash
# Import data manually
node backend/import-data.js
```

### Adding New Sources

1. Create crawler in `/backend/crawlers/`
2. Implement source-specific parsing logic
3. Map to standard Opportunities schema
4. Add to import pipeline

---

## Error Handling

### Standard Error Response

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": {
    "field": "Additional error details"
  }
}
```

### HTTP Status Codes

- `200 OK` - Successful request
- `201 Created` - Resource created successfully
- `400 Bad Request` - Invalid request data
- `401 Unauthorized` - Missing or invalid authentication
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `500 Internal Server Error` - Server error

### Common Error Codes

- `INVALID_TOKEN` - Authentication token invalid
- `MISSING_REQUIRED_FIELD` - Required field not provided
- `RESOURCE_NOT_FOUND` - Requested resource doesn't exist
- `DUPLICATE_ENTRY` - Resource already exists
- `PROCESSING_ERROR` - Document processing failed

---

## Development Guidelines

### Code Style

- **Format:** ES6+ modules (import/export)
- **Indentation:** 2 spaces
- **Quotes:** Single quotes for strings
- **Semicolons:** Required
- **Naming:** camelCase for variables/functions, PascalCase for classes

### Adding New Endpoints

1. Create route file in `/backend/routes/`
2. Define route handlers
3. Add database queries
4. Implement error handling
5. Register router in `server.js`
6. Update this documentation

### Database Migrations

1. Update `/backend/db/schema.sql`
2. Test migration on clean database
3. Document changes in this file
4. Consider backward compatibility

### Testing

Currently, testing is manual. Planned additions:
- Jest for unit tests
- Supertest for API integration tests
- Test coverage reporting

### Logging

Use console methods for logging:
- `console.log()` - General information
- `console.warn()` - Warnings
- `console.error()` - Errors

Future: Implement structured logging with Winston or Pino.

---

## API Roadmap

### Phase 1: User System (Planned)
- User registration and authentication
- JWT token management
- User profiles and preferences
- Password reset flow

### Phase 2: Advanced Features (Planned)
- Bookmark/favorite grants
- Application tracking
- Email notifications
- Advanced search filters
- Grant recommendations

### Phase 3: Integrations (Planned)
- Grants.gov API integration
- Foundation database connections
- Email service integration
- Payment processing (Stripe)

See `docs/DEVELOPMENT_ROADMAP.md` for complete timeline.

---

## Support & Contributing

### Reporting Issues

Open an issue on GitHub: https://github.com/buckeye7066/GrantFlow/issues

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests (when available)
5. Submit a pull request

### Contact

- **Project Lead:** [Name]
- **Email:** [Email]
- **GitHub:** https://github.com/buckeye7066/GrantFlow

---

## License

[License information here]

---

## Changelog

### v0.1.0 (Current)
- Initial backend implementation
- Basic CRUD for grants, organizations, milestones
- Document processing pipeline
- ANYA AI assistant integration
- SQLite database with core schema
- Express REST API
- CORS and authentication middleware
