const VERIFY_TOKEN = "verkehrsapi1-verify-test1";
const GRAPH_VERSION = "v26.0";

const AUTOBAHN_API =
  "https://verkehr.autobahn.de/o/autobahn";

const NRW_WFS =
  "https://www.verkehr.nrw/geoserver/vipnrw/wms";

const NRW_DETAILS =
  "https://verkehr.autobahn.de/karte?p_p_id=de_strassennrw_vipnrw_map_portlet_MapPortlet&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage";

const NOMINATIM =
  "https://nominatim.openstreetmap.org/search";

const PREVIEW_SIZE = 5;
const MAX_WHATSAPP_LENGTH = 3800;


// ======================================================
// QUELLEN
// ======================================================

const SOURCE_AUTOBAHN = {
  id: "autobahn",
  name: "Autobahn GmbH – Verkehrsdaten-API",
  provider: "Die Autobahn GmbH des Bundes",
  website: "https://www.autobahn.de/",
  dataUrl: "https://verkehr.autobahn.de/"
};

const SOURCE_NRW = {
  id: "verkehr-nrw",
  name: "VERKEHR.NRW – Verkehrsdaten",
  provider: "MOBIDROM / VERKEHR.NRW",
  website: "https://www.verkehr.nrw/",
  dataUrl: "https://www.verkehr.nrw/"
};


// ======================================================
// NRW-WFS-LAYER
// ======================================================

const NRW_WFS_TYPES = [
  "vipnrw:planed_traffic_interstate_feature",
  "vipnrw:planed_traffic_urban_feature",
  "vipnrw:traffic_roadworks_urban_feature",
  "vipnrw:traffic_roadworks_interstate_feature",
  "vipnrw:traffic_obstructions_urban_feature",
  "vipnrw:traffic_obstructions_interstate_feature",
  "vipnrw:traffic_abnormal_travel_time_loss_feature"
];


// ======================================================
// WORKER
// ======================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/webhook") {
      return new Response(
        "VerkehrsAPI1 läuft.",
        {
          headers: {
            "content-type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }


    // --------------------------------------------------
    // WEBHOOK VERIFIZIERUNG
    // --------------------------------------------------

    if (request.method === "GET") {
      const mode =
        url.searchParams.get("hub.mode");

      const token =
        url.searchParams.get(
          "hub.verify_token"
        );

      const challenge =
        url.searchParams.get(
          "hub.challenge"
        );


      if (
        mode === "subscribe" &&
        token === VERIFY_TOKEN
      ) {
        return new Response(
          challenge || "",
          { status: 200 }
        );
      }


      return new Response(
        "Forbidden",
        { status: 403 }
      );
    }


    // --------------------------------------------------
    // WHATSAPP EVENT
    // --------------------------------------------------

    if (request.method === "POST") {
      const body =
        await request.json();

      ctx.waitUntil(
        handleWhatsApp(
          body,
          env
        )
      );

      return new Response(
        "EVENT_RECEIVED",
        { status: 200 }
      );
    }


    return new Response(
      "Method not allowed",
      { status: 405 }
    );
  }
};


// ======================================================
// WHATSAPP EINGANG
// ======================================================

async function handleWhatsApp(
  body,
  env
) {
  try {
    const value =
      body?.entry?.[0]
        ?.changes?.[0]
        ?.value;

    const message =
      value?.messages?.[0];

    if (!message) return;


    const from =
      message.from;

    if (!from) return;


    const text =
      message.text?.body
        ?.trim() || "";


    if (!text) {
      await sendWhatsApp(
        from,
`Du kannst mir einfach schreiben, was du wissen möchtest.

Zum Beispiel:

„Was ist auf der A46 los?“

„Alle Meldungen A3“

„Verkehr Düsseldorf“

„Düsseldorf Flughafen“

„Woher hast du die Daten?“

Oder schreib „Hilfe“.`,
        env
      );

      return;
    }


    const t =
      normalizeInput(text);


    // --------------------------------------------------
    // WEITER
    // --------------------------------------------------

    if (
      /^(weiter|mehr|weiter bitte|mehr anzeigen|rest|rest anzeigen)$/
        .test(t)
    ) {
      await sendRemaining(
        from,
        env
      );

      return;
    }


    // --------------------------------------------------
    // QUELLEN
    // --------------------------------------------------

    if (
      isSourceQuestion(t)
    ) {
      await answerSources(
        from,
        env
      );

      return;
    }


    // --------------------------------------------------
    // INFORMATIONEN ÜBER BOT
    // --------------------------------------------------

    if (
      isAboutQuestion(t)
    ) {
      await answerAbout(
        from,
        t,
        env
      );

      return;
    }


    let intent =
      simpleParser(text);


    if (!intent) {
      intent =
        await understandWithAI(
          text,
          env
        );
    }


    await processIntent(
      from,
      text,
      intent,
      env
    );

  } catch (error) {
    console.error(
      "handleWhatsApp:",
      error
    );
  }
}


// ======================================================
// EINFACHER PARSER
// ======================================================

function simpleParser(text) {
  const t =
    normalizeInput(text);


  if (
    t === "hilfe" ||
    t === "help" ||
    t.includes("was kann ich fragen") ||
    t.includes("was kannst du")
  ) {
    return {
      action: "help"
    };
  }


  if (
    t.includes("alle befehle") ||
    t.includes("befehlsliste") ||
    t.includes("befehle auflisten")
  ) {
    return {
      action: "commands"
    };
  }


  if (
    t.includes("wo ist am meisten los") ||
    t.includes("meiste verlustzeit") ||
    t.includes("höchste verlustzeit") ||
    t.includes("hoechste verlustzeit")
  ) {
    return {
      action: "top_traffic"
    };
  }


  const roadMatch =
    t.match(
      /\b(a|b|l|k|s|st)\s*(\d{1,4})\b/i
    );


  let road = null;

  if (roadMatch) {
    road =
      `${roadMatch[1].toUpperCase()}${roadMatch[2]}`;
  }


  let category =
    "all";


  if (
    /baustell|bauarbeiten/.test(t)
  ) {
    category =
      "roadworks";
  }


  if (
    /sperr|gesperrt|vollsperr/.test(t)
  ) {
    category =
      "closure";
  }


  if (
    /warn|gefahr|stau|verkehr/.test(t)
  ) {
    category =
      category === "all"
        ? "all"
        : category;
  }


  const showAll =
    /\balle\b|\balles\b|sämtliche|saemtliche|komplett|vollständig|vollstaendig/
      .test(t);


  if (road) {
    return {
      action: "traffic",
      road,
      location: null,
      category,
      show_all: showAll
    };
  }


  return null;
}


// ======================================================
// KI PARSER
// ======================================================

async function understandWithAI(
  text,
  env
) {
  try {
    const result =
      await env.AI.run(
        "@cf/meta/llama-3.1-8b-instruct-fast",
        {
          messages: [
            {
              role: "system",
              content: `
Du bist der Sprachparser eines
deutschen WhatsApp-Verkehrsbots.

Du sollst ausschließlich verstehen,
was der Nutzer möchte.

Erfinde niemals Verkehrsdaten.

Aktionen:

traffic
help
commands
top_traffic
chat
unknown

road:

Beispiele:
A46
A3
B8
L381
K12

oder null.

location:

Ein Ort, Stadtteil, Flughafen,
Straße oder eine Kombination daraus.

Beispiele:

Düsseldorf
Düsseldorf Flughafen
Kölner Straße Düsseldorf
B8 Düsseldorf

oder null.

category:

all
warning
roadworks
closure

show_all:

true bei:
"alle Meldungen"
"alles"
"sende mir alle"
"zeige mir alle"

Wenn der Nutzer nur normal redet,
verwende action "chat".

Verkehrsdaten dürfen niemals
vom KI-Modell beantwortet werden.
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
                      "top_traffic",
                      "chat",
                      "unknown"
                    ]
                  },

                  road: {
                    type: [
                      "string",
                      "null"
                    ]
                  },

                  location: {
                    type: [
                      "string",
                      "null"
                    ]
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
                  }
                },

                required: [
                  "action",
                  "road",
                  "location",
                  "category",
                  "show_all"
                ]
              }
            }
          }
        }
      );


    if (
      result?.response &&
      typeof result.response === "object"
    ) {
      return result.response;
    }


    if (
      typeof result?.response ===
      "string"
    ) {
      return JSON.parse(
        result.response
      );
    }

  } catch (error) {
    console.error(
      "AI parser:",
      error
    );
  }


  return {
    action: "chat",
    road: null,
    location: null,
    category: "all",
    show_all: false
  };
}


// ======================================================
// INTENT
// ======================================================

async function processIntent(
  from,
  originalText,
  intent,
  env
) {

  // --------------------------------------------------
  // HILFE
  // --------------------------------------------------

  if (
    intent.action === "help"
  ) {
    let text =
`Du kannst mir ganz normal schreiben.

Zum Beispiel:

🚗 „Was ist auf der A46 los?“

🚧 „Baustellen A3“

⛔ „Sperrungen A40“

📋 „Alle Meldungen A57“

📍 „Verkehr Düsseldorf“

✈️ „Düsseldorf Flughafen“

📊 „Wo ist gerade am meisten los?“

🔎 „Woher hast du die Daten?“

ℹ️ „Wie funktionierst du?“

Wenn zunächst nur fünf Meldungen angezeigt werden,
schreib einfach „Weiter“.`;


    if (env.CONTACT_EMAIL) {
      text +=
        `\n\nBei Fragen oder Problemen:\n${env.CONTACT_EMAIL}`;
    }


    await sendWhatsApp(
      from,
      text,
      env
    );

    return;
  }


  // --------------------------------------------------
  // BEFEHLE
  // --------------------------------------------------

  if (
    intent.action === "commands"
  ) {
    await sendWhatsApp(
      from,
`Mögliche Abfragen:

• A46
• Verkehr A46
• Baustellen A3
• Sperrungen A40
• Alle Meldungen A57
• Verkehr Düsseldorf
• Düsseldorf Flughafen
• Weiter
• Quellen
• Wie funktionierst du?
• Hilfe

Du musst diese Formulierungen nicht genau verwenden.`,
      env
    );

    return;
  }


  // --------------------------------------------------
  // TOP VERKEHR NRW
  // --------------------------------------------------

  if (
    intent.action === "top_traffic"
  ) {
    await sendWhatsApp(
      from,
      `Klar, ich schaue nach aktuellen Bereichen mit auffälligen Reisezeitverlusten. Einen Moment …`,
      env
    );


    const result =
      await getTopTravelLossNRW();


    if (!result.length) {
      await sendWhatsApp(
        from,
        `Ich konnte gerade keine entsprechende NRW-Verkehrsübersicht abrufen.`,
        env
      );

      return;
    }


    let answer =
      `Hier sind aktuell auffällige Verkehrsmeldungen mit Reisezeitverlusten in NRW:\n\n`;


    result
      .slice(0, 10)
      .forEach(
        (report, index) => {
          answer +=
            `${index + 1}. ${report.title}\n`;
        }
      );


    answer +=
      `\nQuelle: ${SOURCE_NRW.name}`;


    await sendLongText(
      from,
      answer,
      env
    );

    return;
  }


  // --------------------------------------------------
  // NORMALER CHAT
  // --------------------------------------------------

  if (
    intent.action === "chat" ||
    intent.action === "unknown"
  ) {
    await normalChat(
      from,
      originalText,
      env
    );

    return;
  }


  if (
    intent.action !== "traffic"
  ) {
    await normalChat(
      from,
      originalText,
      env
    );

    return;
  }


  // --------------------------------------------------
  // ZWISCHENNACHRICHT
  // --------------------------------------------------

  const description =
    intent.road ||
    intent.location ||
    "deiner Anfrage";


  await sendWhatsApp(
    from,
    createLoadingText(
      description,
      intent
    ),
    env
  );


  // --------------------------------------------------
  // DATEN SUCHEN
  // --------------------------------------------------

  let result;


  if (
    intent.location
  ) {
    result =
      await searchLocationTraffic(
        intent.location,
        intent.road,
        intent.category,
        env
      );
  }

  else if (
    intent.road
  ) {
    result =
      await getRoadTraffic(
        normalizeRoad(
          intent.road
        ),
        intent.category
      );
  }

  else {
    await sendWhatsApp(
      from,
      `Ich konnte noch nicht erkennen, für welche Straße oder welchen Ort du die Verkehrslage möchtest.`,
      env
    );

    return;
  }


  // --------------------------------------------------
  // AUSSERHALB NRW BEI ORTSSUCHE
  // --------------------------------------------------

  if (
    result?.outsideNRW
  ) {
    await sendWhatsApp(
      from,
`Den Ort habe ich gefunden.

Die zusätzliche Orts- und Stadtstraßensuche über VERKEHR.NRW deckt jedoch Nordrhein-Westfalen ab.

Für nummerierte Straßen wie A3 oder B8 kann ich trotzdem die angebundene Straßen-API abfragen.`,
      env
    );

    return;
  }


  const reports =
    result?.reports || [];

  const sources =
    result?.sources || [];


  if (!reports.length) {
    await sendWhatsApp(
      from,
`Ich habe nachgesehen. Aktuell habe ich dafür keine passenden Verkehrsmeldungen gefunden.

Das bedeutet nicht zwingend, dass dort keinerlei Verkehr besteht – nur, dass die angebundenen Datenquellen gerade keine passende Meldung geliefert haben.`,
      env
    );

    return;
  }


  // --------------------------------------------------
  // SESSION
  // --------------------------------------------------

  await saveSession(
    from,
    {
      reports,
      sources,
      description,
      created:
        Date.now()
    },
    env
  );


  // --------------------------------------------------
  // ALLE
  // --------------------------------------------------

  if (
    intent.show_all
  ) {
    await sendAllReports(
      from,
      reports,
      sources,
      `Hier sind alle ${reports.length} gefundenen Meldungen für ${description}:`,
      env
    );

    return;
  }


  // --------------------------------------------------
  // VORSCHAU
  // --------------------------------------------------

  const preview =
    reports.slice(
      0,
      PREVIEW_SIZE
    );


  let answer;


  if (
    reports.length >
    PREVIEW_SIZE
  ) {
    answer =
      `Hier sind die ersten ${PREVIEW_SIZE} von ${reports.length} Meldungen für ${description}:\n\n`;
  }

  else {
    answer =
      `Hier sind die ${reports.length} gefundenen ${reports.length === 1 ? "Meldung" : "Meldungen"} für ${description}:\n\n`;
  }


  answer +=
    formatReports(
      preview
    );


  if (
    reports.length >
    PREVIEW_SIZE
  ) {
    const remaining =
      reports.length -
      PREVIEW_SIZE;

    answer +=
      `\n\nSchreib „Weiter“, um die weiteren ${remaining} ${remaining === 1 ? "Meldung" : "Meldungen"} anzuzeigen.`;
  }


  answer +=
    `\n\n${shortSourceLine(sources)}`;


  await sendLongText(
    from,
    answer,
    env
  );
}


// ======================================================
// STRASSEN-API
// ======================================================

async function getRoadTraffic(
  road,
  category
) {
  const endpoints = [];


  if (
    category === "all" ||
    category === "warning"
  ) {
    endpoints.push([
      "warning",
      "Verkehrsmeldung"
    ]);
  }


  if (
    category === "all" ||
    category === "roadworks"
  ) {
    endpoints.push([
      "roadworks",
      "Baustelle"
    ]);
  }


  if (
    category === "all" ||
    category === "closure"
  ) {
    endpoints.push([
      "closure",
      "Sperrung"
    ]);
  }


  const reports = [];


  for (
    const [endpoint, label]
    of endpoints
  ) {
    try {
      const response =
        await fetch(
          `${AUTOBAHN_API}/${encodeURIComponent(road)}/services/${endpoint}`
        );


      if (!response.ok) {
        continue;
      }


      const json =
        await response.json();


      const list =
        Array.isArray(
          json[endpoint]
        )
          ? json[endpoint]
          : [];


      for (
        const item
        of list
      ) {
        reports.push({
          title:
            buildAutobahnTitle(
              item
            ),

          category:
            label,

          sourceId:
            SOURCE_AUTOBAHN.id
        });
      }

    } catch (error) {
      console.error(
        "Autobahn API:",
        error
      );
    }
  }


  return {
    reports:
      deduplicateReports(
        reports
      ),

    sources:
      reports.length
        ? [SOURCE_AUTOBAHN]
        : []
  };
}


// ======================================================
// ORTSSUCHE NRW
// ======================================================

async function searchLocationTraffic(
  location,
  road,
  category,
  env
) {
  const geo =
    await geocodeGermany(
      location,
      env
    );


  if (!geo) {
    return {
      reports: [],
      sources: []
    };
  }


  const state =
    geo.address?.state || "";


  if (
    !state
      .toLowerCase()
      .includes(
        "nordrhein-westfalen"
      )
  ) {
    // Falls zusätzlich eine nummerierte Straße
    // vorhanden ist, diese trotzdem abfragen.

    if (road) {
      return await getRoadTraffic(
        normalizeRoad(road),
        category
      );
    }


    return {
      reports: [],
      sources: [],
      outsideNRW: true
    };
  }


  const features =
    await getNrwFeaturesAround(
      Number(geo.lat),
      Number(geo.lon),
      12000
    );


  const identifiers =
    features
      .map(
        feature =>
          feature?.properties
            ?.identifier
      )
      .filter(Boolean);


  if (!identifiers.length) {
    return {
      reports: [],
      sources: []
    };
  }


  const details =
    await getNrwDetails(
      identifiers.slice(
        0,
        100
      )
    );


  const displayTypeById =
    new Map();


  for (
    const feature
    of features
  ) {
    const id =
      feature?.properties
        ?.identifier;

    if (id) {
      displayTypeById.set(
        id,
        feature?.properties
          ?.display_type || ""
      );
    }
  }


  let reports =
    details.map(
      detail => {
        const displayType =
          displayTypeById.get(
            detail.identifier
          ) || "";

        return {
          title:
            buildNrwTitle(
              detail
            ),

          category:
            classifyNrwCategory(
              displayType,
              detail
            ),

          sourceId:
            SOURCE_NRW.id
        };
      }
    );


  // Falls eine Straße wie B8 mitgegeben wurde,
  // nur dazu passende Ergebnisse verwenden.

  if (road) {
    const wanted =
      normalizeSearch(
        normalizeRoad(road)
      );

    reports =
      reports.filter(
        report =>
          normalizeSearch(
            report.title
          ).includes(
            wanted
          )
      );
  }


  reports =
    filterCategory(
      reports,
      category
    );


  const roadApi =
    road
      ? await getRoadTraffic(
          normalizeRoad(road),
          category
        )
      : {
          reports: [],
          sources: []
        };


  const combined =
    deduplicateReports([
      ...roadApi.reports,
      ...reports
    ]);


  const sources =
    uniqueSources([
      ...roadApi.sources,
      ...(reports.length
        ? [SOURCE_NRW]
        : [])
    ]);


  return {
    reports:
      combined,
    sources
  };
}


// ======================================================
// NOMINATIM – NUR ORT → KOORDINATEN
// ======================================================

async function geocodeGermany(
  query,
  env
) {
  try {
    const url =
      new URL(
        NOMINATIM
      );


    url.searchParams.set(
      "q",
      query
    );

    url.searchParams.set(
      "format",
      "jsonv2"
    );

    url.searchParams.set(
      "limit",
      "1"
    );

    url.searchParams.set(
      "countrycodes",
      "de"
    );

    url.searchParams.set(
      "addressdetails",
      "1"
    );


    const response =
      await fetch(
        url.toString(),
        {
          headers: {
            "Accept-Language":
              "de",

            "User-Agent":
              env.CONTACT_EMAIL
                ? `Paulis-Verkehrsservice/1.0 (${env.CONTACT_EMAIL})`
                : "Paulis-Verkehrsservice/1.0"
          }
        }
      );


    if (!response.ok) {
      return null;
    }


    const json =
      await response.json();


    return Array.isArray(json)
      ? json[0] || null
      : null;

  } catch (error) {
    console.error(
      "Geocoding:",
      error
    );

    return null;
  }
}


// ======================================================
// VERKEHR.NRW WFS
// ======================================================

async function getNrwFeaturesAround(
  lat,
  lon,
  radiusMeters
) {
  try {
    const center =
      toWebMercator(
        lat,
        lon
      );


    const minX =
      center.x -
      radiusMeters;

    const minY =
      center.y -
      radiusMeters;

    const maxX =
      center.x +
      radiusMeters;

    const maxY =
      center.y +
      radiusMeters;


    const url =
      new URL(
        NRW_WFS
      );


    url.searchParams.set(
      "service",
      "WFS"
    );

    url.searchParams.set(
      "version",
      "2.0.0"
    );

    url.searchParams.set(
      "request",
      "GetFeature"
    );

    url.searchParams.set(
      "typenames",
      NRW_WFS_TYPES.join(",")
    );

    url.searchParams.set(
      "srsname",
      "EPSG:900913"
    );

    url.searchParams.set(
      "bbox",
      `${minX},${minY},${maxX},${maxY},EPSG:900913`
    );

    url.searchParams.set(
      "outputFormat",
      "text/javascript"
    );

    url.searchParams.set(
      "format_options",
      "callback:verkehrCallback"
    );


    const response =
      await fetch(
        url.toString()
      );


    if (!response.ok) {
      return [];
    }


    const text =
      await response.text();


    const json =
      parseJsonp(
        text
      );


    return Array.isArray(
      json?.features
    )
      ? json.features
      : [];

  } catch (error) {
    console.error(
      "NRW WFS:",
      error
    );

    return [];
  }
}


// ======================================================
// VERKEHR.NRW DETAILS
// ======================================================

async function getNrwDetails(
  identifiers
) {
  const output = [];


  for (
    let i = 0;
    i < identifiers.length;
    i += 25
  ) {
    const chunk =
      identifiers.slice(
        i,
        i + 25
      );


    try {
      const body =
        new URLSearchParams();

      body.set(
        "action",
        "getTrafficObjectsByIdentifier"
      );

      body.set(
        "identifier",
        chunk.join("|")
      );


      const response =
        await fetch(
          NRW_DETAILS,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8"
            },

            body:
              body.toString()
          }
        );


      if (!response.ok) {
        continue;
      }


      const json =
        await response.json();


      if (
        Array.isArray(
          json?.data
        )
      ) {
        output.push(
          ...json.data
        );
      }

    } catch (error) {
      console.error(
        "NRW details:",
        error
      );
    }
  }


  return output;
}


// ======================================================
// TOP REISEZEITVERLUST NRW
// ======================================================

async function getTopTravelLossNRW() {
  try {
    const url =
      new URL(
        NRW_WFS
      );


    url.searchParams.set(
      "service",
      "WFS"
    );

    url.searchParams.set(
      "version",
      "2.0.0"
    );

    url.searchParams.set(
      "request",
      "GetFeature"
    );

    url.searchParams.set(
      "typenames",
      "vipnrw:traffic_abnormal_travel_time_loss_feature"
    );

    url.searchParams.set(
      "srsname",
      "EPSG:900913"
    );

    url.searchParams.set(
      "outputFormat",
      "text/javascript"
    );

    url.searchParams.set(
      "format_options",
      "callback:verkehrCallback"
    );


    const response =
      await fetch(
        url.toString()
      );


    if (!response.ok) {
      return [];
    }


    const data =
      parseJsonp(
        await response.text()
      );


    const ids =
      (data?.features || [])
        .map(
          f =>
            f?.properties
              ?.identifier
        )
        .filter(Boolean)
        .slice(0, 100);


    const details =
      await getNrwDetails(
        ids
      );


    return details
      .map(
        detail => ({
          title:
            buildNrwTitle(
              detail
            ),

          minutes:
            extractMinutes(
              detail
            )
        })
      )
      .sort(
        (a, b) =>
          b.minutes -
          a.minutes
      );

  } catch (error) {
    console.error(
      "Top traffic:",
      error
    );

    return [];
  }
}


// ======================================================
// WEITER
// ======================================================

async function sendRemaining(
  from,
  env
) {
  const session =
    await loadSession(
      from,
      env
    );


  if (!session) {
    await sendWhatsApp(
      from,
`Ich habe gerade keine vorherige Liste gespeichert.

Starte einfach eine neue Abfrage, zum Beispiel:

„A46“`,
      env
    );

    return;
  }


  const remaining =
    (session.reports || [])
      .slice(
        PREVIEW_SIZE
      );


  if (!remaining.length) {
    await sendWhatsApp(
      from,
      `Bei deiner letzten Abfrage wurden bereits alle Meldungen angezeigt.`,
      env
    );

    return;
  }


  await sendAllReports(
    from,
    remaining,
    session.sources || [],
    `Hier sind die weiteren ${remaining.length} ${remaining.length === 1 ? "Meldung" : "Meldungen"} für ${session.description}:`,
    env
  );


  await deleteSession(
    from,
    env
  );
}


// ======================================================
// QUELLEN
// ======================================================

async function answerSources(
  from,
  env
) {
  const session =
    await loadSession(
      from,
      env
    );


  const sources =
    session?.sources?.length
      ? session.sources
      : [
          SOURCE_AUTOBAHN,
          SOURCE_NRW
        ];


  let text =
`Die Verkehrsmeldungen werden aus angebundenen Verkehrsdatenquellen abgerufen und nicht von der KI erfunden.

Verwendete bzw. verfügbare Verkehrsquellen:`;


  for (
    let i = 0;
    i < sources.length;
    i++
  ) {
    const source =
      sources[i];

    text +=
`\n\n${i + 1}. ${source.name}
Anbieter: ${source.provider}
Webseite: ${source.website}
Datendienst: ${source.dataUrl}`;
  }


  text +=
`\n\nDie KI wird hauptsächlich verwendet, um frei formulierte Nachrichten zu verstehen. Sie erzeugt keine eigenen Verkehrsmeldungen.`;


  await sendLongText(
    from,
    text,
    env
  );
}


// ======================================================
// BOT INFORMATION
// ======================================================

async function answerAbout(
  from,
  text,
  env
) {
  if (
    text.includes(
      "normal sprechen"
    ) ||
    text.includes(
      "normal mit dir"
    )
  ) {
    await sendWhatsApp(
      from,
`Ja, klar. Du kannst ganz normal mit mir schreiben.

Ich bin hauptsächlich für Verkehrsinformationen gedacht, kann aber auch Fragen über meine Funktionen beantworten.`,
      env
    );

    return;
  }


  if (
    text.includes(
      "wer hat dich"
    )
  ) {
    await sendWhatsApp(
      from,
`Ich bin der Verkehrsbot von Paulis Verkehrsservice.

Ich laufe über Cloudflare Workers und WhatsApp und greife für Verkehrsinformationen auf angebundene Verkehrsdatenquellen zu.`,
      env
    );

    return;
  }


  let answer =
`Ich bin ein WhatsApp-Verkehrsbot.

Technisch verwende ich:

• Cloudflare Workers
• WhatsApp Cloud API
• Cloudflare Workers AI zum Sprachverständnis
• Autobahn GmbH Verkehrsdaten
• VERKEHR.NRW Verkehrsdaten

Verkehrsmeldungen werden aus den Datenquellen abgerufen und nicht von der KI erfunden.`;


  if (
    env.CONTACT_EMAIL
  ) {
    answer +=
      `\n\nBei Fragen:\n${env.CONTACT_EMAIL}`;
  }


  await sendWhatsApp(
    from,
    answer,
    env
  );
}


// ======================================================
// NORMALER CHAT
// ======================================================

async function normalChat(
  from,
  text,
  env
) {
  try {
    const result =
      await env.AI.run(
        "@cf/meta/llama-3.1-8b-instruct-fast",
        {
          messages: [
            {
              role: "system",
              content: `
Du bist der freundliche Assistent eines
deutschen WhatsApp-Verkehrsbots.

Antworte kurz und natürlich auf Deutsch.

Der Nutzer kann ganz normal mit dir sprechen.

WICHTIG:

Erfinde niemals aktuelle Verkehrsdaten.

Wenn der Nutzer aktuelle Staus,
Baustellen, Sperrungen oder sonstige
Verkehrsdaten wissen möchte, bitte ihn,
Straße oder Ort zu nennen, damit die
echten Datenquellen abgefragt werden.
`
            },

            {
              role: "user",
              content: text
            }
          ]
        }
      );


    const answer =
      typeof result?.response ===
      "string"
        ? result.response
        : "Du kannst mir ganz normal schreiben. Für aktuelle Verkehrsdaten nenn mir am besten eine Straße oder einen Ort.";


    await sendWhatsApp(
      from,
      answer,
      env
    );

  } catch (error) {
    console.error(
      "Normal chat:",
      error
    );


    await sendWhatsApp(
      from,
      `Du kannst mir ganz normal schreiben. Für Verkehrsdaten nenn mir am besten eine Straße oder einen Ort.`,
      env
    );
  }
}


// ======================================================
// MELDUNGEN SENDEN
// ======================================================

async function sendAllReports(
  from,
  reports,
  sources,
  intro,
  env
) {
  const chunks = [];

  let current =
    `${intro}\n\n`;


  for (
    const report
    of reports
  ) {
    const line =
      `• ${cleanText(report.title)}\n`;


    if (
      current.length +
      line.length >
      MAX_WHATSAPP_LENGTH
    ) {
      chunks.push(
        current.trim()
      );

      current = "";
    }


    current +=
      line;
  }


  if (
    current.trim()
  ) {
    chunks.push(
      current.trim()
    );
  }


  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    let text =
      chunks[i];


    if (
      chunks.length > 1
    ) {
      text =
        `Teil ${i + 1}/${chunks.length}\n\n${text}`;
    }


    if (
      i ===
      chunks.length - 1
    ) {
      text +=
        `\n\n${shortSourceLine(sources)}`;
    }


    await sendWhatsApp(
      from,
      text,
      env
    );
  }
}


// ======================================================
// SESSION – CLOUDFLARE KV
// Binding muss SESSIONS heißen.
// ======================================================

async function saveSession(
  from,
  value,
  env
) {
  if (!env.SESSIONS) {
    console.error(
      "KV Binding SESSIONS fehlt."
    );

    return;
  }


  await env.SESSIONS.put(
    `wa:${from}`,
    JSON.stringify(value),
    {
      expirationTtl:
        1800
    }
  );
}


async function loadSession(
  from,
  env
) {
  if (!env.SESSIONS) {
    return null;
  }


  return await env.SESSIONS.get(
    `wa:${from}`,
    "json"
  );
}


async function deleteSession(
  from,
  env
) {
  if (!env.SESSIONS) {
    return;
  }


  await env.SESSIONS.delete(
    `wa:${from}`
  );
}


// ======================================================
// WHATSAPP
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

        body:
          JSON.stringify({
            messaging_product:
              "whatsapp",

            recipient_type:
              "individual",

            to,

            type:
              "text",

            text: {
              preview_url:
                false,

              body:
                String(text).slice(
                  0,
                  4000
                )
            }
          })
      }
    );


  if (!response.ok) {
    console.error(
      "WhatsApp:",
      await response.text()
    );
  }
}


// ======================================================
// HELFER
// ======================================================

function createLoadingText(
  target,
  intent
) {
  if (
    intent.category ===
    "roadworks"
  ) {
    return `Klar, ich suche dir die aktuellen Baustellen für ${target} raus. Einen Moment …`;
  }


  if (
    intent.category ===
    "closure"
  ) {
    return `Klar, ich schaue nach aktuellen Sperrungen für ${target}. Einen Moment …`;
  }


  if (
    intent.show_all
  ) {
    return `Klar, ich suche dir alle aktuellen Meldungen für ${target} raus. Einen Moment …`;
  }


  return `Klar, ich schaue nach, was aktuell bei ${target} los ist. Einen Moment …`;
}


function buildAutobahnTitle(
  item
) {
  const parts = [];


  if (item.title) {
    parts.push(item.title);
  }


  if (
    item.subtitle &&
    item.subtitle !== item.title
  ) {
    parts.push(item.subtitle);
  }


  if (
    Array.isArray(
      item.description
    )
  ) {
    const description =
      item.description
        .filter(Boolean)
        .slice(-2)
        .join(" ");

    if (description) {
      parts.push(
        description
      );
    }
  }


  return cleanText(
    parts.join(" – ") ||
    "Verkehrsmeldung"
  );
}


function buildNrwTitle(
  item
) {
  const parts = [];


  if (item.title) {
    parts.push(item.title);
  }


  if (
    item.subtitle &&
    item.subtitle !==
      item.title
  ) {
    parts.push(item.subtitle);
  }


  if (
    Array.isArray(
      item.description
    )
  ) {
    const description =
      item.description
        .filter(Boolean)
        .join(" ");

    if (description) {
      parts.push(
        description
      );
    }
  }


  if (
    !parts.length &&
    Array.isArray(
      item.footer
    )
  ) {
    parts.push(
      ...item.footer
    );
  }


  return cleanText(
    parts.join(" – ") ||
    "Verkehrsmeldung"
  );
}


function classifyNrwCategory(
  displayType,
  item
) {
  const value =
    `${displayType} ${JSON.stringify(item)}`
      .toUpperCase();


  if (
    value.includes("ROADWORK")
  ) {
    return "Baustelle";
  }


  if (
    value.includes("CLOSURE") ||
    value.includes("BLOCK")
  ) {
    return "Sperrung";
  }


  if (
    value.includes("CONGESTION") ||
    value.includes("TRAVEL_TIME")
  ) {
    return "Stau";
  }


  return "Verkehrsmeldung";
}


function filterCategory(
  reports,
  category
) {
  if (
    category === "all"
  ) {
    return reports;
  }


  if (
    category === "roadworks"
  ) {
    return reports.filter(
      r =>
        r.category ===
        "Baustelle"
    );
  }


  if (
    category === "closure"
  ) {
    return reports.filter(
      r =>
        r.category ===
        "Sperrung"
    );
  }


  return reports;
}


function formatReports(
  reports
) {
  return reports
    .map(
      r =>
        `• ${cleanText(r.title)}`
    )
    .join("\n");
}


function shortSourceLine(
  sources
) {
  if (!sources.length) {
    return "Quelle: angebundene Verkehrsdatenquelle";
  }


  if (
    sources.length === 1
  ) {
    return `Quelle: ${sources[0].name}`;
  }


  return (
    "Quellen: " +
    sources
      .map(
        source =>
          source.name
      )
      .join(", ")
  );
}


function deduplicateReports(
  reports
) {
  const seen =
    new Set();

  const result = [];


  for (
    const report
    of reports
  ) {
    const key =
      normalizeSearch(
        report.title
      );


    if (
      seen.has(key)
    ) {
      continue;
    }


    seen.add(key);

    result.push(
      report
    );
  }


  return result;
}


function uniqueSources(
  sources
) {
  const map =
    new Map();


  for (
    const source
    of sources
  ) {
    map.set(
      source.id,
      source
    );
  }


  return [
    ...map.values()
  ];
}


function extractMinutes(
  item
) {
  const text =
    JSON.stringify(item);


  const matches =
    [
      ...text.matchAll(
        /(\d{1,3})\s*(?:min|minuten)/gi
      )
    ];


  let highest = 0;


  for (
    const match
    of matches
  ) {
    highest =
      Math.max(
        highest,
        Number(
          match[1]
        )
      );
  }


  if (
    typeof item?.impact?.lower ===
    "number"
  ) {
    highest =
      Math.max(
        highest,
        item.impact.lower
      );
  }


  if (
    typeof item?.impact?.upper ===
    "number"
  ) {
    highest =
      Math.max(
        highest,
        item.impact.upper
      );
  }


  return highest;
}


function toWebMercator(
  lat,
  lon
) {
  const x =
    lon *
    20037508.34 /
    180;


  let y =
    Math.log(
      Math.tan(
        (90 + lat) *
        Math.PI /
        360
      )
    ) /
    (Math.PI / 180);


  y =
    y *
    20037508.34 /
    180;


  return {
    x,
    y
  };
}


function parseJsonp(
  text
) {
  const first =
    text.indexOf("(");

  const last =
    text.lastIndexOf(")");


  if (
    first === -1 ||
    last === -1
  ) {
    return null;
  }


  return JSON.parse(
    text.slice(
      first + 1,
      last
    )
  );
}


function normalizeInput(
  text
) {
  return String(text)
    .toLowerCase()
    .replace(/[?!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function normalizeSearch(
  text
) {
  return String(text)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}


function normalizeRoad(
  road
) {
  return String(road)
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}


function cleanText(
  value
) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(
      0,
      900
    );
}


function isSourceQuestion(
  text
) {
  return (
    text === "quelle" ||
    text === "quellen" ||
    text.includes(
      "woher hast du die daten"
    ) ||
    text.includes(
      "woher kommen die daten"
    ) ||
    text.includes(
      "welche quelle"
    ) ||
    text.includes(
      "welche api"
    ) ||
    text.includes(
      "sind die daten erfunden"
    )
  );
}


function isAboutQuestion(
  text
) {
  return (
    text.includes(
      "wer hat dich erstellt"
    ) ||
    text.includes(
      "wer hat dich gemacht"
    ) ||
    text.includes(
      "wer bist du"
    ) ||
    text.includes(
      "wie funktionierst du"
    ) ||
    text.includes(
      "technische daten"
    ) ||
    text.includes(
      "normal sprechen"
    ) ||
    text.includes(
      "normal mit dir"
    )
  );
}


async function sendLongText(
  to,
  text,
  env
) {
  if (
    text.length <=
    MAX_WHATSAPP_LENGTH
  ) {
    await sendWhatsApp(
      to,
      text,
      env
    );

    return;
  }


  const paragraphs =
    text.split("\n");

  let current = "";

  const chunks = [];


  for (
    const paragraph
    of paragraphs
  ) {
    const addition =
      `${paragraph}\n`;


    if (
      current.length +
      addition.length >
      MAX_WHATSAPP_LENGTH
    ) {
      chunks.push(
        current.trim()
      );

      current = "";
    }


    current +=
      addition;
  }


  if (
    current.trim()
  ) {
    chunks.push(
      current.trim()
    );
  }


  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    await sendWhatsApp(
      to,
      chunks.length > 1
        ? `Teil ${i + 1}/${chunks.length}\n\n${chunks[i]}`
        : chunks[i],
      env
    );
  }
}
