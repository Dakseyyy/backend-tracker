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
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function isMissingOptionalColumn(error) {
  const message = String(error?.message || "");
  return (
    error?.code === "42703" ||
    error?.code === "PGRST204" ||
    /column.*does not exist|schema cache/i.test(message)
  );
}

async function insertReceivedEvent(supabase, event) {
  const fullRow = {
    raw_query: event.rawQuery,
    offer_id: event.offerId || null,
    transaction_id: event.transactionId || null,
    status: "received",
  };

  let result = await supabase
    .from("events")
    .insert(fullRow)
    .select("id")
    .single();

  if (result.error?.code === "23505" && event.transactionId) {
    const duplicateResult = await supabase
      .from("events")
      .insert({
        raw_query: event.rawQuery,
        offer_id: event.offerId || null,
        transaction_id: null,
        status: "duplicate",
      })
      .select("id")
      .single();

    if (duplicateResult.error) {
      console.error("Failed to log duplicate postback:", duplicateResult.error.message);
    }

    return { duplicate: true, id: duplicateResult.data?.id || null, legacy: false };
  }

  if (result.error && isMissingOptionalColumn(result.error)) {
    result = await supabase
      .from("events")
      .insert({ raw_query: event.rawQuery })
      .select("id")
      .single();

    if (result.error) {
      console.error("Failed to log postback:", result.error.message);
      return { duplicate: false, id: null, legacy: true };
    }

    return { duplicate: false, id: result.data?.id || null, legacy: true };
  }

  if (result.error) {
    console.error("Failed to log postback:", result.error.message);
    return { duplicate: false, id: null, legacy: false };
  }

  return { duplicate: false, id: result.data?.id || null, legacy: false };
}

async function setEventStatus(supabase, eventRecord, status) {
  if (!eventRecord.id || eventRecord.legacy) return;

  const { error } = await supabase
    .from("events")
    .update({ status })
    .eq("id", eventRecord.id);

  if (error) {
    console.error(`Failed to set event status to ${status}:`, error.message);
  }
}

async function processPostback({ rawQuery, offerId, fbclid, transactionId, arrivalMs }) {
  let supabase;

  try {
    supabase = getSupabaseAdmin();
  } catch (error) {
    console.error(error.message);
    return { status: "failed", stage: "setup", error: error.message };
  }

  const eventRecord = await insertReceivedEvent(supabase, {
    rawQuery,
    offerId,
    transactionId,
  });

  if (eventRecord.duplicate) {
    return { status: "duplicate", stage: "deduplication" };
  }

  if (!offerId) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error("Postback missing offer_id.");
    return { status: "failed", stage: "validation", error: "Missing offer_id." };
  }

  const { data: config, error: configError } = await supabase
    .from("configs")
    .select("pixel_id,pixel_access_token,payout,active")
    .eq("offer_id", offerId)
    .maybeSingle();

  if (configError || !config || !config.active) {
    await setEventStatus(supabase, eventRecord, "failed");
    const message = configError?.message || `No active config found for offer_id ${offerId}.`;
    console.error(message);
    return { status: "failed", stage: "routing", error: message };
  }

  if (!fbclid) {
    await setEventStatus(supabase, eventRecord, "failed");
    const message = `Postback for offer_id ${offerId} is missing source/fbclid.`;
    console.error(message);
    return { status: "failed", stage: "validation", error: message };
  }

  const graphVersion = process.env.META_GRAPH_API_VERSION || "v24.0";
  const currency = process.env.META_CURRENCY || "USD";
  const fbc = `fb.1.${arrivalMs}.${fbclid}`;

  const metaEvent = {
    event_name: "Purchase",
    event_time: Math.floor(arrivalMs / 1000),
    action_source: "website",
    user_data: { fbc },
    custom_data: {
      currency,
      value: Number(config.payout || 0),
    },
  };

  if (transactionId) {
    metaEvent.event_id = transactionId;
  }

  const endpoint = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(config.pixel_id)}/events`,
  );
  endpoint.searchParams.set("access_token", config.pixel_access_token);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [metaEvent] }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });

    const body = await response.json().catch(async () => ({
      raw: (await response.text().catch(() => "")).slice(0, 1500),
    }));
    const eventsReceived = Number(body?.events_received || 0);

    if (!response.ok || eventsReceived < 1) {
      await setEventStatus(supabase, eventRecord, "failed");
      console.error(`Meta CAPI rejected event (HTTP ${response.status}):`, JSON.stringify(body).slice(0, 1500));
      return {
        status: "failed",
        stage: "meta",
        meta_http_status: response.status,
        meta_response: body,
      };
    }

    await setEventStatus(supabase, eventRecord, "sent");
    console.info(`Meta accepted ${eventsReceived} event(s). Trace: ${body.fbtrace_id || "none"}`);
    return {
      status: "sent",
      stage: "meta",
      routed_offer_id: offerId,
      routed_pixel_id: config.pixel_id,
      meta_http_status: response.status,
      meta_response: body,
    };
  } catch (error) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error("Meta CAPI request failed:", error.message);
    return { status: "failed", stage: "meta_request", error: error.message };
  }
}

export async function GET(request) {
  const arrivalMs = Date.now();
  const questionMarkIndex = request.url.indexOf("?");
  const rawQuery = questionMarkIndex === -1 ? "" : request.url.slice(questionMarkIndex + 1);
  const url = new URL(request.url);

  const offerId = url.searchParams.get("offer_id")?.trim() || "";
  const fbclid = url.searchParams.get("source")?.trim() || "";
  const transactionId = url.searchParams.get("transaction_id")?.trim() || "";
  const debug = url.searchParams.get("debug") === "1";
  const event = { rawQuery, offerId, fbclid, transactionId, arrivalMs };

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
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
