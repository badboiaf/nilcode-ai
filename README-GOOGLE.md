# Google Sign-In Setup for NULLCODE

NULLCODE uses **Google Identity Services (GIS)** — the current approach — with
server-side ID token verification against Google's public keys. Login uses
**identity-only scopes**: no Drive, Gmail, or Calendar access, now or ever, unless
you later build separate, explicit authorization flows.

No Google client secret is used or stored anywhere in this flow.

## What you need to click in Google Cloud

1. Go to <https://console.cloud.google.com/> and sign in.
2. Top bar → **project dropdown** → **New Project** → name it `NULLCODE` → **Create**.
3. With that project selected: **APIs & Services → OAuth consent screen**:
   - User type: **External** → **Create**.
   - App name: `NULLCODE` · User support email: your email · **Save**.
   - Scopes: add **`openid`**, **`email`**, **`profile`** (these are automatic in GIS login; nothing else).
   - Test users: add the Google accounts you want to test with (required while the app is in *Testing* mode).
   - When ready for the public: **Publish app**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Name: `NULLCODE Web`.
   - **Authorized JavaScript origins** — add BOTH:
     - `http://localhost:4310` (local development)
     - your production origin, e.g. `https://app.xeer0.online` (never the server IP)
   - **Authorized redirect URIs**: leave empty (GIS uses popup/One Tap, no redirect).
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

## Configure NULLCODE

Set the client ID when starting the server (local) or in your hosting dashboard
(production):

```bash
# Windows (PowerShell)
$env:NULLCODE_GOOGLE_CLIENT_ID="1234-abc.apps.googleusercontent.com"
npm start

# Windows (cmd)
set NULLCODE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com

# Linux/macOS production
NULLCODE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com npm start
```

For the packaged **NULLCODE.exe**: put the value in a `.env` file next to the exe:

```
NULLCODE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
```

The Google button appears automatically once the server knows the client ID;
without it the button is hidden and email sign-in continues to work.

## How the flow works (what NULLCODE does for you)

1. The auth page loads Google's GIS client **only when configured** and renders
   the official "Continue with Google" button.
2. After the user picks an account, Google returns a short-lived **ID token**.
3. NULLCODE's server verifies it: RS256 signature against Google's JWKS,
   issuer, audience (your client ID), expiry, and a verified email.
4. The matching NULLCODE account is created or linked by email, a NULLCODE
   session token is issued, and the user stays signed in for 30 days.
5. Sign out clears the session; cancelled popups and expired tokens just show a
   friendly error on the auth page.

## Multi-user isolation

Google accounts map to the same per-user data model as email accounts:
workspaces, projects, conversations, attachments, GitHub tokens, and provider
keys are isolated per `user id` exactly as before. No cross-account access is
possible through file IDs, URLs, or API routes.

## Adding more Google services later

Deliberately **not** requested during login. When you need e.g. Drive backup:
add a separate OAuth authorization-code flow with `https://www.googleapis.com/auth/drive.file`
behind its own consent screen and its own credentials; store per-user refresh
tokens in that user's isolated credentials directory. The auth architecture
(`upsertExternalUser`, per-user credential storage) is ready for this.
