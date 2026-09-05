const VERIFY_TOKEN = "verkehrsapi1-verify-test1";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ===== META / WHATSAPP WEBHOOK =====
    if (url.pathname === "/webhook") {

      // Meta überprüft den Webhook per GET
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
          return new Response(challenge, {
            status: 200,
            headers: {
              "content-type": "text/plain"
            }
          });
        }

        return new Response("Verifizierung fehlgeschlagen", {
          status: 403
        });
      }

      // Eingehende WhatsApp-Nachrichten kommen später per POST
      if (request.method === "POST") {
        return new Response("EVENT_RECEIVED", {
          status: 200
        });
      }

      return new Response("Method not allowed", {
        status: 405
      });
    }

    // ===== VERKEHRS-API =====

    const autobahn = (url.searchParams.get("autobahn") || "A3")
      .toUpperCase()
      .replace(/\s/g, "");

    if (!/^A\d{1,3}$/.test(autobahn)) {
      return Response.json({
        fehler: "Ungültige Autobahn",
        beispiele: [
          "?autobahn=A3",
          "?autobahn=A46"
        ]
      }, { status: 400 });
    }

    const kategorien = {
      warnungen: "warning",
      baustellen: "roadworks",
      sperrungen: "closure"
    };

    try {
      const ergebnisse = {};

      await Promise.all(
        Object.entries(kategorien).map(async ([name, endpoint]) => {

          const apiUrl =
            `https://verkehr.autobahn.de/o/autobahn/${autobahn}/services/${endpoint}`;

          const response = await fetch(apiUrl);

          if (!response.ok) {
            ergebnisse[name] = {
              fehler: `HTTP ${response.status}`,
              meldungen: []
            };
            return;
          }

          const data = await response.json();

          const meldungen =
            Array.isArray(data[endpoint])
              ? data[endpoint]
              : [];

          ergebnisse[name] = {
            anzahl: meldungen.length,

            meldungen: meldungen.map(m => ({
              titel: m.title ?? null,
              untertitel: m.subtitle ?? null,
              beschreibung: m.description?.[0] ?? null,
              koordinaten: m.coordinate ?? null,
              start: m.startTimestamp ?? null
            }))
          };
        })
      );

      const gesamt = Object.values(ergebnisse)
        .reduce(
          (sum, k) => sum + (k.anzahl || 0),
          0
        );

      return Response.json({
        autobahn,
        gesamt,
        ...ergebnisse
      });

    } catch (error) {

      return Response.json({
        fehler: "Verkehrsdaten konnten nicht geladen werden",
        details: error.message
      }, {
        status: 502
      });
    }
  }
};
