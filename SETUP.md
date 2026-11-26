# Putting RentalSpy online: step by step

About **1–2 hours, once**. No coding. Everything here is free except the domain name.

You'll create three free accounts: **GitHub** (stores the code), **Supabase** (the database), **Vercel** (puts the website online).

> Screens on these sites change from time to time. If a button has a slightly different name, look for the closest match, or ask Claude.

---

## 1. GitHub: store the code

1. Sign up at **github.com** (free).
2. Click **+** (top right) → **New repository**. Name it `rentalspy`. Choose **Private**. Don't tick any boxes. Click **Create repository**.
3. Tell Claude the repository name (for example `yourname/rentalspy`). Claude uploads the code for you.

## 2. Supabase: the database

1. Sign up at **supabase.com** (free). **Use the same email you want to use as the admin.**
2. **New project**: name `rentalspy`, region **Sydney**, create a strong database password and save it in your password manager.
3. Wait for it to finish setting up (a minute or two).
4. Left menu → **SQL Editor** → **New query**. Open `supabase/migrations/0001_init.sql` from the repository, copy **all** of it, paste it in, and click **Run**. It should say "Success".
5. Left menu → **Authentication** → **Sign In / Providers** (may be called "Providers" or "Settings") → turn on **Allow anonymous sign-ins** → Save.
   *This is what lets renters add their rent without an email.*
6. **Authentication** → **URL Configuration** → **Site URL**: put your website address (for now the Vercel address from step 3; change it when you have a domain).
7. Left menu → **Project Settings** → **API** (or **API Keys**). Copy two things somewhere safe:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key, or the **publishable** key (a long string). This key is safe to put in a website.
   - ⚠️ Never copy the **service_role** or **secret** key anywhere.

### Make yourself the admin

1. **Authentication** → **Users** → **Add user** → **Create new user**: your email (the same one as your Supabase account), any password, tick **Auto confirm**.
2. **SQL Editor** → New query → paste this, with your email, and click **Run**:
   ```sql
   update public.profiles set is_admin = true
   where id = (select id from auth.users where email = 'YOUR-EMAIL-HERE');
   ```

## 3. Vercel: put the website online

1. Sign up at **vercel.com** with your GitHub account (free "Hobby" plan, which is for non-commercial projects; a free, not-for-profit site fits).
2. **Add New** → **Project** → pick the `rentalspy` repository → **Import**.
3. It detects **Astro** automatically. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `PUBLIC_SUPABASE_URL` | the Project URL from Supabase |
   | `PUBLIC_SUPABASE_ANON_KEY` | the anon public / publishable key |
   | `PUBLIC_SITE_URL` | your site address, e.g. `https://rentalspy.vercel.app` (change it later to your domain) |
   | `PUBLIC_CONTACT_EMAIL` | the email for complaints and legal notices (required, see step 6) |

4. Click **Deploy**. After about a minute you get a link like `rentalspy.vercel.app`. That's your live site.

From now on, every change pushed to GitHub updates the site automatically.

## 4. Turn on the automatic upkeep

In GitHub: your repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add two:

- `SUPABASE_URL`: the Project URL
- `SUPABASE_ANON_KEY`: the anon public / publishable key

These three jobs then run by themselves (see the **Actions** tab):

| Job | When | What it does |
|---|---|---|
| Keep database awake | Twice a week | Free Supabase projects pause after a week of no visitors. This stops that. |
| Moderation alert | Daily | If a tip needs approving or an entry was reported, GitHub emails you. Otherwise silence. |
| Refresh public data | Every quarter | Downloads the latest SA rent and crime data, and the site updates itself. |

> If you never get a moderation email, check GitHub → your profile → **Settings** → **Notifications** → **Actions** is on, or just glance at the Actions tab once a week.

## 5. Check it works (5 minutes)

On your live site:

1. Search `12 Adeline` and open the address. You should see expected rents.
2. Click **Add your rent**, fill it in, add a short tip, submit. It should say **Everything is unlocked**.
3. Open **My places**: your entry is there.
4. Go to `/admin/`, enter your admin email and click the link in the email. Your tip should be waiting. Approve it.
5. Delete your test entry on **My places**.

If anything fails, copy the error and send it to Claude.

## 6. A contact email (required)

The site shows `PUBLIC_CONTACT_EMAIL` on the **Report a problem** page. It's where landlords and lawyers send complaints and defamation "concerns notices". Use an email you actually check, and **reply within 48 hours**. A free Gmail like `rentalspy.help@gmail.com` is fine to start.

## 7. Optional, later

- **Your own domain.** `.au` names (e.g. `rentalspy.au`) only need you to be an Australian citizen or resident. `.com.au` is for businesses, and registrars usually ask for an ABN. Check availability at any registrar (about $15–30 a year). Then: Vercel → Project → **Settings** → **Domains** → add it and follow the instructions. Update `PUBLIC_SITE_URL` in Vercel and the **Site URL** in Supabase.
- **Let people save an email** (to keep their entries on a new phone). Supabase's built-in email only sends to you, the project owner. To send to everyone: make a free account at **resend.com**, verify your domain, then Supabase → **Authentication** → **Emails** → **SMTP Settings** → enter Resend's details. Then add `PUBLIC_EMAIL_ENABLED` = `true` in Vercel and redeploy.
- **Spam protection.** If fake entries start appearing, ask Claude to add CAPTCHA. Don't switch it on in Supabase alone, or adding rent will stop working.
- **Google.** Sign in to **Google Search Console**, add your site, and submit `https://your-site/sitemap.xml`. That's how street pages start appearing when people Google an address.

## Your weekly routine

- When GitHub emails you a "Moderation alert": open `/admin/`, approve or reject tips, keep or remove reported entries. Usually a few minutes.
- Answer complaint emails within 48 hours. If unsure, hide or remove the entry first.
- Nothing else. Data updates itself.

## Costs

| Item | Cost |
|---|---|
| GitHub, Supabase, Vercel (free plans) | $0 |
| Map tiles (OpenFreeMap) | $0 |
| Domain (optional) | ~$15–30 a year |
| Resend email (optional) | $0 up to its free limit |
