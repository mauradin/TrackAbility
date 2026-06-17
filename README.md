# TrackAbility ◢◤

A two-person accountability tracker with a StarCraft II command-console theme.
Static site (GitHub Pages) + Firebase Firestore (shared live data) + EmailJS (nudge emails).

**Sidebar tiers:** Operatives (people) → Dates → Daily log (tasks + mission note).
**Views:** List and Kanban (drag cards between QUEUED / IN PROGRESS / COMPLETE).
**Nudge:** Each operative has an email; if they're behind today, hit ▲ NUDGE to email them.

---

## ✅ Already configured
- Firebase web config — wired in `config.js`
- EmailJS public key + template (`AccountabilityPing`) — wired in `config.js`

## ⏳ You still need to do these (one time, ~5 min)

### 1. Create the Firestore database  *(console — required)*
1. Go to <https://console.firebase.google.com/project/trackability-35d4e/firestore>
2. Click **Create database** → **Start in production mode** → pick a region → **Enable**.
   *(Production mode is fine — we publish open rules in the next step.)*

### 2. Publish the security rules
**Option A — CLI (recommended):**
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules
```
(The repo already has `firebase.json`, `.firebaserc`, and `firestore.rules`.)

**Option B — Console:** open the **Rules** tab in Firestore, paste the contents of
[`firestore.rules`](firestore.rules), and click **Publish**.

> These rules allow open read/write (no login) — intended for a private,
> URL-shared tracker. Don't store anything sensitive.

### 3. Finish EmailJS (for the nudge button)
In <https://dashboard.emailjs.com>:
1. **Email Services** → add a service (e.g. Gmail) → copy the **Service ID** →
   paste it into `config.js` → `emailjs.serviceId`. *(This is the only EmailJS value left.)*
2. Make sure your **AccountabilityPing** template uses these variables (rename them
   in the template if they differ):
   `{{to_email}}`, `{{to_name}}`, `{{from_name}}`, `{{message}}`, `{{days_behind}}`
   — and set the template's **To Email** field to `{{to_email}}`.

> Your EmailJS **private** key is intentionally NOT in this repo — the browser
> SDK only needs the public key. Keep the private key for server-side use only.

### 4. Deploy to GitHub Pages
- Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**
- Branch: `main`, folder: `/ (root)` → **Save**.
- Your site: `https://mauradin.github.io/TrackAbility/`

---

## Run locally
Because the app uses ES module imports, open it through a tiny web server (not `file://`):
```bash
npx serve .
# then open the printed http://localhost:3000
```

## Files
| File | Purpose |
|------|---------|
| `index.html` | markup / SDK loads |
| `styles.css` | Terran command-console theme |
| `app.js` | Firestore live sync, task/kanban logic, nudges |
| `config.js` | your Firebase + EmailJS keys |
| `firestore.rules` | open read/write rules |
| `firebase.json`, `.firebaserc` | enable `firebase deploy` |
