import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const GRAPH_VERSION = "v24.0";
const CURRENCY = "USD";
const EVENT_NAME = "Lead";
const EVENT_SOURCE_URL = "https://sheinrewards.world/";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Missing Supabase server environment variables.");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Insert a row for this postback and return its ID.
// Logging failures never prevent Meta forwarding.
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

  const { error } = await supabase
    .from("events")
    .update(patch)
    .eq("id", id);

  if (error) {
    console.error("Failed to update event:", error.message);
  }
}

/**
 * Some affiliate networks may URL-encode a value more than once.
 * This safely decodes it up to three times.
 */
function decodeValue(input) {
  let value = String(input || "").trim();

  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(value);

      if (decoded === value) break;

      value = decoded;
    } catch {
      break;
    }
  }

  return value.trim();
}

/**
 * Accepts either:
 *
 * 1. A raw fbclid:
 *    PAcGRvZgJmZGlk...
 *
 * 2. An existing fbc:
 *    fb.1.1753612345678.PAcGRvZgJmZGlk...
 *
 * It returns a complete fbc value for Meta.
 */
function buildFbc(source, arrivalMs) {
  let value = decodeValue(source);

  if (!value) {
    return {
      fbc: "",
      rawFbclid: "",
      generated: false,
    };
  }

  // Remove accidental parameter names.
  value = value
    .replace(/^fbclid=/i, "")
    .replace(/^source=/i, "")
    .trim();

  // Do not wrap an already-complete fbc again.
  if (/^fb\.1\.\d+\..+/i.test(value)) {
    const parts = value.split(".");

    return {
      fbc: value,
      rawFbclid: parts.slice(3).join("."),
      generated: false,
    };
  }

  // Reject obviously broken values.
  if (
    value.length < 20 ||
    value.length > 2000 ||
    /\s/.test(value) ||
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return {
      fbc: "",
      rawFbclid: value,
      generated: false,
    };
  }

  return {
    fbc: `fb.1.${arrivalMs}.${value}`,
    rawFbclid: value,
    generated: true,
  };
}

async function processPostback({
  rawQuery,
  pixelId,
  source,
  postbackPayout,
  arrivalMs,
}) {
  let supabase;

  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error(error.message);

    return {
      status: "failed",
      stage: "setup",
      error: error.message,
    };
  }

  // Always log the raw postback first.
  const eventId = await logEvent(supabase, {
    raw_query: rawQuery,
    pixel_id: pixelId || null,
    status: "received",
  });

  // Pixel ID must be supplied in the postback URL.
  if (!pixelId) {
    const message = "No pixel_id in postback URL.";

    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "routing",
        error: message,
      },
    });

    return {
      status: "failed",
      stage: "routing",
      error: message,
    };
  }

  /*
   * Keep your existing routing:
   *
   * postback pixel_id
   *      ↓
   * matching Supabase config
   *      ↓
   * config.pixel_id and config.pixel_access_token
   */
  const { data: config, error: configError } = await supabase
    .from("configs")
    .select("pixel_id,pixel_access_token,payout,active")
    .eq("pixel_id", pixelId)
    .maybeSingle();

  if (configError || !config) {
    const message =
      configError?.message ||
      `No config found for pixel_id ${pixelId}.`;

    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "routing",
        error: message,
      },
    });

    console.error(message);

    return {
      status: "failed",
      stage: "routing",
      error: message,
    };
  }

  if (!config.active) {
    const message = `Config for pixel_id ${pixelId} is paused.`;

    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "routing",
        error: message,
      },
    });

    return {
      status: "failed",
      stage: "routing",
      error: message,
    };
  }

  if (!config.pixel_access_token) {
    const message =
      `Config for pixel_id ${pixelId} has no access token.`;

    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "routing",
        error: message,
      },
    });

    return {
      status: "failed",
      stage: "routing",
      error: message,
    };
  }

  /*
   * source must contain the genuine original fbclid from the
   * visitor's Meta landing-page URL.
   */
  const { fbc, rawFbclid, generated } = buildFbc(
    source,
    arrivalMs,
  );

  if (!fbc) {
    const message =
      "Postback source is missing or is not a usable fbclid/fbc.";

    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "validation",
        error: message,
        received_source: source || null,
      },
    });

    console.error(message);

    return {
      status: "failed",
      stage: "validation",
      error: message,
    };
  }

  /*
   * Use payout from the postback when valid.
   * Otherwise, fall back to the configured payout.
   */
  const parsedPostbackPayout = Number(postbackPayout);

  const payoutIsValid =
    postbackPayout !== "" &&
    Number.isFinite(parsedPostbackPayout) &&
    parsedPostbackPayout >= 0;

  const configuredPayout = Number(config.payout || 0);

  const value = payoutIsValid
    ? parsedPostbackPayout
    : Number.isFinite(configuredPayout)
      ? configuredPayout
      : 0;

  const payoutSource = payoutIsValid
    ? "postback"
    : "config";

  /*
   * Minimal genuine Meta CAPI payload.
   *
   * We deliberately do not send:
   * - Fake email addresses
   * - Fake phone numbers
   * - Affiliate server IP addresses
   * - Affiliate server user agents
   * - Made-up fbp cookies
   */
  const payload = {
    data: [
      {
        event_name: EVENT_NAME,
        event_time: Math.floor(arrivalMs / 1000),
        action_source: "website",
        event_source_url: EVENT_SOURCE_URL,

        user_data: {
          fbc,
        },

        custom_data: {
          currency: CURRENCY,
          value,
        },
      },
    ],
  };

  const endpoint = new URL(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
      config.pixel_id,
    )}/events`,
  );

  endpoint.searchParams.set(
    "access_token",
    config.pixel_access_token,
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    const responseText = await response.text();

    let body;

    try {
      body = JSON.parse(responseText);
    } catch {
      body = {
        raw: responseText.slice(0, 1500),
      };
    }

    const eventsReceived = Number(
      body?.events_received || 0,
    );

    const ok =
      response.ok &&
      eventsReceived >= 1;

    /*
     * Store useful diagnostics without storing the full fbclid
     * separately again.
     */
    const loggedMetaResponse = {
      ...body,

      sent_event: {
        event_name: EVENT_NAME,
        event_time: Math.floor(arrivalMs / 1000),
        action_source: "website",
        event_source_url: EVENT_SOURCE_URL,
        has_fbc: true,
        fbc_generated_from_raw_fbclid: generated,
        raw_fbclid_length: rawFbclid.length,
      },
    };

    await updateEvent(supabase, eventId, {
      status: ok ? "sent" : "failed",
      meta_http_status: response.status,
      meta_events_received: eventsReceived,
      meta_trace_id: body?.fbtrace_id || null,
      meta_response: loggedMetaResponse,
      forwarded_value: value,
      payout_source: payoutSource,
    });

    return {
      status: ok ? "sent" : "failed",
      stage: "meta",
      event_name: EVENT_NAME,
      forwarded_value: value,
      payout_source: payoutSource,
      fbc_generated_from_raw_fbclid: generated,
      raw_fbclid_length: rawFbclid.length,
      meta_http_status: response.status,
      meta_response: body,
    };
  } catch (error) {
    await updateEvent(supabase, eventId, {
      status: "failed",
      meta_response: {
        stage: "meta_request",
        error: error.message,
      },
    });

    console.error(
      "Meta CAPI request failed:",
      error.message,
    );

    return {
      status: "failed",
      stage: "meta_request",
      error: error.message,
    };
  }
}

export async function GET(request) {
  const arrivalMs = Date.now();

  const questionMarkIndex = request.url.indexOf("?");

  const rawQuery =
    questionMarkIndex === -1
      ? ""
      : request.url.slice(questionMarkIndex + 1);

  const url = new URL(request.url);

  const pixelId =
    url.searchParams.get("pixel_id")?.trim() || "";

  /*
   * source is still your main parameter.
   *
   * fbclid and fbc are accepted as fallbacks so the endpoint
   * remains flexible.
   */
  const source =
    url.searchParams.get("source")?.trim() ||
    url.searchParams.get("fbclid")?.trim() ||
    url.searchParams.get("fbc")?.trim() ||
    "";

  const postbackPayout =
    url.searchParams.get("payout")?.trim() || "";

  const debug =
    url.searchParams.get("debug") === "1";

  const event = {
    rawQuery,
    pixelId,
    source,
    postbackPayout,
    arrivalMs,
  };

  if (debug) {
    const result = await processPostback(event);

    return Response.json(result, {
      status:
        result?.status === "sent"
          ? 200
          : 422,

      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  /*
   * Immediately return OK to the affiliate network, then complete
   * the Supabase and Meta requests using Next.js after().
   */
  after(() => processPostback(event));

  return new Response("OK", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}