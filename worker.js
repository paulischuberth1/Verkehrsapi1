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
    // WHATSAPP WEBHOOK
    // =========================
    if (url.pathname === "/webhook") {

      // Meta verifiziert den Webhook
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

        ctx.waitUntil(handleWhatsApp(body, env));

        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response(
      "VerkehrsAPI1 läuft. Schreib dem WhatsApp-Bot eine Nachricht.",
      {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};


// ======================================================
// WHATSAPP VERARBEITEN
// ======================================================

async function handleWhatsApp(body, env) {
  try {
    const value =
      body?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];

    // Statusmeldungen ignorieren
    if (!message) return;

    const from = message.from;

    if (!from) return;

    const text =
      message.text?.body?.trim() || "";

    if (!text) {
      await sendWhatsApp(
        from,
        "Schreib mir einfach, was du über den Verkehr wissen möchtest. Zum Beispiel: „Was ist auf der A46 los?“",
        env
      );
      return;
    }

    // Erst ohne KI versuchen
    let intent = simpleParser(text);

    // Wenn unser Parser nicht reicht → KI
    if (!intent) {
      intent = await understandWithAI(text, env);
    }

    await processIntent(
      from,
      text,
      intent,
      env
    );

  } catch (error) {
    console.error("Webhook error:", error);
  }
}


// ======================================================
// NORMALER PARSER
// ======================================================

function simpleParser(text) {
  const t = text
    .toLowerCase()
    .replace(/[?!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();


  // -------------------------
  // Hilfe
  // -------------------------

  if (
    t === "hilfe" ||
    t === "help" ||
    t.includes("was kann ich fragen") ||
    t.includes("was kann man fragen") ||
    t.includes("was kannst du") ||
    t.includes("was kann der bot")
  ) {
    return {
      action: "help"
    };
  }


  // -------------------------
  // Befehle
  // -------------------------

  if (
    t.includes("alle befehle") ||
    t.includes("befehle auflisten") ||
    t.includes("befehlsliste") ||
    t.includes("liste alle befehle")
  ) {
    return {
      action: "commands"
    };
  }


  // -------------------------
  // Autobahnen auflisten
  // -------------------------

  if (
    t.includes("alle autobahnen") ||
    t.includes("welche autobahnen") ||
    t.includes("autobahnen auflisten") ||
    t.includes("liste autobahnen")
  ) {
    return {
      action: "motorways"
    };
  }


  // -------------------------
  // Autobahn finden
  // versteht A46 und A 46
  // -------------------------

  const match =
    t.match(/\ba\s*(\d{1,3})\b/i);

  if (!match) {
    return null;
  }

  const road =
    `A${match[1]}`;


  // -------------------------
  // Kategorie erkennen
  // -------------------------

  let category = "all";

  if (
    /baustell|bausteln|baustelen|baustelln|bauarbeiten/.test(t)
  ) {
    category = "roadworks";
  }

  if (
    /sperr|gesperrt|vollsperr/.test(t)
  ) {
    category = "closure";
  }

  if (
    /warn|gefahr/.test(t)
  ) {
    category = "warning";
  }


  // -------------------------
  // Alle?
  // -------------------------

  const showAll =
    /\balle\b|\balles\b|sämtliche|komplett|vollständig/.test(t);


  // -------------------------
  // Liste?
  // akzeptiert auch "lite"
  // -------------------------

  const listRequested =
    /\bliste\b|\blite\b|\blsite\b|\blsit\b|auflist|aufgelistet/.test(t);


  return {
    action: "traffic",
    road,
    location: null,
    category,
    show_all: showAll,
    list_requested: listRequested
  };
}


// ======================================================
// KI FÜR FREIE SPRACHE
// ======================================================

async function understandWithAI(text, env) {
  try {
    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          {
            role: "system",
            content: `
Du bist der Sprachparser eines deutschen WhatsApp-Verkehrsbots.

Deine Aufgabe ist ausschließlich:
zu verstehen, was der Nutzer möchte.

Du darfst NIEMALS Verkehrsdaten erfinden.

Verstehe auch:
- Umgangssprache
- Tippfehler
- unvollständige Sätze
- "kannste"
- "guck mal"
- "such mir raus"
- "mach ne liste"
- "lite" wenn wahrscheinlich "Liste" gemeint ist
- "was geht auf der A46"
- "was ist da los"
- höfliche und unhöfliche Formulierungen

Gib eine strukturierte Anfrage zurück.

action:
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
z.B. A46
oder null

location:
z.B. Düsseldorf
Düsseldorf Flughafen
Köln
oder null

show_all:
true, wenn alle oder sämtliche Meldungen gewünscht sind

list_requested:
true, wenn der Nutzer eine Liste oder Auflistung möchte

Wichtig:
Andere Straßen und Orte sollst du trotzdem erkennen,
auch wenn die Datenquelle dafür aktuell noch nicht eingebaut ist.
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


    // WICHTIGER FIX:
    // Cloudflare kann bereits ein fertiges Objekt liefern.
    if (
      result?.response &&
      typeof result.response === "object"
    ) {
      return result.response;
    }


    // Falls doch ein String geliefert wird
    if (
      result?.response &&
      typeof result.response === "string"
    ) {
      try {
        return JSON.parse(result.response);
      } catch (error) {
        console.error(
          "AI JSON konnte nicht gelesen werden:",
          result.response
        );
      }
    }


    // Manche Modelle liefern direkt das Objekt
    if (
      result &&
      typeof result === "object" &&
      result.action
    ) {
      return result;
    }

  } catch (error) {
    console.error("Workers AI error:", error);
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


// ======================================================
// ANFRAGE AUSFÜHREN
// ======================================================

async function processIntent(
  from,
  originalText,
  intent,
  env
) {

  // -------------------------
  // HILFE
  // -------------------------

  if (intent.action === "help") {
    await sendWhatsApp(
      from,
`Klar. Du kannst mir ganz normal schreiben.

Zum Beispiel:

🚗 „Was ist auf der A46 los?“

🚧 „Such mir alle Baustellen auf der A3 raus.“

⛔ „Gibt es Sperrungen auf der A40?“

📋 „Mach mir eine Liste aller Meldungen auf der A57.“

🛣️ „Welche Autobahnen kannst du abfragen?“

📖 „Liste alle Befehle auf.“

Du musst keinen genauen Befehl benutzen.
Umgangssprache und kleinere Tippfehler sind okay.`,
      env
    );

    return;
  }


  // -------------------------
  // BEFEHLE
  // -------------------------

  if (intent.action === "commands") {
    await sendWhatsApp(
      from,
`📋 Möglichkeiten

VERKEHR
• A46
• Verkehr A46
• Was ist auf der A46 los?

BAUSTELLEN
• Baustellen A46
• Such mir Baustellen auf A3 raus.

SPERRUNGEN
• Sperrungen A57
• Was ist auf der A40 gesperrt?

WARNUNGEN
• Warnungen A1
• Gibt es Gefahren auf der A46?

LISTEN
• Alle Meldungen A46
• Mach mir eine Liste aller Baustellen A3.

ÜBERSICHT
• Welche Autobahnen kannst du?
• Alle Autobahnen

HILFE
• Hilfe
• Was kann ich fragen?

Du kannst diese Sätze auch ganz anders formulieren.`,
      env
    );

    return;
  }


  // -------------------------
  // AUTOBAHNEN
  // -------------------------

  if (intent.action === "motorways") {
    await sendWhatsApp(
      from,
`🛣️ Autobahnen in NRW

${NRW_AUTOBAHNEN.join(", ")}

Du kannst zum Beispiel schreiben:

„Was ist auf der A46 los?“`,
      env
    );

    return;
  }


  // -------------------------
  // ORT ERKANNT
  // -------------------------

  if (
    intent.action === "traffic" &&
    !intent.road &&
    intent.location
  ) {
    await sendWhatsApp(
      from,
`Ich habe „${intent.location}“ als Ort erkannt.

Die direkte Ortssuche für Städte, Flughäfen und normale Straßen bauen wir als Nächstes ein.

Momentan kann ich die Verkehrsdaten direkt für Autobahnen abrufen.`,
      env
    );

    return;
  }


  // -------------------------
  // NICHT VERSTANDEN
  // -------------------------

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


  // -------------------------
  // NOCH KEINE AUTOBAHN
  // -------------------------

  if (!/^A\d{1,3}$/.test(road)) {
    await sendWhatsApp(
      from,
`Ich habe „${intent.road}“ als Straße erkannt.

Momentan kann ich die echten Daten direkt für Autobahnen abrufen.

Bundesstraßen, Städte und normale Straßen bauen wir als nächsten Schritt ein.`,
      env
    );

    return;
  }


  // -------------------------
  // ZWISCHENNACHRICHT
  // -------------------------

  let loading =
    `Klar, ich schaue gerade nach, was auf der ${road} los ist. Einen Moment …`;


  if (intent.category === "roadworks") {
    loading =
      `Klar, ich suche dir gerade die Baustellen auf der ${road} raus. Einen Moment …`;
  }


  if (intent.category === "closure") {
    loading =
      `Klar, ich prüfe gerade die Sperrungen auf der ${road}. Einen Moment …`;
  }


  if (intent.category === "warning") {
    loading =
      `Klar, ich prüfe gerade die Warnmeldungen für die ${road}. Einen Moment …`;
  }


  if (
    intent.show_all ||
    intent.list_requested
  ) {
    loading =
      `Klar, ich stelle dir gerade die gewünschte Liste für die ${road} zusammen. Einen Moment …`;
  }


  await sendWhatsApp(
    from,
    loading,
    env
  );


  // -------------------------
  // DATEN ABRUFEN
  // -------------------------

  const data =
    await getTraffic(
      road,
      intent.category
    );


  // -------------------------
  // ANTWORT
  // -------------------------

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


// ======================================================
// VERKEHRSDATEN
// ======================================================

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
        "Traffic API error:",
        error
      );
    }
  }


  return result;
}


// ======================================================
// ANTWORT FORMATIEREN
// ======================================================

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


  const showEverything =
    intent.show_all ||
    intent.list_requested;


  const maxPerGroup =
    showEverything
      ? 15
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
        `• Noch ${group.reports.length - maxPerGroup} weitere Meldungen\n`;
    }


    output += "\n";
  }


  if (
    !showEverything &&
    total > 4
  ) {
    output +=
      `Möchtest du mehr sehen? Du kannst zum Beispiel schreiben:\n„Alle Meldungen ${road}“`;
  }


  if (
    showEverything &&
    total > 15
  ) {
    output +=
      `Es gibt noch weitere Meldungen. Als Nächstes bauen wir dafür Seiten mit „Weiter“ ein.`;
  }


  return output.trim();
}


// ======================================================
// WHATSAPP SENDEN
// ======================================================

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

          type:
            "text",

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


// ======================================================
// HELFER
// ======================================================

function cleanText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
