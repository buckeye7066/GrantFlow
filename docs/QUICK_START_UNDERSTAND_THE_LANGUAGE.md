# Understanding Anya Setup - A Guide for Non-Technical Users

## Welcome!

If you're reading this, you might be feeling overwhelmed by technical jargon like "database," "crawler," or "JWT." **That's completely normal!** This guide helps you understand what those terms mean in everyday language.

---

## Your Three-Step Glossary Journey

### Step 1: Start Here - The Quick Reference

**Can't remember what "database" means?**

👉 **[Open the Technical Glossary](TECHNICAL_GLOSSARY_WITH_TOOLTIPS.md)** - It has 35+ terms explained in simple language.

Each term includes:
- **What it actually is** (technical definition)
- **What it means to you** (everyday language)
- **Why it matters for Anya** (how it affects your work)

### Step 2: Follow Along with Setup

**Ready to actually set up Anya?**

👉 **[Go to the Setup Guide](ANYA_SETUP_GUIDE.md)** - Step-by-step instructions for installing Anya

**How to use it:**
1. Read a step that uses a term you don't know
2. Open a new tab and go to the [Glossary](TECHNICAL_GLOSSARY_WITH_TOOLTIPS.md)
3. Search for that term
4. Come back and continue the setup

### Step 3: Verify Everything Works

**Done with setup? Verify Anya is working!**

👉 **[Check Verification Guide](VERIFICATION.md)** - Tests to confirm everything is properly installed

---

## Common Terms You'll See

The ten terms that come up most during setup. (Full explanations for all of these live in the [Glossary](TECHNICAL_GLOSSARY_WITH_TOOLTIPS.md).)

1. **Database** - The digital filing cabinet where all your grant and profile information is stored.
2. **Environment Variables** - Settings in a `.env` file that tell the app where its database, keys, and passwords are. Most setup problems trace back to these.
3. **API Key** - A secret password (like `ANTHROPIC_API_KEY`) that lets Anya talk to the AI service. Without it, Anya can't respond.
4. **Backend** - The behind-the-scenes part of the app that does the real work. It runs as a "server."
5. **Frontend** - The part of the app you see and click in your browser.
6. **Localhost** - Your own computer. During setup, the app runs at addresses like `http://localhost:5173` that only you can see.
7. **Terminal (CLI)** - The typing window where you enter commands like `npm install`. Every code snippet in the setup guide is typed here.
8. **Migration** - A careful, automatic renovation of the database's structure. `npm run migrate` runs them for you; running it twice is safe.
9. **Crawler** - The automated librarian that finds grant opportunities online while you do other things.
10. **JWT / Token** - Your digital ID badge after logging in. It's why you don't have to re-enter your password on every page.

**When you see any of these in a doc, don't panic** - open the glossary, read the plain-language line, and keep going. You never need to memorize them.

---

## Which Document Do I Need? (Navigation Map)

Every document exists for one moment in your journey. Here's when to open each:

| When you're... | Open this | What it gives you |
|---|---|---|
| Confused by a technical word | [TECHNICAL_GLOSSARY_WITH_TOOLTIPS.md](TECHNICAL_GLOSSARY_WITH_TOOLTIPS.md) | 35+ terms in plain language |
| Installing Anya for the first time | [ANYA_SETUP_GUIDE.md](ANYA_SETUP_GUIDE.md) | Step-by-step setup instructions |
| Finished setup and want proof it worked | [VERIFICATION.md](VERIFICATION.md) | Checks that confirm a healthy install |
| Setting up the `.env` file | [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable explained |
| Seeing an error you don't understand | [ERROR_LEDGER.md](ERROR_LEDGER.md) | Known errors and what they mean |
| Wanting the big picture of all docs | [README.md](README.md) | The documentation index |

**Rule of thumb:** you only ever need ONE of these open at a time, plus the glossary in a second tab.

---

## Tips for a Smooth Setup

1. **Go in order.** Glossary skim → Setup Guide → Verification. Skipping ahead is where confusion starts.
2. **Copy-paste commands exactly.** A single missing character in a terminal command changes its meaning. Copy the whole line.
3. **One step at a time.** Finish each setup step and check its result before starting the next. If a step fails, later steps will too - fix it now.
4. **Errors are information, not failure.** Read the last few lines of any error message. They usually name the exact thing that's missing (often an environment variable or API key).
5. **It's safe to retry.** The setup commands are designed to be re-runnable (see *Idempotency* in the glossary). If something was interrupted, run it again.
6. **Keep the glossary open in a second tab.** Looking a term up takes ten seconds; guessing what it means costs an hour.
7. **When stuck, note three things:** the command you ran, the last error line, and which step of the guide you were on. With those three, anyone can help you quickly.

**You've got this.** Nobody understands these terms on day one - the whole point of these guides is that you don't have to.
