const VERIFY_TOKEN = "verkehrsapi1-verify-test1";
const GRAPH_VERSION = "v26.0";

const NRW_AUTOBAHNEN = [
  "A1", "A2", "A3", "A4",
  "A30", "A31", "A33",
  "A40", "A42", "A43", "A44", "A45", "A46",
  "A52", "A57", "A59", "A61",
  "A445", "A448",
  "A516", "A524", "A535", "A542", "A544",
  "A553", "A555", "A559", "A560", "A562", "A565"
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================
    // WhatsApp Webhook
    // =========================

    if (url.pathname === "/webhook") {

      // Meta-Verifizierung
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
          return new Response(challenge || "", { status: 200 });
        }

        return new Response("Forbidden", { status: 403 });
      }

      // WhatsApp-Nachricht
      if (request.method === "POST") {
        const body = await request.json();

        ctx.waitUntil(handleWhatsApp(body, env));

        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    return new Response(
      "VerkehrsAPI1 läuft. Schreib dem WhatsApp-Bot eine Nachricht.",
      { status: 200 }
    );
  }
};


// ==========================================
// WHATSAPP-NACHRICHT VERARBEITEN
// ==========================================

async function handleWhatsApp(body, env) {
  try {
    const value =
      body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;

    if (!from) return;

    const text =
      message.text?.body?.trim() || "";

    if (!text) {
      await sendWhatsApp(
        from,
        "Schreib mir einfach, was du über den Verkehr wissen möchtest.",
        env
      );
      return;
    }

    // Erst einfache Sachen ohne KI
    const simple = simpleParser(text);

    let intent;

    if (simple) {
      intent = simple;
    } else {
      intent = await understandWithAI(text, env);
    }

    await processIntent(from, text, intent, env);

  } catch (error) {
    console.error("Webhook error:", error);
  }
}


// ==========================================
// EINFACHER PARSER
// ==========================================

function simpleParser(text) {
  const t = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (
    t === "hilfe" ||
    t === "help" ||
    t === "was kann ich fragen" ||
    t === "was kannst du"
  ) {
    return {
      action: "help"
    };
  }

  if (
    t.includes("alle befehle") ||
    t.includes("befehle auflisten")
  ) {
    return {
      action: "commands"
    };
  }

  if (
    t.includes("alle autobahnen") ||
    t.includes("welche autobahnen")
  ) {
    return {
      action: "motorways"
    };
  }

  // Nur A46, A3 usw.
  const match =
    t.match(/\ba\s*(\d{1,3})\b/i);

  if (
    match &&
    t.replace(/\s/g, "").match(/^a\d{1,3}$/i)
  ) {
    return {
      action: "traffic",
      road: `A${match[1]}`,
      category: "all",
      show_all: false
    };
  }

  return null;
}


// ==========================================
// KI VERSTEHT NATÜRLICHE SPRACHE
// ==========================================

async function understandWithAI(text, env) {

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct-fast",
    {
      messages: [
        {
          role: "system",
          content: `
Du bist der Sprachparser für einen deutschen WhatsApp-Verkehrsbot.

Du sollst NUR verstehen, was der Nutzer möchte.
Du erfindest NIEMALS Verkehrsdaten.

Verstehe:
- normales Deutsch
- Umgangssprache
- Tippfehler
- kurze Nachrichten
- lange Formulierungen
- Sätze wie "kannste mal gucken"
- "such mir raus"
- "mach mir eine liste"
- "was geht auf der a46"
- "zeig nur sperrungen"
- "was kann ich fragen"

Mögliche action-Werte:

traffic
help
commands
motorways
unknown

category:

all
warning
roadworks
closure

road:
z.B. A46 oder A3.
Wenn keine Straße genannt wurde: null.

location:
z.B. Düsseldorf, Köln, Düsseldorf Flughafen.
Wenn kein Ort genannt wurde: null.

show_all:
true, wenn der Nutzer alle Meldungen oder eine vollständige Liste möchte.

list_requested:
true, wenn ausdrücklich eine Liste gewünscht wird.

Wichtig:
Aktuell können echte Daten nur für Autobahnen abgefragt werden.
Orte und andere Straßen trotzdem erkennen und korrekt zurückgeben.
`
        },
        {
          role: "user",
          content: text
        }
      ],

      response_format: {
        type: "json_schema",

        json_schema: {
          name: "traffic_request",

          schema: {
            type: "object",

            properties: {
              action: {
                type: "string",
                enum: [
                  "traffic",
                  "help",
                  "commands",
                  "motorways",
                  "unknown"
                ]
              },

              road: {
                type: ["string", "null"]
              },

              location: {
                type: ["string", "null"]
              },

              category: {
                type: "string",
                enum: [
                  "all",
                  "warning",
                  "roadworks",
                  "closure"
                ]
              },

              show_all: {
                type: "boolean"
              },

              list_requested: {
                type: "boolean"
              }
            },

            required: [
              "action",
              "road",
              "location",
              "category",
              "show_all",
              "list_requested"
            ]
          }
        }
      }
    }
  );

  if (result?.response) {
    try {
      return JSON.parse(result.response);
    } catch (_) {
      console.log("AI JSON konnte nicht gelesen werden");
    }
  }

  return {
    action: "unknown",
    road: null,
    location: null,
    category: "all",
    show_all: false,
    list_requested: false
  };
}


// ==========================================
// INTENT AUSFÜHREN
// ==========================================

async function processIntent(
  from,
  originalText,
  intent,
  env
) {

  // Hilfe
  if (intent.action === "help") {

    await sendWhatsApp(
      from,
`Klar. Du kannst mir ziemlich normal schreiben.

Zum Beispiel:

• Was ist auf der A46 los?
• Such mir alle Baustellen auf der A3 raus.
• Gibt es Sperrungen auf der A40?
• Mach mir eine Liste aller Meldungen auf der A57.
• Welche Autobahnen kannst du abfragen?
• Liste alle Befehle auf.

Du musst die Fragen nicht exakt so schreiben.
Umgangssprache und kleinere Tippfehler sind okay.`,
      env
    );

    return;
  }


  // Alle Möglichkeiten
  if (intent.action === "commands") {

    await sendWhatsApp(
      from,
`Das kannst du mich momentan fragen:

🚗 Verkehr
„A46“
„Was ist auf der A46 los?“
„Wie sieht es auf der A3 aus?“

🚧 Baustellen
„Baustellen A46“
„Such mir Baustellen auf der A40 raus.“

⛔ Sperrungen
„Sperrungen A57“
„Ist auf der A3 etwas gesperrt?“

⚠️ Warnungen
„Warnungen A1“
„Gibt es Gefahrenmeldungen auf der A46?“

📋 Listen
„Alle Meldungen A46“
„Mach mir eine Liste aller Baustellen A3.“

🛣️ Übersicht
„Welche Autobahnen kannst du?“
„Alle Autobahnen“

Du kannst die Sätze auch anders formulieren.`,
      env
    );

    return;
  }


  // Autobahnen
  if (intent.action === "motorways") {

    await sendWhatsApp(
      from,
`Klar, hier sind die Autobahnen, die ich momentan für NRW vorgesehen habe:

${NRW_AUTOBAHNEN.join(", ")}

Du kannst z. B. schreiben:
„Was ist auf der A46 los?“`,
      env
    );

    return;
  }


  // KI erkennt Ort, aber noch keine Straße
  if (
    intent.action === "traffic" &&
    !intent.road &&
    intent.location
  ) {

    await sendWhatsApp(
      from,
`Ich habe „${intent.location}“ als Ort erkannt.

Die Ortssuche wird als Nächstes eingebaut. Im Moment kann ich die echten Verkehrsdaten direkt für Autobahnen abfragen.

Du kannst aber z. B. schreiben:
„Verkehr A44 bei ${intent.location}“`,
      env
    );

    return;
  }


  // Keine verwertbare Anfrage
  if (
    intent.action !== "traffic" ||
    !intent.road
  ) {

    await sendWhatsApp(
      from,
`Ich bin mir noch nicht ganz sicher, was du abfragen möchtest.

Du kannst einfach normal schreiben, zum Beispiel:
„Such mir alle Baustellen auf der A46 raus.“

Oder schreib „Hilfe“.`,
      env
    );

    return;
  }


  const road =
    intent.road
      .toUpperCase()
      .replace(/\s/g, "");


  if (!/^A\d{1,3}$/.test(road)) {

    await sendWhatsApp(
      from,
`Ich habe „${intent.road}“ als Straße erkannt.

Aktuell sind die echten Daten für Autobahnen eingebaut.
Bundesstraßen und Stadtstraßen kommen als nächster Schritt.`,
      env
    );

    return;
  }


  // Freundliche Zwischenmeldung
  let loadingText =
    `Klar, ich schaue mir ${road} gerade an.`;

  if (intent.category === "roadworks") {
    loadingText =
      `Klar, ich suche dir die Baustellen auf der ${road} raus. Einen Moment …`;
  }

  if (intent.category === "closure") {
    loadingText =
      `Klar, ich prüfe gerade die Sperrungen auf der ${road}. Einen Moment …`;
  }

  if (intent.category === "warning") {
    loadingText =
      `Klar, ich prüfe gerade die Warnmeldungen für die ${road}. Einen Moment …`;
  }

  if (intent.show_all || intent.list_requested) {
    loadingText =
      `Klar, ich stelle dir gerade die gewünschte Liste für die ${road} zusammen. Einen Moment …`;
  }


  await sendWhatsApp(
    from,
    loadingText,
    env
  );


  // Verkehr abrufen
  const data =
    await getTraffic(
      road,
      intent.category
    );


  const answer =
    formatTraffic(
      road,
      data,
      intent
    );


  await sendWhatsApp(
    from,
    answer,
    env
  );
}


// ==========================================
// VERKEHRSDATEN
// ==========================================

async function getTraffic(
  road,
  category
) {

  const categories = [];

  if (
    category === "all" ||
    category === "warning"
  ) {
    categories.push([
      "Warnungen",
      "warning"
    ]);
  }

  if (
    category === "all" ||
    category === "roadworks"
  ) {
    categories.push([
      "Baustellen",
      "roadworks"
    ]);
  }

  if (
    category === "all" ||
    category === "closure"
  ) {
    categories.push([
      "Sperrungen",
      "closure"
    ]);
  }


  const result = [];

  for (
    const [label, endpoint]
    of categories
  ) {

    try {

      const response =
        await fetch(
          `https://verkehr.autobahn.de/o/autobahn/${road}/services/${endpoint}`
        );

      if (!response.ok) {
        continue;
      }

      const json =
        await response.json();

      const reports =
        Array.isArray(json[endpoint])
          ? json[endpoint]
          : [];

      result.push({
        label,
        endpoint,
        reports
      });

    } catch (error) {
      console.error(
        "Traffic API:",
        error
      );
    }
  }

  return result;
}


// ==========================================
// SCHÖNE ANTWORT
// ==========================================

function formatTraffic(
  road,
  groups,
  intent
) {

  let total = 0;

  for (const group of groups) {
    total += group.reports.length;
  }


  if (total === 0) {
    return `Fertig. Für die ${road} habe ich gerade keine passenden Meldungen gefunden.`;
  }


  let output =
    `Fertig. Ich habe ${total} passende Meldungen für die ${road} gefunden.\n\n`;


  // vollständige Liste
  const showEverything =
    intent.show_all ||
    intent.list_requested;


  const maxPerGroup =
    showEverything
      ? 20
      : 4;


  for (const group of groups) {

    output +=
      `${group.label}: ${group.reports.length}\n`;


    for (
      const report
      of group.reports.slice(
        0,
        maxPerGroup
      )
    ) {

      const title =
        report.title ||
        report.subtitle ||
        report.description?.[0] ||
        "Verkehrsmeldung";

      output +=
        `• ${cleanText(title)}\n`;
    }


    if (
      group.reports.length >
      maxPerGroup
    ) {

      output +=
        `• +${group.reports.length - maxPerGroup} weitere\n`;
    }

    output += "\n";
  }


  if (!showEverything && total > 4) {
    output +=
      `Wenn du möchtest, schreib z. B. „alle Meldungen ${road}“ oder „mach mir eine komplette Liste“.`;
  }


  if (showEverything && total > 20) {
    output +=
      `Es gibt noch weitere Meldungen. Später bauen wir dafür „Weiter“ und Seiten ein.`;
  }


  return output.trim();
}


// ==========================================
// WHATSAPP SENDEN
// ==========================================

async function sendWhatsApp(
  to,
  text,
  env
) {

  const response =
    await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",

        headers: {
          "Authorization":
            `Bearer ${env.WHATSAPP_TOKEN}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          messaging_product:
            "whatsapp",

          recipient_type:
            "individual",

          to,

          type: "text",

          text: {
            preview_url: false,
            body: text.slice(0, 4000)
          }
        })
      }
    );


  if (!response.ok) {

    const error =
      await response.text();

    console.error(
      "WhatsApp send error:",
      error
    );
  }
}


// ==========================================
// HELFER
// ==========================================

function cleanText(value) {

  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
