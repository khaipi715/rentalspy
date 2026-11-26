# RentalSpy

**Know what you'll really pay before you sign.** A free, renter-run website showing what rent costs for every address in Mawson Lakes and 11 nearby suburbs (Adelaide, SA), plus what renters say about places.

- **Expected rent** from the SA Government's bond data, by unit/house and bedrooms, with trends since 2022.
- **Every address** (40,630, from G-NAF) has its own page; every street (1,440) and suburb (12) has a page Google can find.
- **Safety** from SA Police crime statistics.
- **Renter reports**: rent paid, ratings, checkboxes, and one short tip. No names, ever.
- **Give-to-get**: anyone sees counts and average ratings; people who share their own rent see everyone's.
- **No email needed** to share (anonymous accounts).
- **Low upkeep**: tips are approved by you before showing, anything reported 3 times hides itself, a daily check emails you only when something needs you, and data refreshes itself every quarter.

**To put it online, follow [SETUP.md](SETUP.md).**

## How it's built

| Part | Tool |
|---|---|
| Website | [Astro](https://astro.build), all pages pre-built (static), hosted free on Vercel |
| Database, accounts | [Supabase](https://supabase.com) (Postgres with row-level security) |
| Map | [MapLibre](https://maplibre.org) with free [OpenFreeMap](https://openfreemap.org) tiles |
| Public data | `data-pipeline/build_data.py` (rent, crime, addresses, suburb outlines) |

```
src/pages/            home, suburb/[slug], street/[suburb]/[street], place (one address), add, me, admin, rules...
src/components/       RentTool (expected rent + chart), SearchBox, SuburbMap
src/lib/              supabase client, renter reports, formatting
src/data/             built public data (suburbs, streets, meta)
public/data/streets/  one JSON file per street with every address and its coordinates
supabase/migrations/  the whole database, with all safety rules
supabase/tests/       database safety tests (25 checks)
tests/e2e/            browser test of the full flow, against a local stand-in for Supabase
.github/workflows/    tests, keep-alive, moderation alert, quarterly data refresh
```

## Developing

```bash
npm install
cp .env.example .env   # fill in your Supabase URL and anon key
npm run dev            # http://localhost:4321
```

Without Supabase settings the site still works with public data; adding rent is disabled.

```bash
npm run data           # re-download public data (needs: pip install openpyxl)
npm run build          # builds ~1,460 pages into dist/
```

### Tests

```bash
# database rules (needs a local Postgres; set PGHOST/PGPORT/PGUSER)
npm run test:db

# full browser flow: start tests/e2e/fake-supabase.mjs against a database with
# supabase/tests/mock_supabase.sql + the migration loaded, build the site pointing at it,
# run `npx astro preview`, then:
BASE=http://127.0.0.1:4321 DATABASE_URL=postgres://... npm run test:e2e
```

`tests/e2e/fake-supabase.mjs` is a test-only stand-in for Supabase's API. It runs every request as the real database role with the real security rules, but it isn't Supabase itself, so do the 5-minute check in SETUP.md after the first real deploy.

## Data sources and credits

- Rent: SA Government Private Rental Report (bond lodgements, Consumer and Business Services), data.sa.gov.au
- Crime: SA Police crime statistics, data.sa.gov.au
- Addresses: Incorporates or developed using G-NAF © Geoscape Australia licensed by the Commonwealth of Australia under the Open G-NAF End User Licence Agreement
- Suburb outlines, landmarks and map data: © OpenStreetMap contributors; tiles by OpenFreeMap

## Known limits

- Government rent is a **suburb median for new leases**, not a figure for a specific house. Renter reports fill that gap.
- Anonymous accounts live in one browser. Clearing browser data loses access to edit or delete (the entries stay). Saving an email fixes this once email sending is set up (SETUP.md step 7).
- Terms, privacy and rules pages are plain-language drafts, not reviewed by a lawyer. Have them checked when the project can afford it.
- Crime figures are counts, not rates per resident.
