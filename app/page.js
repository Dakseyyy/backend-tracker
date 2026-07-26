import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Script from "next/script";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_COOKIE = "affiliate_capi_dashboard";
const CURRENCY = process.env.META_CURRENCY || "USD";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function expectedSessionToken() {
  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!password || !secret) return "";

  return createHmac("sha256", secret)
    .update(`affiliate-capi-dashboard:${password}`)
    .digest("hex");
}

async function isAuthorized() {
  if (!process.env.DASHBOARD_PASSWORD) return true;
  const store = await cookies();
  const actual = store.get(SESSION_COOKIE)?.value || "";
  return safeEqual(actual, expectedSessionToken());
}

async function requireAuthorization() {
  if (!(await isAuthorized())) {
    throw new Error("Unauthorized");
  }
}

function redirectWithNotice(message, tone = "success") {
  revalidatePath("/");
  redirect(
    `/?notice=${encodeURIComponent(message)}&tone=${encodeURIComponent(tone)}`,
  );
}

function textValue(formData, name) {
  return String(formData.get(name) || "").trim();
}

function validateOfferId(value) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function parsePayout(value) {
  const payout = Number(value);
  if (!Number.isFinite(payout) || payout < 0) {
    throw new Error("Payout must be zero or greater.");
  }
  return payout;
}

async function loginAction(formData) {
  "use server";

  const configuredPassword = process.env.DASHBOARD_PASSWORD;
  const suppliedPassword = textValue(formData, "password");

  if (!configuredPassword) {
    redirectWithNotice("Dashboard password is not configured.", "error");
  }

  if (!safeEqual(suppliedPassword, configuredPassword)) {
    redirect("/?login=failed");
  }

  const store = await cookies();
  store.set(SESSION_COOKIE, expectedSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  redirect("/");
}

async function logoutAction() {
  "use server";
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/");
}

async function createConfig(formData) {
  "use server";

  try {
    await requireAuthorization();

    const offerId = textValue(formData, "offer_id");
    const pixelId = textValue(formData, "pixel_id");
    const token = textValue(formData, "pixel_access_token");
    const payout = parsePayout(textValue(formData, "payout"));

    if (!validateOfferId(offerId)) {
      throw new Error("Offer ID contains unsupported characters.");
    }
    if (!pixelId || !token) {
      throw new Error("Pixel ID and access token are required.");
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("configs").insert({
      offer_id: offerId,
      pixel_id: pixelId,
      pixel_access_token: token,
      payout,
      active: true,
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;
  } catch (error) {
    redirectWithNotice(error.message || "Could not create offer.", "error");
  }

  redirectWithNotice("Offer created.");
}

async function updateConfig(formData) {
  "use server";

  try {
    await requireAuthorization();

    const id = textValue(formData, "id");
    const offerId = textValue(formData, "offer_id");
    const pixelId = textValue(formData, "pixel_id");
    const token = textValue(formData, "pixel_access_token");
    const payout = parsePayout(textValue(formData, "payout"));

    if (!id || !validateOfferId(offerId) || !pixelId) {
      throw new Error("Offer ID and pixel ID are required.");
    }

    const update = {
      offer_id: offerId,
      pixel_id: pixelId,
      payout,
      updated_at: new Date().toISOString(),
    };

    if (token) update.pixel_access_token = token;

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("configs").update(update).eq("id", id);
    if (error) throw error;
  } catch (error) {
    redirectWithNotice(error.message || "Could not update offer.", "error");
  }

  redirectWithNotice("Offer updated.");
}

async function toggleConfig(formData) {
  "use server";

  try {
    await requireAuthorization();

    const id = textValue(formData, "id");
    const nextActive = textValue(formData, "next_active") === "true";
    if (!id) throw new Error("Missing config ID.");

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("configs")
      .update({ active: nextActive, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) throw error;
  } catch (error) {
    redirectWithNotice(error.message || "Could not change status.", "error");
  }

  redirectWithNotice("Offer status updated.");
}

async function deleteConfig(formData) {
  "use server";
  try {
    await requireAuthorization();
    const id = textValue(formData, "id");
    if (!id) throw new Error("Missing config ID.");
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("configs").delete().eq("id", id);
    if (error) throw error;
  } catch (error) {
    redirectWithNotice(error.message || "Could not delete offer.", "error");
  }
  redirectWithNotice("Offer routing deleted.");
}

async function sendTestEvent(formData) {
  "use server";
  try {
    await requireAuthorization();
    const id = textValue(formData, "config_id");
    const testEventCode = textValue(formData, "test_event_code");
    const fbclid = textValue(formData, "fbclid");
    const eventId = textValue(formData, "event_id") || `dashboard-test-${Date.now()}`;
    if (!id || !testEventCode) throw new Error("Choose an offer routing and enter the Meta test event code.");

    const supabase = getSupabaseAdmin();
    const { data: config, error: configError } = await supabase
      .from("configs")
      .select("offer_id,pixel_id,pixel_access_token,payout")
      .eq("id", id)
      .maybeSingle();
    if (configError) throw configError;
    if (!config) throw new Error("That offer routing no longer exists.");

    const now = Date.now();
    const userData = fbclid
      ? { fbc: `fb.1.${now}.${fbclid}` }
      : { client_user_agent: "Affiliate Meta CAPI dashboard test event" };
    const payload = {
      data: [{
        event_name: "Purchase",
        event_time: Math.floor(now / 1000),
        event_id: eventId,
        action_source: "website",
        user_data: userData,
        custom_data: { currency: CURRENCY, value: Number(config.payout || 0) },
      }],
      test_event_code: testEventCode,
    };
    const graphVersion = process.env.META_GRAPH_API_VERSION || "v24.0";
    const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(config.pixel_id)}/events`);
    endpoint.searchParams.set("access_token", config.pixel_access_token);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result?.error?.error_user_msg || result?.error?.message || `Meta rejected the test event (${response.status}).`);
    }
    const accepted = Number(result.events_received || 0);
    if (accepted < 1) throw new Error("Meta responded successfully but did not accept an event.");
    const trace = result.fbtrace_id ? ` Trace: ${result.fbtrace_id}` : "";
    redirectWithNotice(`Test Purchase accepted for ${config.offer_id} (${accepted} event).${trace}`);
  } catch (error) {
    redirectWithNotice(error.message || "Could not send test event.", "error");
  }
}

function isMissingOptionalColumn(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "42703" ||
    error?.code === "PGRST204" ||
    /column.*does not exist|schema cache/i.test(message)
  );
}

function offerFromRawQuery(rawQuery) {
  try {
    return new URLSearchParams(rawQuery || "").get("offer_id") || "—";
  } catch {
    return "—";
  }
}

async function loadLegacyCounts(supabase, configs) {
  const counts = Object.fromEntries(configs.map((config) => [config.offer_id, 0]));
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("events")
      .select("raw_query")
      .range(from, from + pageSize - 1);

    if (error) throw error;

    for (const event of data || []) {
      const offerId = offerFromRawQuery(event.raw_query);
      if (Object.prototype.hasOwnProperty.call(counts, offerId)) {
        counts[offerId] += 1;
      }
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return counts;
}

async function loadDashboardData() {
  const supabase = getSupabaseAdmin();

  const { data: configs, error: configsError } = await supabase
    .from("configs")
    .select("id,offer_id,pixel_id,payout,active,created_at,updated_at")
    .order("created_at", { ascending: true });

  if (configsError) throw configsError;

  let eventsResult = await supabase
    .from("events")
    .select("id,raw_query,offer_id,status,created_at")
    .order("created_at", { ascending: false })
    .limit(60);

  let hasEnhancedEvents = true;

  if (eventsResult.error && isMissingOptionalColumn(eventsResult.error)) {
    hasEnhancedEvents = false;
    eventsResult = await supabase
      .from("events")
      .select("id,raw_query,created_at")
      .order("created_at", { ascending: false })
      .limit(60);
  }

  if (eventsResult.error) throw eventsResult.error;

  let counts;
  if (hasEnhancedEvents) {
    const countResults = await Promise.all(
      (configs || []).map(async (config) => {
        const { count, error } = await supabase
          .from("events")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", config.offer_id)
          .eq("status", "sent");

        if (error) throw error;
        return [config.offer_id, count || 0];
      }),
    );
    counts = Object.fromEntries(countResults);
  } else {
    counts = await loadLegacyCounts(supabase, configs || []);
  }

  const events = (eventsResult.data || []).map((event) => ({
    ...event,
    offer_id: event.offer_id || offerFromRawQuery(event.raw_query),
    status: event.status || "received",
  }));

  return {
    configs: configs || [],
    events,
    counts,
    hasEnhancedEvents,
  };
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: CURRENCY,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

function LoginScreen({ failed }) {
  return (
    <main className="auth-shell">
      <section className="auth-card rise">
        <div className="brand-mark">A→M</div>
        <p className="eyebrow">Affiliate → Meta CAPI</p>
        <h1>Private dashboard</h1>
        <p className="muted auth-copy">
          Enter the password set in <code>DASHBOARD_PASSWORD</code> to continue.
        </p>
        {failed ? <div className="notice error">That password didn’t match. Try again.</div> : null}
        <form action={loginAction} className="stack-form">
          <label>
            <span>Password</span>
            <input
              autoFocus
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button primary block" type="submit">
            Open dashboard
          </button>
        </form>
      </section>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
    </main>
  );
}

export default async function Dashboard({ searchParams }) {
  const params = (await searchParams) || {};
  const authorized = await isAuthorized();

  if (!authorized) {
    return <LoginScreen failed={params.login === "failed"} />;
  }

  let data;
  let setupError = "";

  try {
    data = await loadDashboardData();
  } catch (error) {
    setupError = error.message || "Could not load Supabase data.";
    data = { configs: [], events: [], counts: {}, hasEnhancedEvents: false };
  }

  const headerStore = await headers();
  const host =
    headerStore.get("x-forwarded-host") || headerStore.get("host") || "localhost:3000";
  const protocol = headerStore.get("x-forwarded-proto") || "http";
  const endpoint = `${protocol}://${host}/api/postback`;

  const totalPostbacks = Object.values(data.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const activeOffers = data.configs.filter((config) => config.active).length;
  const notice = typeof params.notice === "string" ? params.notice : "";
  const noticeTone = params.tone === "error" ? "error" : "success";
  const dashboardProtected = Boolean(process.env.DASHBOARD_PASSWORD);
  const conversionLabel = data.hasEnhancedEvents
    ? "conversions forwarded to Meta"
    : "postbacks received";

  return (
    <div className="app">
      {/* ---------------- Left rail ---------------- */}
      <aside className="rail">
        <div className="rail-top">
          <div className="brand-lockup">
            <div className="brand-mark">A→M</div>
            <div>
              <p className="eyebrow">Server-side</p>
              <strong className="brand-name">Affiliate → Meta</strong>
            </div>
          </div>

          <nav className="rail-nav">
            <a href="#overview"><span>Overview</span><em>{totalPostbacks.toLocaleString("en-US")}</em></a>
            <a href="#offers"><span>Offers</span><em>{data.configs.length.toLocaleString("en-US")}</em></a>
            <a href="#test-event"><span>Test event</span><em>Meta</em></a>
            <a href="#log"><span>Live log</span><em>{data.events.length.toLocaleString("en-US")}</em></a>
          </nav>

          <div className="rail-endpoint">
            <p className="eyebrow">Postback URL</p>
            <code className="endpoint-code">{endpoint}</code>
            <button className="button secondary block copy-button" data-copy={endpoint} type="button">
              Copy endpoint
            </button>
            <p className="hint">
              Append <code>?source=&lt;fbclid&gt;&amp;offer_id=…&amp;transaction_id=…</code>
            </p>
          </div>
        </div>

        <div className="rail-foot">
          <span className={`live-tag ${setupError ? "down" : "up"}`}>
            <i className="pulse" />
            {setupError ? "Supabase unreachable" : "Connected · RLS on"}
          </span>
          {dashboardProtected ? (
            <form action={logoutAction}>
              <button className="button ghost block" type="submit">Sign out</button>
            </form>
          ) : null}
        </div>
      </aside>

      {/* ---------------- Main column ---------------- */}
      <main className="main">
        <header className="page-head rise">
          <div>
            <p className="eyebrow">Live operations</p>
            <h1>Conversion pulse</h1>
          </div>
          <div className="head-actions">
            <a className="button secondary" href="/">Refresh</a>
          </div>
        </header>

        {notice ? (
          <div className={`notice ${noticeTone} rise`} role="status">{notice}</div>
        ) : null}

        {setupError ? (
          <section className="critical-card rise">
            <p className="eyebrow">Setup required</p>
            <h2>Supabase isn’t ready yet</h2>
            <p className="muted">{setupError}</p>
            <p className="muted">
              Add the service-role key, run <code>schema.sql</code>, then refresh.
            </p>
          </section>
        ) : null}

        {!dashboardProtected ? (
          <div className="security-warning rise">
            <strong>Dashboard protection is off.</strong>
            <span> Set <code>DASHBOARD_PASSWORD</code> before deploying publicly.</span>
          </div>
        ) : null}

        {/* ---------- Hero pulse ---------- */}
        <section id="overview" className="hero rise">
          <div className="hero-primary">
            <p className="eyebrow">{data.hasEnhancedEvents ? "Forwarded conversions" : "Total postbacks"}</p>
            <div className="hero-figure">
              <strong className="big-number" data-count={totalPostbacks}>
                {totalPostbacks.toLocaleString("en-US")}
              </strong>
            </div>
            <p className="muted hero-sub">{conversionLabel} across all offers</p>
          </div>
          <div className="hero-stats">
            <div className="stat">
              <p className="eyebrow">Active offers</p>
              <strong className="stat-number" data-count={activeOffers}>
                {activeOffers.toLocaleString("en-US")}
              </strong>
              <span className="muted">of {data.configs.length.toLocaleString("en-US")} configured</span>
            </div>
            <div className="stat">
              <p className="eyebrow">Count mode</p>
              <strong className="stat-word">{data.hasEnhancedEvents ? "Indexed" : "Parsed"}</strong>
              <span className="muted">
                {data.hasEnhancedEvents ? "exact, from status column" : "derived from raw queries"}
              </span>
            </div>
          </div>
        </section>

        {/* ---------- Per-offer cards ---------- */}
        {data.configs.length ? (
          <div className="offer-grid">
            {data.configs.map((config, index) => (
              <article
                className={`offer-card rise ${config.active ? "" : "paused"}`}
                style={{ animationDelay: `${Math.min(index * 40, 280)}ms` }}
                key={config.id}
              >
                <div className="offer-card-top">
                  <span className="offer-id">{config.offer_id}</span>
                  <span className={config.active ? "dot active" : "dot"} />
                </div>
                <strong className="offer-count" data-count={data.counts[config.offer_id] || 0}>
                  {(data.counts[config.offer_id] || 0).toLocaleString("en-US")}
                </strong>
                <span className="muted offer-foot">{conversionLabel}</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state rise">
            <strong>No offers yet</strong>
            <span>Add your first offer to start routing conversions to Meta.</span>
          </div>
        )}

        {/* ---------- Offers table ---------- */}
        <section id="offers" className="section-block">
          <div className="section-heading rise">
            <div>
              <p className="eyebrow">Configuration</p>
              <h2>Offer routing</h2>
            </div>
            <button className="button primary" type="button" data-open="dialog-add">
              Add offer
            </button>
          </div>

          <div className="table-card rise">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Offer</th>
                    <th>Pixel</th>
                    <th>Payout</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th className="align-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.configs.map((config) => (
                    <tr key={config.id}>
                      <td><strong className="mono">{config.offer_id}</strong></td>
                      <td className="mono muted">{config.pixel_id}</td>
                      <td className="mono">{money(config.payout)}</td>
                      <td>
                        <span className={`state-label ${config.active ? "on" : "off"}`}>
                          {config.active ? "Active" : "Paused"}
                        </span>
                      </td>
                      <td className="muted nowrap">{dateTime(config.updated_at)}</td>
                      <td>
                        <div className="row-actions">
                          <form action={toggleConfig}>
                            <input type="hidden" name="id" value={config.id} />
                            <input type="hidden" name="next_active" value={String(!config.active)} />
                            <button className="text-button" type="submit">
                              {config.active ? "Pause" : "Enable"}
                            </button>
                          </form>
                          <button
                            className="text-button"
                            type="button"
                            data-open={`dialog-edit-${config.id}`}
                          >
                            Edit
                          </button>
                          <form action={deleteConfig} data-confirm={`Delete routing for ${config.offer_id}? This cannot be undone.`}>
                            <input type="hidden" name="id" value={config.id} />
                            <button className="text-button danger" type="submit">Delete</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!data.configs.length ? (
                    <tr>
                      <td colSpan="6" className="table-empty">No offers configured yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ---------- Meta test event ---------- */}
        <section id="test-event" className="section-block">
          <div className="section-heading rise">
            <div><p className="eyebrow">Meta diagnostics</p><h2>Test event</h2></div>
            <span className="quiet-label">Conversions API ? Purchase</span>
          </div>
          <div className="test-card rise">
            <div className="test-copy">
              <span className="test-index">01</span>
              <div>
                <h3>Send through an offer route</h3>
                <p className="muted">Choose a routing configuration, then paste the code from Meta Events Manager?s Test Events tab. The stored pixel ID, token, payout, and currency are used automatically.</p>
              </div>
            </div>
            <form action={sendTestEvent} className="test-form">
              <label><span>Offer routing</span><select name="config_id" required defaultValue="">
                <option value="" disabled>Select an offer</option>
                {data.configs.map((config) => <option value={config.id} key={`test-${config.id}`}>{config.offer_id} ? Pixel {config.pixel_id}</option>)}
              </select></label>
              <label><span>Meta test event code</span><input name="test_event_code" placeholder="TEST12345" autoComplete="off" required /></label>
              <label><span>fbclid <em>optional</em></span><input name="fbclid" placeholder="Paste a real click ID when available" autoComplete="off" /></label>
              <label><span>Event ID <em>optional</em></span><input name="event_id" placeholder="Generated automatically" autoComplete="off" /></label>
              <div className="test-submit">
                <p className="hint">Marked as a test event so it appears in Meta?s Test Events view.</p>
                <button className="button primary" type="submit" disabled={!data.configs.length}>Send test event</button>
              </div>
            </form>
          </div>
        </section>

        {/* ---------- Live log ---------- */}
        <section id="log" className="section-block">
          <div className="section-heading rise">
            <div>
              <p className="eyebrow">Live intake</p>
              <h2>Raw request log</h2>
            </div>
            <span className="quiet-label">Newest first · 60 rows</span>
          </div>

          <div className="table-card log-card rise">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Offer</th>
                    <th>Status</th>
                    <th>Raw query</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event, index) => (
                    <tr
                      key={event.id || `${event.created_at}-${index}`}
                      className="log-row"
                      style={{ animationDelay: `${Math.min(index * 16, 220)}ms` }}
                    >
                      <td className="nowrap muted mono">{dateTime(event.created_at)}</td>
                      <td><strong className="mono">{event.offer_id}</strong></td>
                      <td><StatusPill status={event.status} /></td>
                      <td><code className="raw-query">{event.raw_query || "(empty query)"}</code></td>
                    </tr>
                  ))}
                  {!data.events.length ? (
                    <tr>
                      <td colSpan="4" className="table-empty">No postbacks received yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer>
          <span>Affiliate → Meta CAPI forwarder</span>
          <span>Server-only secrets · Supabase RLS enabled</span>
        </footer>
      </main>

      {/* ---------------- Dialogs (top layer — no stacking traps) ---------------- */}
      <dialog id="dialog-add" className="dialog">
        <div className="dialog-inner">
          <div className="dialog-head">
            <div>
              <p className="eyebrow">New offer</p>
              <h3>Route an offer to Meta</h3>
            </div>
            <button className="icon-button" type="button" data-close aria-label="Close">✕</button>
          </div>
          <form action={createConfig} className="form-grid">
            <label>
              <span>Offer ID</span>
              <input name="offer_id" placeholder="91872" required />
            </label>
            <label>
              <span>Pixel / dataset ID</span>
              <input name="pixel_id" inputMode="numeric" required />
            </label>
            <label className="wide-field">
              <span>Pixel access token</span>
              <input type="password" name="pixel_access_token" required />
            </label>
            <label>
              <span>Default payout</span>
              <input name="payout" type="number" min="0" step="0.01" defaultValue="0" required />
            </label>
            <div className="form-actions wide-field">
              <button className="button ghost" type="button" data-close>Cancel</button>
              <button className="button primary" type="submit">Create offer</button>
            </div>
          </form>
        </div>
      </dialog>

      {data.configs.map((config) => (
        <dialog id={`dialog-edit-${config.id}`} className="dialog" key={`edit-${config.id}`}>
          <div className="dialog-inner">
            <div className="dialog-head">
              <div>
                <p className="eyebrow">Edit offer</p>
                <h3 className="mono">{config.offer_id}</h3>
              </div>
              <button className="icon-button" type="button" data-close aria-label="Close">✕</button>
            </div>
            <form action={updateConfig} className="form-grid">
              <input type="hidden" name="id" value={config.id} />
              <label>
                <span>Offer ID</span>
                <input name="offer_id" defaultValue={config.offer_id} required />
              </label>
              <label>
                <span>Pixel / dataset ID</span>
                <input name="pixel_id" defaultValue={config.pixel_id} required />
              </label>
              <label className="wide-field">
                <span>New token</span>
                <input
                  type="password"
                  name="pixel_access_token"
                  placeholder="Leave blank to keep current"
                />
              </label>
              <label>
                <span>Default payout</span>
                <input
                  name="payout"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={config.payout}
                  required
                />
              </label>
              <div className="form-actions wide-field">
                <button className="button ghost" type="button" data-close>Cancel</button>
                <button className="button primary" type="submit">Save changes</button>
              </div>
            </form>
          </div>
        </dialog>
      ))}

      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <Script
        id="dashboard-behavior"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (() => {
              const format = new Intl.NumberFormat('en-US');

              // Animated counters
              document.querySelectorAll('[data-count]').forEach((node) => {
                const key = 'count:' + (node.closest('.offer-card')?.querySelector('.offer-id')?.textContent || node.parentElement?.querySelector('p')?.textContent || 'metric');
                const next = Number(node.dataset.count || 0);
                const previous = Number(localStorage.getItem(key) || next);
                localStorage.setItem(key, String(next));
                if (previous === next) return;
                const start = performance.now();
                const duration = 460;
                const tick = (now) => {
                  const progress = Math.min((now - start) / duration, 1);
                  const eased = 1 - Math.pow(1 - progress, 3);
                  node.textContent = format.format(Math.round(previous + (next - previous) * eased));
                  if (progress < 1) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              });

              // Copy buttons
              document.querySelectorAll('[data-copy]').forEach((button) => {
                button.addEventListener('click', async () => {
                  try {
                    await navigator.clipboard.writeText(button.dataset.copy);
                    const original = button.textContent;
                    button.textContent = 'Copied';
                    setTimeout(() => { button.textContent = original; }, 1200);
                  } catch {}
                });
              });

              // Dialog open / close (native top layer — no z-index traps)
              document.querySelectorAll('[data-open]').forEach((button) => {
                button.addEventListener('click', () => {
                  const dialog = document.getElementById(button.dataset.open);
                  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
                });
              });
              document.querySelectorAll('dialog').forEach((dialog) => {
                dialog.querySelectorAll('[data-close]').forEach((button) => {
                  button.addEventListener('click', () => dialog.close());
                });
                // click on backdrop closes
                dialog.addEventListener('click', (event) => {
                  if (event.target === dialog) dialog.close();
                });
              });

              // Confirm destructive offer deletion
              document.querySelectorAll('form[data-confirm]').forEach((form) => {
                form.addEventListener('submit', (event) => {
                  if (!window.confirm(form.dataset.confirm)) event.preventDefault();
                });
              });

              // Strip the notice query param after it's shown
              const cleanUrl = () => {
                if (location.search.includes('notice=')) history.replaceState({}, '', '/');
              };
              setTimeout(cleanUrl, 3500);
            })();
          `,
        }}
      />
    </div>
  );
}

const styles = `
  :root {
    color-scheme: light dark;
    --bg: #f6f6f4;
    --surface: #ffffff;
    --surface-2: #f1f1ef;
    --ink: #0b0b0c;
    --muted: #74747a;
    --border: #e6e6e3;
    --border-strong: #d3d3cf;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.04);
    --shadow-lg: 0 24px 80px rgba(0,0,0,0.14);
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
    --rail-w: 300px;
    --mono: "SF Mono", ui-monospace, "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #08080a;
      --surface: #101012;
      --surface-2: #17171a;
      --ink: #f4f4f5;
      --muted: #8b8b92;
      --border: #232327;
      --border-strong: #313137;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
      --shadow-lg: 0 28px 90px rgba(0,0,0,0.6);
    }
  }

  * { box-sizing: border-box; }
  html { background: var(--bg); scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Inter, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  button, input, select { font: inherit; color: inherit; }
  button, summary, a { -webkit-tap-highlight-color: transparent; }
  a { color: inherit; }
  h1, h2, h3, p { margin: 0; }
  code, .mono { font-family: var(--mono); font-variant-ligatures: none; }

  /* ---- Type scale ---- */
  h1 { font-size: clamp(30px, 3.4vw, 44px); line-height: 1.02; letter-spacing: -0.045em; font-weight: 680; }
  h2 { font-size: clamp(22px, 2.4vw, 30px); line-height: 1.06; letter-spacing: -0.035em; font-weight: 640; }
  h3 { font-size: 20px; letter-spacing: -0.02em; font-weight: 640; }
  .eyebrow {
    color: var(--muted); font-size: 11px; font-weight: 680;
    letter-spacing: 0.14em; text-transform: uppercase;
  }
  .muted { color: var(--muted); }
  .quiet-label { color: var(--muted); font-size: 13px; }
  .big-number, .stat-number, .offer-count {
    font-family: var(--mono); font-variant-numeric: tabular-nums;
    letter-spacing: -0.04em; line-height: 0.92;
  }

  /* ---- App shell ---- */
  .app {
    min-height: 100vh;
    display: grid;
    grid-template-columns: var(--rail-w) 1fr;
  }

  /* ---- Rail ---- */
  .rail {
    position: sticky; top: 0; align-self: start;
    height: 100vh;
    display: flex; flex-direction: column; justify-content: space-between; gap: 24px;
    padding: 26px 22px;
    background: var(--surface);
    border-right: 1px solid var(--border);
  }
  .rail-top { display: flex; flex-direction: column; gap: 26px; min-height: 0; }
  .brand-lockup { display: flex; align-items: center; gap: 13px; }
  .brand-mark {
    display: grid; place-items: center;
    width: 44px; height: 44px; border-radius: 13px;
    background: var(--ink); color: var(--surface);
    font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: -0.03em;
    flex: none;
  }
  .brand-name { font-size: 15px; letter-spacing: -0.02em; display: block; margin-top: 3px; }

  .rail-nav { display: flex; flex-direction: column; gap: 2px; }
  .rail-nav a {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-radius: 11px; text-decoration: none;
    font-size: 14px; font-weight: 560;
    transition: background 180ms var(--ease);
  }
  .rail-nav a:hover { background: var(--surface-2); }
  .rail-nav em {
    font-style: normal; font-family: var(--mono); font-size: 12px;
    color: var(--muted); font-variant-numeric: tabular-nums;
  }

  .rail-endpoint {
    display: flex; flex-direction: column; gap: 10px;
    padding: 16px; border: 1px solid var(--border); border-radius: 16px;
    background: var(--bg);
  }
  .endpoint-code {
    font-size: 11.5px; line-height: 1.55; color: var(--ink);
    overflow-wrap: anywhere; word-break: break-all;
  }
  .rail-endpoint .hint { font-size: 11px; color: var(--muted); line-height: 1.5; }
  .rail-endpoint .hint code { font-size: 10.5px; overflow-wrap: anywhere; }

  .rail-foot { display: flex; flex-direction: column; gap: 12px; }
  .live-tag {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; font-weight: 560; color: var(--muted);
  }
  .live-tag .pulse {
    width: 8px; height: 8px; border-radius: 50%; background: var(--ink);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ink) 40%, transparent);
    animation: pulse 2.4s var(--ease) infinite;
  }
  .live-tag.down .pulse { background: var(--muted); animation: none; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ink) 34%, transparent); }
    70% { box-shadow: 0 0 0 7px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }

  /* ---- Buttons ---- */
  .button, .text-button, .icon-button {
    border: 0; cursor: pointer; text-decoration: none;
    transition: transform 200ms var(--ease), background 200ms var(--ease), opacity 200ms var(--ease), border-color 200ms var(--ease);
  }
  .button {
    min-height: 42px; display: inline-flex; align-items: center; justify-content: center;
    padding: 0 18px; border-radius: 999px; font-weight: 620; font-size: 13.5px;
    letter-spacing: -0.01em;
  }
  .button.block { width: 100%; }
  .button:hover { transform: translateY(-1px); }
  .button:active { transform: scale(0.985); }
  .primary { background: var(--ink); color: var(--surface); }
  .secondary { background: var(--surface); color: var(--ink); border: 1px solid var(--border); }
  .secondary:hover { border-color: var(--border-strong); }
  .ghost { background: transparent; color: var(--muted); }
  .ghost:hover { background: var(--surface-2); color: var(--ink); }
  .text-button {
    background: transparent; color: var(--ink);
    padding: 7px 11px; border-radius: 9px; font-weight: 560; font-size: 13.5px;
  }
  .text-button:hover { background: var(--surface-2); }
  .icon-button {
    width: 34px; height: 34px; border-radius: 10px; background: transparent;
    color: var(--muted); font-size: 13px; display: grid; place-items: center;
  }
  .icon-button:hover { background: var(--surface-2); color: var(--ink); }
  :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 4px; }

  /* ---- Main ---- */
  .main {
    padding: 34px clamp(22px, 3.4vw, 56px) 44px;
    width: min(1240px, 100%);
  }
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
  .page-head .eyebrow { margin-bottom: 8px; }
  .head-actions { display: flex; align-items: center; gap: 14px; }

  .notice, .security-warning {
    margin-top: 22px; border: 1px solid var(--border); border-radius: 14px;
    padding: 13px 16px; background: var(--surface); font-size: 14px;
  }
  .notice.error, .security-warning { border-style: dashed; }
  .notice.success { font-weight: 560; }
  .security-warning code { font-size: 12.5px; }

  .critical-card {
    margin-top: 22px; padding: 26px; border: 1px dashed var(--border-strong);
    border-radius: 20px; background: var(--surface);
  }
  .critical-card h2 { margin: 12px 0; }
  .critical-card p + p { margin-top: 8px; }

  /* ---- Hero ---- */
  .hero {
    margin-top: 30px;
    display: grid; grid-template-columns: 1.15fr 1fr; gap: 20px;
    padding: 32px; border: 1px solid var(--border); border-radius: 26px;
    background:
      radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--ink) 4%, transparent), transparent 55%),
      var(--surface);
    box-shadow: var(--shadow-sm);
  }
  .hero-primary { display: flex; flex-direction: column; gap: 14px; }
  .hero-figure { display: flex; align-items: baseline; gap: 12px; }
  .big-number { font-size: clamp(64px, 9vw, 108px); font-weight: 620; }
  .hero-sub { font-size: 14px; }
  .hero-stats {
    display: grid; grid-template-rows: 1fr 1fr; gap: 14px;
    padding-left: 24px; border-left: 1px solid var(--border);
  }
  .stat { display: flex; flex-direction: column; gap: 6px; }
  .stat .eyebrow { margin-bottom: 2px; }
  .stat-number { font-size: 40px; font-weight: 600; }
  .stat-word { font-size: 34px; letter-spacing: -0.03em; font-weight: 600; }
  .stat span { font-size: 13px; }

  /* ---- Offer cards ---- */
  .offer-grid {
    margin-top: 16px; display: grid; gap: 12px;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .offer-card {
    display: flex; flex-direction: column; justify-content: space-between; gap: 14px;
    min-height: 132px; padding: 18px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 18px;
    transition: transform 240ms var(--ease), border-color 240ms var(--ease);
  }
  .offer-card:hover { transform: translateY(-3px); border-color: var(--border-strong); }
  .offer-card.paused { opacity: 0.62; }
  .offer-card-top { display: flex; align-items: center; justify-content: space-between; }
  .offer-id { font-family: var(--mono); font-size: 13px; font-weight: 620; letter-spacing: -0.02em; }
  .offer-count { font-size: 40px; font-weight: 600; }
  .offer-foot { font-size: 11.5px; }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--border-strong); box-shadow: 0 0 0 4px var(--surface-2);
  }
  .dot.active { background: var(--ink); }

  .empty-state {
    margin-top: 16px; padding: 30px; border: 1px dashed var(--border-strong);
    border-radius: 20px; background: var(--surface);
    display: flex; flex-direction: column; gap: 6px; color: var(--muted);
  }
  .empty-state strong { color: var(--ink); }

  /* ---- Sections & tables ---- */
  .section-block { margin-top: 52px; scroll-margin-top: 24px; }
  .section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
  .section-heading .eyebrow { margin-bottom: 7px; }

  .table-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; box-shadow: var(--shadow-sm); overflow: hidden;
  }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 820px; }
  thead th {
    position: sticky; top: 0;
    color: var(--muted); font-size: 11px; letter-spacing: 0.09em; text-transform: uppercase;
    font-weight: 640; text-align: left;
    padding: 14px 18px; background: var(--surface-2);
    border-bottom: 1px solid var(--border);
  }
  td { padding: 15px 18px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: middle; }
  tbody tr { transition: background 180ms var(--ease); }
  tbody tr:hover { background: var(--surface-2); }
  tbody tr:last-child td { border-bottom: 0; }
  td .mono { font-size: 13px; }
  .align-right { text-align: right; }
  .row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
  .text-button.danger { color: #c33b32; }
  .text-button.danger:hover { background: color-mix(in srgb, #c33b32 9%, transparent); }
  .state-label { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 580; }
  .state-label::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .state-label.on::before { background: var(--ink); }
  .table-empty { padding: 42px; text-align: center; color: var(--muted); }
  .nowrap { white-space: nowrap; }

  .log-card table { min-width: 940px; }
  .log-card td:last-child { width: 100%; }
  .raw-query {
    display: block; max-width: 640px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; color: var(--muted); font-size: 12px;
  }
  .status {
    display: inline-flex; min-width: 74px; justify-content: center;
    padding: 5px 10px; border: 1px solid var(--border); border-radius: 999px;
    font-size: 11px; font-weight: 620; text-transform: capitalize;
  }
  .status-sent { background: var(--ink); color: var(--surface); border-color: var(--ink); }
  .status-failed { border-style: dashed; }
  .status-duplicate { opacity: 0.5; }
  .log-row { animation: fadeRise 440ms var(--ease) both; }

  /* ---- Test event ---- */
  .test-card { display: grid; grid-template-columns: minmax(240px, .72fr) minmax(420px, 1.28fr); gap: 36px; padding: 28px; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow-sm); }
  .test-copy { display: flex; gap: 16px; align-items: flex-start; }
  .test-copy h3 { margin-bottom: 10px; }
  .test-copy p { max-width: 430px; font-size: 14px; line-height: 1.65; }
  .test-index { flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--border-strong); border-radius: 50%; color: var(--muted); font: 11px var(--mono); }
  .test-form { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
  .test-form label { display: flex; flex-direction: column; gap: 7px; }
  .test-form label span { font-size: 12px; font-weight: 620; color: var(--muted); }
  .test-form label em { font-weight: 450; font-style: normal; }
  .test-submit { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding-top: 4px; }
  .test-submit .hint { max-width: 410px; margin: 0; }

  footer {
    margin-top: 52px; padding-top: 22px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; gap: 16px;
    color: var(--muted); font-size: 12px;
  }

  /* ---- Dialogs (top layer) ---- */
  dialog.dialog {
    margin: auto; padding: 0; border: 0; background: transparent;
    max-width: min(560px, calc(100vw - 32px)); width: 100%;
  }
  dialog.dialog::backdrop {
    background: color-mix(in srgb, #000 42%, transparent);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  dialog.dialog[open] { animation: dialogIn 260ms var(--ease); }
  dialog.dialog[open]::backdrop { animation: backdropIn 260ms var(--ease); }
  .dialog-inner {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 22px; padding: 22px; box-shadow: var(--shadow-lg);
  }
  .dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  .dialog-head .eyebrow { margin-bottom: 6px; }

  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
  .form-grid label, .stack-form label { display: flex; flex-direction: column; gap: 7px; }
  .form-grid label span, .stack-form label span { font-size: 12px; font-weight: 620; color: var(--muted); }
  .wide-field { grid-column: 1 / -1; }
  input, select {
    width: 100%; height: 44px; border: 1px solid var(--border); border-radius: 11px;
    background: var(--bg); padding: 0 13px; outline: none;
    transition: border 160ms var(--ease), box-shadow 160ms var(--ease), background 160ms var(--ease);
  }
  input:focus, select:focus {
    border-color: var(--ink); background: var(--surface);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 9%, transparent);
  }
  .form-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }

  /* ---- Auth ---- */
  .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); }
  .auth-card { width: min(440px, 100%); padding: 34px; background: var(--surface); border: 1px solid var(--border); border-radius: 26px; box-shadow: var(--shadow-lg); }
  .auth-card .brand-mark { margin-bottom: 30px; }
  .auth-card h1 { font-size: 36px; margin-top: 4px; }
  .auth-copy { margin-top: 14px; line-height: 1.6; font-size: 14px; }
  .stack-form { display: grid; gap: 16px; margin-top: 26px; }

  /* ---- Motion ---- */
  .rise { animation: fadeRise 560ms var(--ease) both; }
  @keyframes fadeRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes dialogIn { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }
  @keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }

  /* ---- Responsive ---- */
  @media (max-width: 1180px) {
    .offer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 900px) {
    .app { grid-template-columns: 1fr; }
    .rail {
      position: static; height: auto; flex-direction: column;
      border-right: 0; border-bottom: 1px solid var(--border);
    }
    .rail-nav { flex-direction: row; flex-wrap: wrap; }
    .rail-nav a { flex: 1; min-width: 140px; }
    .hero { grid-template-columns: 1fr; }
    .test-card { grid-template-columns: 1fr; }
    .hero-stats { grid-template-rows: none; grid-template-columns: 1fr 1fr; padding-left: 0; padding-top: 20px; border-left: 0; border-top: 1px solid var(--border); }
  }
  @media (max-width: 620px) {
    .main { padding: 24px 16px 32px; }
    .page-head, .section-heading, footer { flex-direction: column; align-items: flex-start; gap: 12px; }
    .offer-grid { grid-template-columns: 1fr; }
    .hero-stats { grid-template-columns: 1fr; }
    .form-grid { grid-template-columns: 1fr; }
    .test-form { grid-template-columns: 1fr; }
    .test-submit { align-items: stretch; flex-direction: column; }
    .wide-field { grid-column: auto; }
    .quiet-label { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; scroll-behavior: auto !important; }
  }
`;