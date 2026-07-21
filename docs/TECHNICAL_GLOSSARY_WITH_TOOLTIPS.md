# Technical Glossary - Anya AI Assistant Setup

## For Users Who Prefer Plain Language

This guide explains technical terms used in Anya's documentation in everyday language. When you see highlighted terms in other docs, they refer to these explanations.

---

## Quick Reference Table

| Term | One-line meaning |
|---|---|
| Database (DB) | Digital filing cabinet where all information is stored |
| PostgreSQL | The production-grade database GrantFlow uses when deployed |
| SQLite | A lightweight single-file database used for local testing |
| Crawler | An automated program that finds grant opportunities online |
| Job Queue | A to-do list the computer works through in the background |
| JWT | Your digital ID badge that proves you're logged in |
| Environment Variables | Settings the app reads before it starts (the `.env` file) |
| API | How two programs talk to each other |
| API Key | A secret password that lets the app use a service |
| Migration | A careful, versioned plan for changing the database's structure |
| Admin / is_admin | The checkbox that marks a power user |
| Idempotency | Safe to repeat - running it twice changes nothing extra |
| Frontend | The part of the app you see and click in your browser |
| Backend | The part of the app running on a server behind the scenes |
| Server | A computer that answers requests from other computers |
| Localhost | Your own computer, when it acts as the server |
| Port | The numbered "door" a program listens on (e.g., 3001) |
| Endpoint / Route | One specific address the backend answers (e.g., `/api/grants`) |
| Deployment | Publishing the app so others can use it on the internet |
| Vercel | The service that hosts GrantFlow's frontend |
| Railway | The service that hosts GrantFlow's backend and database |
| Git / Repository | The system that tracks every change to the code |
| Node.js | The engine that runs GrantFlow's JavaScript outside a browser |
| npm | The tool that installs the code libraries the app needs |
| Build | Converting source code into the optimized files users receive |
| Authentication | Proving who you are (logging in) |
| Authorization | What you're allowed to do once logged in |
| Token | A string of characters that stands in for your login |
| Session | The period you stay logged in without re-entering a password |
| CORS | A browser safety rule about which websites may call the backend |
| HTTPS / SSL | The padlock - encrypted traffic between you and the server |
| Schema | The blueprint of the database's tables and columns |
| Seed Data | Starter example data loaded into a fresh database |
| Logs | The app's diary - a running record of what it did |
| Cache | A short-term memory that saves answers to avoid re-work |
| Webhook | A "call me when it happens" message from another service |
| LLM / AI Model | The AI brain (like Claude) that powers Anya's writing |
| Rate Limit | A cap on how many requests you may send per minute |
| CLI / Terminal | The text window where you type commands |

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
**Technical:** A property where repeating the same operation multiple times produces the same result as doing it once.

**Plain Language:** Safe to repeat. Like pressing an elevator button - pressing it five times doesn't call five elevators. An idempotent setup step can be run again without breaking anything or creating duplicates.

**Why it matters for Anya:** Setup scripts and migrations are written to be idempotent, so if something is interrupted you can simply run it again. No harm done.

**Related terms:** Migration, retry

---

## **PostgreSQL** (Postgres)
**Technical:** A powerful open-source relational database management system used in production deployments.

**Plain Language:** The industrial-strength version of the filing cabinet. It can handle many people using it at once and lives on a server rather than on your computer.

**Why it matters for Anya:** When GrantFlow is deployed for real users (on Railway), all data lives in PostgreSQL.

**Related terms:** Database, Railway, DATABASE_URL

---

## **SQLite**
**Technical:** A lightweight, serverless database engine that stores the entire database in a single file.

**Plain Language:** A filing cabinet that fits in one folder on your own computer. Perfect for trying things out locally because it needs no setup at all.

**Why it matters for Anya:** Local development and automated tests use SQLite so you can run everything on your laptop without installing a database server.

**Related terms:** Database, PostgreSQL

---

## **Frontend**
**Technical:** The client-side portion of an application that runs in the user's web browser.

**Plain Language:** Everything you can see and click - the pages, buttons, and forms. It's the storefront of the app.

**Why it matters for Anya:** Anya's chat window, the grant pipeline, and your profile pages are all frontend. GrantFlow's frontend is hosted on Vercel.

**Related terms:** Backend, Vercel, React

---

## **Backend**
**Technical:** The server-side portion of an application that handles business logic, data storage, and processing.

**Plain Language:** The kitchen behind the restaurant counter. You never see it directly, but it's where the real work happens - checking your login, saving data, running crawlers.

**Why it matters for Anya:** Anya's brain lives in the backend. When you send her a message, the backend processes it, talks to the AI, and sends the answer back. GrantFlow's backend is hosted on Railway.

**Related terms:** Frontend, Server, Railway

---

## **Server**
**Technical:** A computer or program that provides services or resources to other computers (clients) over a network.

**Plain Language:** A computer whose whole job is answering requests. Your browser asks, the server answers - all day, every day.

**Why it matters for Anya:** The GrantFlow backend runs as a server. If the server is down, Anya can't respond.

**Related terms:** Backend, Localhost, Port

---

## **Localhost**
**Technical:** The standard hostname (`127.0.0.1` / `::1`) referring to the local machine itself.

**Plain Language:** "This computer, right here." When docs say to open `http://localhost:5173`, they mean the copy of the app running on your own machine - nobody else can see it.

**Why it matters for Anya:** During setup you run GrantFlow locally, so you visit localhost addresses to check that everything works before deploying.

**Related terms:** Port, Server

---

## **Port**
**Technical:** A numbered communication endpoint that lets one computer run many network services at once.

**Plain Language:** Doors on a building. The building (your computer) has one address, but each program listens at its own numbered door - the frontend at one, the backend at another.

**Why it matters for Anya:** GrantFlow's frontend and backend listen on different ports locally. If a port is already in use by another program, the app can't start there.

**Related terms:** Localhost, Server

---

## **Endpoint / Route**
**Technical:** A specific URL path on the backend that handles a particular kind of request (e.g., `GET /api/grants`).

**Plain Language:** One specific service window at the post office. One window handles stamps, another handles packages - one route handles grants, another handles profiles.

**Why it matters for Anya:** Every feature you use maps to a route. Error messages often name the route that failed, which helps pinpoint problems.

**Related terms:** API, Backend

---

## **Deployment** (Deploy)
**Technical:** The process of releasing an application to servers where end users can access it.

**Plain Language:** Opening night. Everything you built locally gets published to the internet so real users can visit it.

**Why it matters for Anya:** GrantFlow deploys the frontend to Vercel and the backend to Railway. "Deployed" means live and usable by others.

**Related terms:** Vercel, Railway, Build

---

## **Vercel**
**Technical:** A cloud platform for hosting frontend applications with automatic builds from a Git repository.

**Plain Language:** The company that hosts GrantFlow's storefront. When new frontend code is pushed, Vercel automatically rebuilds and publishes it.

**Why it matters for Anya:** The pages you see in production are served by Vercel.

**Related terms:** Frontend, Deployment, Railway

---

## **Railway**
**Technical:** A cloud platform for hosting backend services and databases.

**Plain Language:** The company that hosts GrantFlow's kitchen - the backend server and the PostgreSQL database both live there.

**Why it matters for Anya:** Anya's processing and all stored data run on Railway in production.

**Related terms:** Backend, PostgreSQL, Deployment

---

## **Git / Repository** (Repo)
**Technical:** A version control system (Git) and the project folder it tracks (repository), recording every change with history.

**Plain Language:** A time machine for the project's files. Every change is saved with who made it and why, and you can always look back or undo.

**Why it matters for Anya:** All of GrantFlow's code lives in a Git repository on GitHub. Deployments happen automatically when changes land on the main branch.

**Related terms:** Deployment, Build

---

## **Node.js**
**Technical:** A JavaScript runtime that executes JavaScript code outside of a web browser.

**Plain Language:** The engine that lets the backend run JavaScript on a server. Browsers run JavaScript for web pages; Node.js runs it everywhere else.

**Why it matters for Anya:** GrantFlow's backend is written in JavaScript and needs Node.js installed to run.

**Related terms:** npm, Backend

---

## **npm** (Node Package Manager)
**Technical:** The default package manager for Node.js, used to install and manage code dependencies.

**Plain Language:** An app store for code. Instead of writing everything from scratch, developers install ready-made building blocks. `npm install` fetches all the blocks the project needs.

**Why it matters for Anya:** The first setup step is always `npm install` - without it, the app has none of its parts.

**Related terms:** Node.js, Build

---

## **Build**
**Technical:** The process of compiling and bundling source code into optimized files ready to serve to users.

**Plain Language:** Baking the cake. Source code is the recipe and raw ingredients; the build is the finished cake users are actually served.

**Why it matters for Anya:** `npm run build` produces the production version of the frontend. A failed build means nothing new can be deployed.

**Related terms:** Deployment, npm

---

## **Authentication**
**Technical:** The process of verifying a user's identity, typically via credentials like email and password.

**Plain Language:** Proving you are who you say you are - showing your ID at the door. That's what logging in is.

**Why it matters for Anya:** Anya only shares your data with you. Authentication is how the system knows it's really you asking.

**Related terms:** Authorization, JWT, Token, Session

---

## **Authorization**
**Technical:** The process of determining what an authenticated user is permitted to do.

**Plain Language:** What your ticket lets you into. Everyone gets through the front door (authentication), but only some tickets open the backstage door.

**Why it matters for Anya:** Admin tools, billing controls, and crawler management are authorization-gated - logged in isn't enough, you also need the right role.

**Related terms:** Authentication, Admin, Permissions

---

## **Token**
**Technical:** A string of characters issued by the server that represents a user's identity or permission.

**Plain Language:** A claim ticket. Instead of showing your passport at every counter, you show the ticket they gave you at the entrance.

**Why it matters for Anya:** After login, your browser holds a token and sends it with every request so you don't have to log in over and over.

**Related terms:** JWT, Session, Authentication

---

## **Session**
**Technical:** The period during which a user remains authenticated with a service, and the server-side record of it.

**Plain Language:** Your visit. From login to logout (or expiry), the system remembers you're here. When the session expires, you sign in again.

**Why it matters for Anya:** Sessions are why you can close the tab and come back without re-entering your password - and why, after long enough away, you're asked to log in again.

**Related terms:** Token, JWT, Authentication

---

## **CORS (Cross-Origin Resource Sharing)**
**Technical:** A browser security mechanism that controls which websites are allowed to make requests to a given backend.

**Plain Language:** A guest list. The backend tells browsers "only requests from these websites are welcome." A site not on the list gets blocked by the browser itself.

**Why it matters for Anya:** The backend's `CORS_ORIGIN` setting must name the frontend's address. If it's wrong, the app loads but every request mysteriously fails.

**Related terms:** Environment Variables, Backend, Frontend

---

## **HTTPS / SSL**
**Technical:** The encrypted version of the web's transfer protocol, secured with SSL/TLS certificates.

**Plain Language:** The padlock in your address bar. Everything sent between you and the server is scrambled so eavesdroppers see gibberish.

**Why it matters for Anya:** Your grant data, profile details, and passwords always travel encrypted. Production GrantFlow is HTTPS-only.

**Related terms:** Server, Deployment

---

## **Schema** (Database Schema)
**Technical:** The formal definition of a database's structure: its tables, columns, types, and relationships.

**Plain Language:** The blueprint of the filing cabinet - which drawers exist, what each is labeled, and what kind of thing goes in each.

**Why it matters for Anya:** Migrations exist to change the schema safely. When docs mention "a schema change," they mean the shape of stored data changed, not the data itself.

**Related terms:** Migration, Database

---

## **Seed Data** (Seeding)
**Technical:** Initial example or reference data loaded into a fresh database.

**Plain Language:** Furnishing a new house. A brand-new database is empty; seeding puts in starter data so the app has something to show.

**Why it matters for Anya:** `npm run db:setup` migrates and seeds your local database in one step, giving you a working playground immediately.

**Related terms:** Database, Migration

---

## **Logs** (Logging)
**Technical:** Timestamped records of application events, errors, and activity written by the running program.

**Plain Language:** The app's diary. Every notable thing it does - and every error it hits - gets written down with a time.

**Why it matters for Anya:** When something misbehaves, the logs say what actually happened. Support and debugging almost always start with "check the logs."

**Related terms:** Server, Railway

---

## **Cache** (Caching)
**Technical:** A temporary store of previously computed or fetched results, used to serve repeat requests faster.

**Plain Language:** Short-term memory. If you just looked up an answer, keep it on a sticky note instead of walking to the library again.

**Why it matters for Anya:** Caching makes repeated searches fast and cuts costs - but it's also why a just-made change sometimes takes a moment to appear.

**Related terms:** Database, API

---

## **Webhook**
**Technical:** An HTTP callback - one service automatically sends a request to another when an event occurs.

**Plain Language:** "Don't call us, we'll call you." Instead of GrantFlow constantly asking Stripe "any news?", Stripe sends a message the instant something happens.

**Why it matters for Anya:** Billing events (payments, subscription changes) arrive as Stripe webhooks so the app reacts immediately.

**Related terms:** API, Endpoint

---

## **LLM / AI Model** (Large Language Model)
**Technical:** A machine-learning model trained on large text corpora to understand and generate natural language.

**Plain Language:** The AI brain. It has read an enormous amount of text and can write, summarize, and answer questions in plain language.

**Why it matters for Anya:** Anya's intelligence comes from LLMs - Claude (by Anthropic) and OpenAI models - accessed over their APIs.

**Related terms:** API, API Key, Anthropic

---

## **API Key**
**Technical:** A secret credential string that identifies and authorizes an application when calling an external service.

**Plain Language:** A membership card for another company's service. Show the card, get service - and because usage is billed to the card, it must be kept secret.

**Why it matters for Anya:** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are what let Anya talk to the AI services. Missing or invalid keys are the most common reason Anya "won't respond."

**Related terms:** Environment Variables, API, LLM

---

## **Rate Limit** (Rate Limiting)
**Technical:** A cap on how many requests a client may make to a service within a time window.

**Plain Language:** "One per customer, please." Services protect themselves by limiting how fast anyone can ask. Ask too fast, and you're told to slow down for a bit.

**Why it matters for Anya:** AI providers rate-limit their APIs. If a heavy crawl or busy hour hits a limit, requests briefly fail or queue - it resolves itself shortly.

**Related terms:** API, Job Queue

---

## **CLI / Terminal** (Command Line Interface)
**Technical:** A text-based interface for interacting with a computer by typing commands.

**Plain Language:** The typing window. Instead of clicking buttons, you type instructions like `npm install` and press Enter. Old-fashioned looking, but precise and scriptable.

**Why it matters for Anya:** All setup commands (`npm install`, `npm run dev:full`, `npm run migrate`) are typed into a terminal. If a doc shows a code line starting with `npm`, that's where it goes.

**Related terms:** npm, Node.js

---

*If you hit a term that isn't here, it belongs here - please add it or ask for it to be added.*
