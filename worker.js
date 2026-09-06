const VERIFY_TOKEN = "verkehrsapi1-verify-test1";
const GRAPH_VERSION = "v23.0";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ===== WhatsApp Webhook =====
    if (url.pathname === "/webhook") {

      // Webhook-Verifizierung durch Meta
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
          return new Response(challenge || "", { status: 200 });
        }

        return new Response("Forbidden", { status: 403 });
      }

      // Eingehende WhatsApp-Nachricht
      if (request.method === "POST") {
        const body = await request.json();

        // Sofort im Hintergrund verarbeiten
        ctx.waitUntil(handleWhatsApp(body, env));

        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // ===== Direkter Browser-Test =====
    const autobahn = (
      url.searchParams.get("autobahn") || "A3"
    ).toUpperCase().replace(/\s/g, "");

    const text = await getTrafficText(autobahn);

    return new Response(text, {
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }
};


async function handleWhatsApp(body, env) {
  try {
    const value =
      body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    // Status-Updates etc. ignorieren
    if (!message) return;

    const from = message.from;
    const text =
      message.text?.body?.trim() || "";

    if (!from) return;

    // Sucht z.B. A3, A46, A57
    const match = text.toUpperCase().match(/\bA\s?(\d{1,3})\b/);

    if (!match) {
      await sendWhatsApp(
        from,
        "Schreib mir eine Autobahn, z. B. A3, A46 oder A57.",
        env
      );
      return;
    }

    const autobahn = `A${match[1]}`;

    const antwort = await getTrafficText(autobahn);

    await sendWhatsApp(from, antwort, env);

  } catch (error) {
    console.error("Webhook error:", error);
  }
}


async function getTrafficText(autobahn) {
  if (!/^A\d{1,3}$/.test(autobahn)) {
    return "Ungültige Autobahn. Beispiel: A46";
  }

  const categories = [
    ["Warnungen", "warning"],
    ["Baustellen", "roadworks"],
    ["Sperrungen", "closure"]
  ];

  let output = `🚗 Verkehr ${autobahn}\n\n`;
  let total = 0;

  for (const [label, endpoint] of categories) {
    try {
      const apiUrl =
        `https://verkehr.autobahn.de/o/autobahn/${autobahn}/services/${endpoint}`;

      const response = await fetch(apiUrl);

      if (!response.ok) {
        output += `${label}: momentan nicht abrufbar\n\n`;
        continue;
      }

      const data = await response.json();

      const reports =
        Array.isArray(data[endpoint])
          ? data[endpoint]
          : [];

      total += reports.length;

      output += `${label}: ${reports.length}\n`;

      // Maximal 3 Meldungen je Kategorie
      for (const report of reports.slice(0, 3)) {
        const title =
          report.title ||
          report.subtitle ||
          "Verkehrsmeldung";

        output += `• ${title}\n`;
      }

      if (reports.length > 3) {
        output += `• +${reports.length - 3} weitere\n`;
      }

      output += "\n";

    } catch (error) {
      output += `${label}: Fehler beim Abrufen\n\n`;
    }
  }

  if (total === 0) {
    output += "Keine aktuellen Meldungen gefunden.";
  } else {
    output += `Insgesamt: ${total} Meldungen`;
  }

  return output;
}


async function sendWhatsApp(to, text, env) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",

      headers: {
        "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body: text
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("WhatsApp send error:", error);
  }
}
