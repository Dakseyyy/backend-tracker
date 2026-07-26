import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase server environment variables.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Insert a row for this postback and return its id (best-effort; never blocks forwarding).
async function logEvent(supabase, row) {
  const { data, error } = await supabase
    .from("events")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    console.error("Failed to log event:", error.message);
    return null;
  }
  return data?.id || null;
}

async function updateEvent(supabase, id, patch) {
  if (!id) return;
  const { error } = await supabase.from("events").update(patch).eq("id", id);
  if (error) console.error("Failed to update event:", error.message);
}

async function processPostback({ rawQuery, pixelId, fbclid, postbackPayout, arrivalMs }) {
  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error(error.message);
    return { status: "failed", stage: "setup", error: error.message };
  }

  // Always log the raw hit first.
  const eventId = await logEvent(supabase, {
    raw_query: rawQuery,
    pixel_id: pixelId || null,
    status: "received",
  });

  // Route by pixel_id.
  if (!pixelId) {
    const message = "No pixel_id in postback URL.";
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: { stage: "routing", error: message },
    });
    return { status: "failed", stage: "routing", error: message };
  }

  const { data: config, error: configError } = await supabase
    .from("configs")
    .select("pixel_id,pixel_access_token,payout,active")
    .eq("pixel_id", pixelId)
    .maybeSingle();

  if (configError || !config) {
    const message = configError?.message || `No config found for pixel_id ${pixelId}.`;
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: { stage: "routing", error: message },
    });
    console.error(message);
    return { status: "failed", stage: "routing", error: message };
  }

  if (!config.active) {
    const message = `Config for pixel_id ${pixelId} is paused.`;
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: { stage: "routing", error: message },
    });
    return { status: "failed", stage: "routing", error: message };
  }

  if (!fbclid) {
    const message = "Postback is missing source/fbclid.";
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: { stage: "validation", error: message },
    });
    console.error(message);
    return { status: "failed", stage: "validation", error: message };
  }

  // Payout: use the postback value if it's a valid number, else fall back to config payout.
  const parsedPostbackPayout = Number(postbackPayout);
  const payoutIsValid =
    postbackPayout !== "" && Number.isFinite(parsedPostbackPayout) && parsedPostbackPayout >= 0;
  const value = payoutIsValid ? parsedPostbackPayout : Number(config.payout || 0);
  const payoutSource = payoutIsValid ? "postback" : "config";

  // Build and send the Meta event.
  const graphVersion = process.env.META_GRAPH_API_VERSION || "v24.0";
  const currency = process.env.META_CURRENCY || "USD";
  const fbc = `fb.1.${arrivalMs}.${fbclid}`;

  const payload = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(arrivalMs / 1000),
        action_source: "website",
        user_data: { fbc },
        custom_data: { currency, value },
      },
    ],
  };

  const endpoint = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(config.pixel_id)}/events`,
  );
  endpoint.searchParams.set("access_token", config.pixel_access_token);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    const responseText = await response.text();
    let body;
    try { body = JSON.parse(responseText); }
    catch { body = { raw: responseText.slice(0, 1500) }; }

    const eventsReceived = Number(body?.events_received || 0);
    const ok = response.ok && eventsReceived >= 1;

    await updateEvent(supabase, eventId, {
      status: ok ? "sent" : "failed",
      meta_http_status: response.status,
      meta_events_received: eventsReceived,
      meta_trace_id: body?.fbtrace_id || null,
      meta_response: body,
      forwarded_value: value,
      payout_source: payoutSource,
    });

    return {
      status: ok ? "sent" : "failed",
      stage: "meta",
      forwarded_value: value,
      payout_source: payoutSource,
      meta_http_status: response.status,
      meta_response: body,
    };
  } catch (error) {
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: { stage: "meta_request", error: error.message },
    });
    console.error("Meta CAPI request failed:", error.message);
    return { status: "failed", stage: "meta_request", error: error.message };
  }
}

export async function GET(request) {
  const arrivalMs = Date.now();
  const questionMarkIndex = request.url.indexOf("?");
  const rawQuery = questionMarkIndex === -1 ? "" : request.url.slice(questionMarkIndex + 1);
  const url = new URL(request.url);

  const pixelId = url.searchParams.get("pixel_id")?.trim() || "";
  const fbclid = url.searchParams.get("source")?.trim() || "";
  const postbackPayout = url.searchParams.get("payout")?.trim() || "";
  const debug = url.searchParams.get("debug") === "1";
  const event = { rawQuery, pixelId, fbclid, postbackPayout, arrivalMs };

  if (debug) {
    const result = await processPostback(event);
    return Response.json(result, {
      status: result?.status === "sent" ? 200 : 422,
      headers: { "Cache-Control": "no-store" },
    });
  }

  after(() => processPostback(event));
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}