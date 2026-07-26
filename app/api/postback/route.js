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
    return;
  }

  const eventRecord = await insertReceivedEvent(supabase, {
    rawQuery,
    offerId,
    transactionId,
  });

  if (eventRecord.duplicate) return;

  if (!offerId) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error("Postback missing offer_id.");
    return;
  }

  const { data: config, error: configError } = await supabase
    .from("configs")
    .select("pixel_id,pixel_access_token,payout,active")
    .eq("offer_id", offerId)
    .maybeSingle();

  if (configError || !config || !config.active) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error(
      configError?.message || `No active config found for offer_id ${offerId}.`,
    );
    return;
  }

  if (!fbclid) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error(`Postback for offer_id ${offerId} is missing source/fbclid.`);
    return;
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

    if (!response.ok) {
      const body = await response.text();
      await setEventStatus(supabase, eventRecord, "failed");
      console.error(`Meta CAPI error ${response.status}:`, body.slice(0, 1500));
      return;
    }

    await setEventStatus(supabase, eventRecord, "sent");
  } catch (error) {
    await setEventStatus(supabase, eventRecord, "failed");
    console.error("Meta CAPI request failed:", error.message);
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

  after(() =>
    processPostback({
      rawQuery,
      offerId,
      fbclid,
      transactionId,
      arrivalMs,
    }),
  );

  return new Response("OK", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
