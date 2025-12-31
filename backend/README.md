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
