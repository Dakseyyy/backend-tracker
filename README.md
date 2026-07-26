# Affiliate → Meta CAPI forwarder

A minimal Next.js App Router project that accepts affiliate-network GET postbacks, looks up an offer-specific Meta dataset configuration in Supabase, builds the Meta `fbc`, forwards a `Purchase` event to Conversions API, and displays the result in a monochrome dashboard.

## What is included

- `app/page.js`: Server Component dashboard, Supabase reads, create/edit/toggle Server Actions, optional password gate, styling, and lightweight auto-refresh.
- `app/api/postback/route.js`: Public affiliate postback endpoint. It returns `200 OK` immediately and completes database/Meta work through Next.js `after()`.
- `app/layout.js`: Required App Router root layout.
- `app/loading.js`: Loading skeleton.
- `schema.sql`: Idempotent base schema plus recommended `offer_id`, `transaction_id`, and `status` event columns.
- `.env.local`: Your supplied project URL/publishable key plus placeholders for secrets.

## 1. Put the files in GitHub

Copy the contents of this folder into the root of your empty repository, then run:

```bash
git add .
git commit -m "Build affiliate Meta CAPI forwarder"
git push
```

`.env.local` is intentionally ignored by Git. Do not force-add it.

## 2. Add the Supabase service-role key

Open `.env.local` and replace:

```env
SUPABASE_SERVICE_ROLE_KEY=PASTE_YOUR_SECRET_SERVICE_ROLE_KEY_HERE
```

Use the secret/service-role key from Supabase project settings. It must never have a `NEXT_PUBLIC_` prefix.

Also replace the dashboard password:

```env
DASHBOARD_PASSWORD=CHANGE_THIS_TO_A_LONG_RANDOM_PASSWORD
```

If `DASHBOARD_PASSWORD` is empty or absent, the dashboard is publicly accessible. The postback endpoint always remains public because the affiliate network must reach it.

## 3. Run the SQL migration

Even though your two tables already exist, run `schema.sql` once in **Supabase → SQL Editor**. It is designed to preserve existing tables and add the recommended event metadata:

- `events.offer_id` for exact indexed counts
- `events.transaction_id` plus a partial unique index for deduplication
- `events.status` for `received`, `sent`, `failed`, or `duplicate`
- RLS enabled with no public policies, while granting server-side access to `service_role`

Before creating the unique indexes, remove any existing duplicate `configs.offer_id` or non-null `events.transaction_id` values if Supabase reports a uniqueness error.

## 4. Install and run locally

Use Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

The project installs both requested Supabase packages. The application itself uses `@supabase/supabase-js` directly because it is a server-only service-role client and does not need cookie-based Supabase Auth. `@supabase/ssr` remains installed for a later user-auth flow.

## 5. Add an offer

In the dashboard, click **Add offer** and enter:

- Offer ID exactly as the affiliate network sends it
- Meta pixel/dataset ID
- Meta Conversions API access token
- Default payout

The access token is never selected back into the rendered dashboard. On edit, leave the token field blank to keep the current token.

## 6. Test the postback locally

Create an active config for offer `91872`, then call:

```bash
curl "http://localhost:3000/api/postback?source=TEST_FBCLID_123&offer_id=91872&transaction_id=test-order-001"
```

The HTTP response should immediately be:

```text
OK
```

Within a few seconds, the raw request appears in the live log. Its status becomes:

- `sent`: Meta accepted the CAPI request
- `failed`: missing config/fbclid, inactive config, or Meta rejected/timed out
- `duplicate`: the same non-empty `transaction_id` was already processed

Use a new `transaction_id` for each intentional test. Reusing it tests deduplication and will not send another event to Meta.

## 7. Give the affiliate network the production URL

After deployment, use:

```text
https://YOUR-DOMAIN.com/api/postback?source={FBCLID_MACRO}&offer_id={OFFER_ID_MACRO}&transaction_id={TRANSACTION_ID_MACRO}
```

Replace the braces with the network's exact macros. A fixed offer can also be hardcoded:

```text
https://YOUR-DOMAIN.com/api/postback?source={FBCLID_MACRO}&offer_id=91872&transaction_id={TRANSACTION_ID_MACRO}
```

The handler expects:

- `source`: the bare `fbclid`
- `offer_id`: the configured affiliate offer identifier
- `transaction_id`: a stable unique conversion/order identifier, strongly recommended

It creates:

```text
fbc = fb.1.<arrival timestamp in milliseconds>.<fbclid>
```

The 13-digit timestamp comes from `Date.now()` at postback arrival. When `source` is absent, the handler records a failure and does not invent an `fbc`.

## 8. Deploy on Vercel

1. Import the GitHub repository into Vercel.
2. Leave the framework preset as **Next.js**.
3. Add these environment variables for Production, Preview, and Development as needed:

```env
NEXT_PUBLIC_SUPABASE_URL=https://iwivjuiwicjojickibhd.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_vJM4bGBw8HlhStITWGh7ng_QDGSF2EO
SUPABASE_SERVICE_ROLE_KEY=your_real_secret_key
DASHBOARD_PASSWORD=your_long_random_password
META_GRAPH_API_VERSION=v24.0
META_CURRENCY=USD
```

4. Deploy.
5. Open the dashboard and copy the displayed base postback URL.
6. Send one test postback and confirm its live-log status.

`META_GRAPH_API_VERSION` is configurable so you can change versions without editing code when Meta retires an API version.

## Processing behavior

The request path is intentionally lean:

1. Capture arrival time and the exact raw query substring.
2. Read `source`, `offer_id`, and `transaction_id`.
3. Register the remaining work with Next.js `after()`.
4. Return `200 OK` immediately.
5. In post-response work, insert the event, stop duplicates, load the config, build `fbc`, call Meta, and update status.

The Meta payload is effectively:

```json
{
  "data": [
    {
      "event_name": "Purchase",
      "event_time": 1760000000,
      "event_id": "network-transaction-id",
      "action_source": "website",
      "user_data": {
        "fbc": "fb.1.1760000000000.fbclid-value"
      },
      "custom_data": {
        "currency": "USD",
        "value": 12.5
      }
    }
  ]
}
```

`event_time` is Unix seconds, while the timestamp inside `fbc` is milliseconds.

## Operational notes

- The dashboard refreshes every eight seconds only when the tab is visible and no form/details panel is open.
- Enhanced per-offer cards count successful `sent` events. If the optional columns were not added, the page falls back to parsing all raw queries and shows legacy-mode postback counts.
- A duplicate request is logged with `status = duplicate`, but its `transaction_id` is stored as `null` so the original unique transaction row remains authoritative.
- Meta errors are written to Vercel function logs, not returned to the affiliate network and not exposed in the UI.
- A `200 OK` only confirms receipt by your endpoint. The dashboard status confirms whether Meta accepted the event.
- Since the service-role key bypasses RLS, keep it only in server environment variables and rotate it immediately if it is ever exposed.

## Official references

- Next.js Route Handlers: https://nextjs.org/docs/app/getting-started/route-handlers
- Next.js `after()`: https://nextjs.org/docs/app/api-reference/functions/after
- Next.js Server Action forms: https://nextjs.org/docs/app/guides/forms
- Supabase server-side secret client guidance: https://supabase.com/docs/guides/troubleshooting/performing-administration-tasks-on-the-server-side-with-the-servicerole-secret-BYM4Fa
