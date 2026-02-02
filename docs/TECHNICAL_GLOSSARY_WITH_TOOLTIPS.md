# Technical Glossary - Anya AI Assistant Setup

## For Users Who Prefer Plain Language

This guide explains technical terms used in Anya's documentation in everyday language. When you see highlighted terms in other docs, they refer to these explanations.

---

## **Database** (DB)
**Technical:** A structured system for storing and organizing data with specific relationships between information.

**Plain Language:** Think of it like a digital filing cabinet with organized drawers. Instead of papers, it stores information (like user accounts, profiles, grant data) in organized tables. When you need something, the system can find it quickly and reliably.

**Why it matters for Anya:** Anya needs to remember information about profiles, grants, and user settings. A database ensures this information stays safe and organized.

**Related terms:** PostgreSQL, SQLite

---

## **Crawler** (Web Crawler / Grant Crawler)
**Technical:** An automated program that systematically browses the internet and collects specific information.

**Plain Language:** Imagine a librarian that never sleeps - they automatically visit websites, reads grant information, and brings back relevant details. Our crawler specifically looks for grant opportunities that match what you're searching for.

**Why it matters for Anya:** Anya uses crawlers to find new grant opportunities automatically, saving you time from having to search manually.

**Related terms:** Crawler jobs, crawler queue, dispatcher

---

## **Job Queue** (Background Jobs / Async Queue)
**Technical:** A system for scheduling tasks to run later, in the background, without blocking other operations.

**Plain Language:** Like a to-do list that your computer works through automatically. Instead of doing tasks immediately (which would slow things down), tasks are added to a queue and processed one at a time when the computer has free capacity.

**Why it matters for Anya:** When you ask Anya to search for grants or process information, it doesn't interrupt what you're doing. The request goes into a queue and gets processed in the background.

---

## **JWT (JSON Web Token)**
**Technical:** A secure digital credential that proves you're logged in, contained in a text-based format.

**Plain Language:** Think of it like a digital ID badge. When you log in, the system gives you a special token (a long string of characters) that proves you're you. You show this badge to access features, and the system trusts it without asking you to log in again.

**Why it matters for Anya:** Your JWT token keeps you logged in across page refreshes and server restarts. Anya uses this to remember who you are and what permissions you have.

**Related terms:** AUTH_JWT_SECRET, token, authentication

---

## **Environment Variables**
**Technical:** Configuration settings stored outside the application code, typically in a `.env` file.

**Plain Language:** Settings that tell the application how to behave when it starts. Like a instruction manual you give the application before turning it on - "Here's your database location, here's your API key, here's your security password."

**Why it matters for Anya:** Environment variables tell Anya where to find the database, which API key to use, and other critical setup information. They're kept separate from code for security.

**Examples:** `AUTH_JWT_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`

---

## **API (Application Programming Interface)**
**Technical:** A set of rules and protocols that allows different software programs to communicate with each other.

**Plain Language:** A translator between different applications. Like how you speak English and your friend speaks Spanish, so you need a translator - APIs let different computer programs understand each other and share information.

**Why it matters for Anya:** Anya uses APIs to talk to Claude (Anthropic's AI), to your database, and to other services. APIs are how different software parts work together.

**Example:** When Anya sends you a suggestion, it's using the Anthropic API to communicate with Claude.

---

## **Migration** (Database Migration)
**Technical:** A versioned script that updates the database structure - adding tables, columns, or changing how data is organized.

**Plain Language:** Like renovating your filing cabinet. When you need new drawers (new tables), reorganize existing ones, or change where things are stored, you follow a migration plan to do it carefully without losing anything.

**Why it matters for Anya:** Anya needs specific data structures to work (like a table to track crawler jobs). Migrations set these up automatically.

**Related terms:** Database schema, tables, columns

---

## **Admin / is_admin flag**
**Technical:** A boolean database field (true/false) that indicates whether a user has elevated permissions.

**Plain Language:** A special checkbox in the system that marks you as a "power user." When `is_admin` is true (checked), you get access to special admin-only features. When it's false, you only see regular features.

**Why it matters for Anya:** Some of Anya's features (like managing crawlers) are admin-only for security. The `is_admin` flag is what controls this.

**Related terms:** Permissions, authorization, access control

---

## **Idempotency / Idempotent**
**Technical:** A property where repeating the same operation multiple times produces the same result as doing it 
