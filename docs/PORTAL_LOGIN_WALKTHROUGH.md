# Portal Login Walkthrough — Sign in → Hamilton's side‑by‑side portal logins

A plain‑language, step‑by‑step guide for getting from the GrantFlow sign‑in
screen to the **side‑by‑side portal login** window, where Hamilton signs you
in (or helps you finish a login it can't do alone).

There are three walkthroughs below — one for each person:

- **Demo Applicant** — signs in to their own profile.
- **Demo Student** — signs in to her own profile.
- **Demo Caregiver** — signs in with **their own** account and works on a
  **Demo Senior** profile they are authorized to manage.

> **You will need:** your email + password for GrantFlow, and the **vault
> passphrase** (already set — the one you were given). You'll type the vault
> passphrase once per session to "unlock" so Hamilton can use the saved logins.

---

## The short version (all three people)

1. **Open GrantFlow** in your browser (your usual GrantFlow link).
2. **Sign in** with your email + password.
3. Go to **Profiles** and **open the right profile** (Demo Applicant/Demo
   Student = your own; Demo Caregiver = "Demo Senior Medical Persona").
4. Open the **"Portals & pipeline"** tab (the key 🔑 icon).
5. **Unlock the vault:** open **"Portal Autopilot"**, type the **master
   passphrase**, click **Unlock** (badge turns green → *Unlocked*).
6. On a portal tile, click **"Log in once →"** or **"Open side‑by‑side
   login."** A secure window opens — **sign in, approve any 2FA, click Done.**
   The tile turns **green (Ready)**.

The detailed version follows.

---

## Step 1 — Open GrantFlow and sign in

1. Open your browser and go to your **GrantFlow** link.
2. On the **"Sign in to GrantFlow"** screen, enter your **email address**.
   - **First time ever signing in?** GrantFlow emails you a **one‑time link**.
     Open the email, click the link, and **set your password**. (Check spam if
     it doesn't arrive in a minute.)
   - **Signed in before?** Just enter your **email + password**.
3. After signing in you land on the **Dashboard**.

> **Who signs in as whom**
> - **Demo Applicant** signs in with their own email/password.
> - **Demo Student** signs in with **Demo Student's** email/password.
> - **Demo Caregiver** signs in with their own email/password
>   (`demo.caregiver@example.invalid`) — **not** the senior applicant's. Because
>   that email is attached through an authorized relationship, the Demo Senior
>   profile appears in the caregiver's list automatically. If it does not,
>   see *Troubleshooting*.

## Step 2 — Open the right profile

1. In the left navigation, click **Profiles** (the "My Profiles" page).
2. You'll see a card for each profile you can work on. Use the **search box**
   at the top if you have several.
   - **Demo Applicant** → click their own profile card.
   - **Demo Student** → click **Demo Student's** profile card.
   - **Demo Caregiver** → click the **"Demo Senior Medical Persona"** card.
3. Clicking a card opens that profile's workspace (**Profile Detail**).

## Step 3 — Go to the "Portals & pipeline" tab

1. In the profile workspace, find the row of workspace tabs.
2. Click **"Portals & pipeline"** — it has a **key 🔑 icon** and the subtitle
   *"Logins, funding sources, and applications."*
   - (Shortcut: from the **Master Pipeline** page you can click the **Portal
     Logins** button, which jumps you straight to this section.)
3. You'll see the **Portals** dashboard: a grid of **tiles**, one per place you
   sign in (schools, funders, benefits/assistance sites).
   - **Green tile = "Ready"** — already signed in; Hamilton can use it.
   - **Red tile = "Needs login"** — click it to log in once.

## Step 4 — Unlock the vault (one passphrase, once per session)

Hamilton keeps each portal's login in a locked vault. You unlock it with the
**master passphrase** so Hamilton can use (and create) those logins.

1. On the Portals dashboard, find the **"Portal Autopilot"** section (it has a
   **key 🔑 icon** and a status badge on the right).
   - The badge reads **Locked** when the passphrase is set but not yet entered
     this session. (If it somehow says **No passphrase**, see *Troubleshooting*.)
2. Click the **"Portal Autopilot"** header to expand it.
3. In **"Master passphrase (enter to unlock)"**, type the **vault passphrase
   you were given**.
4. Click **Unlock**.
5. The badge turns **green → "Unlocked."** Hamilton can now use this profile's
   saved logins.

> The passphrase is **never stored or shown** — you enter it to unlock for the
> session. Forgot it? Use **"Forgot your passphrase? Reset it"** (note:
> resetting makes Hamilton regenerate any logins it had created before).

*(Optional, recommended once:)* just above the tiles there's a one‑switch card,
**"Let Hamilton do it all for this profile"** / the **Autopilot consent** toggle.
Turning it on gives Hamilton standing permission to use this profile's saved
logins on every portal, so you don't approve each site one at a time.

## Step 5 — Open a side‑by‑side portal login

Now the actual sign‑in. On any tile you'll see one of these buttons:

| Tile / button | What it means | What to click |
|---|---|---|
| **Red "Needs login"** → **"Log in once →"** | No login saved yet | Click it |
| **"Open side‑by‑side login"** (coral) | Hamilton can't do this one alone — it needs you for a 2FA approval, a CAPTCHA, or ID verification | Click it |
| **Green "Ready"** → **"Refresh sign‑in"** | Already signed in; re‑open to refresh the session | Click if a session went stale |
| Banner: **"Hamilton needs you to finish signing in"** | Hamilton hit a wall and deep‑linked you here | Click **"Open side‑by‑side login"** |

When you click any of those:

1. **Allow pop‑ups** for GrantFlow if your browser asks — the login opens in a
   **secure pop‑up window**. (If it was blocked, allow pop‑ups and click again.)
2. The window opens **already pointed at the portal** (you don't type the web
   address). You'll see the portal's real sign‑in page **side‑by‑side**.
3. **Sign in**: enter the portal username/password, and **approve any 2‑factor
   prompt** (text code, authenticator app, or a "tap to approve" push on your
   phone).
4. When you're through the login, click **Done** (or simply **close the
   window**).
5. Back on the Portals dashboard, the tile **turns green → "Ready."** That's
   the finish line — Hamilton can now work that portal on its own.

Repeat Step 5 for each red tile you want set up.

---

## What Hamilton does after a tile is green

- On password‑only portals, Hamilton can sign in on its own from then on.
- For portals it can fully set up itself, use **"Set up with Hamilton"** on the
  tile (vault must be **Unlocked**) or **"Run Autopilot (whole profile)"** to do
  every eligible portal at once.
- Anything that still needs a human each visit (push‑2FA, CAPTCHA, ID proofing)
  stays as an **"Open side‑by‑side login"** tile so you can jump in when asked.

## Troubleshooting

- **The caregiver doesn't see the Demo Senior profile.** Their login email is
  not attached to that profile yet. The account owner/admin must grant access
  to `demo.caregiver@example.invalid` (Profile → emails/access), then the
  caregiver signs out and back in.
- **Badge says "No passphrase."** The vault passphrase hasn't been set for this
  profile. Enter one (8+ characters) in **"Master passphrase (set one)"** and
  click **Set passphrase** — that becomes the passphrase to unlock next time.
- **"Unlock failed."** The passphrase was mistyped. Re‑enter it and try again.
- **The secure window says "Connecting…" then stops.** Click **Reconnect** in
  that window (the secure browser stays alive ~15 minutes). If it still fails,
  close it and click the tile again.
- **Pop‑up blocked.** Allow pop‑ups for GrantFlow in your browser, then click
  the tile again.
- **A tile won't turn green after you signed in.** Close the login window fully;
  the dashboard refreshes when the window closes. You can also click the
  **refresh** ↻ button at the top‑right of the Portals card.

## Where each thing lives (quick reference)

- **Sign‑in:** GrantFlow login screen → email + password (first time = email
  link to set a password).
- **Profiles:** left nav → **Profiles**.
- **Portals dashboard + vault + side‑by‑side buttons:** open a profile → the
  **"Portals & pipeline"** tab (🔑).
- **Unlock:** the **"Portal Autopilot"** section on that tab.
- **Side‑by‑side login:** the **"Log in once →"** / **"Open side‑by‑side
  login"** / **"Refresh sign‑in"** buttons on each portal tile.
