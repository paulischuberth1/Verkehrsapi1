const VERIFY_TOKEN = "verkehrsapi1-verify-test1";
const GRAPH_VERSION = "v26.0";

const AUTOBAHN_API = "https://verkehr.autobahn.de/o/autobahn";

const PREVIEW_SIZE = 9;
const MAX_MESSAGE_LENGTH = 3800;

const SOURCE_AUTOBAHN = {
  id: "autobahn",
  name: "Autobahn GmbH – Verkehrsdaten-API",
  provider: "Die Autobahn GmbH des Bundes",
  website: "https://www.autobahn.de/",
  dataUrl: "https://verkehr.autobahn.de/"
};


// ======================================================
// WORKER
// ======================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/webhook") {
      return new Response("VerkehrsAPI1 läuft.", {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (
        mode === "subscribe" &&
        token === VERIFY_TOKEN
      ) {
        return new Response(challenge || "", {
          status: 200
        });
      }

      return new Response("Forbidden", {
        status: 403
      });
    }

    if (request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request", {
          status: 400
        });
      }

      ctx.waitUntil(
        handleWhatsApp(body, env)
      );

      return new Response("EVENT_RECEIVED", {
        status: 200
      });
    }

    return new Response("Method not allowed", {
      status: 405
    });
  }
};


// ======================================================
// WHATSAPP-EINGANG
// ======================================================

async function handleWhatsApp(body, env) {
  try {
    const value =
      body?.entry?.[0]
        ?.changes?.[0]
        ?.value;

    const message =
      value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    if (!from) return;

    const text =
      message.text?.body?.trim() || "";

    if (!text) {
      await sendWhatsApp(
        from,
        

`Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“
„Welche Baustellen gibt es auf der A3?“
„Gibt es Sperrungen auf der A40?“
„Zeig mir alle Meldungen auf der A57.“
„Woher hast du deine Daten?“

Du kannst deine Frage auch ganz normal formulieren.`,
        env
      );

      return;
    }

    const t = normalizeInput(text);

    // WEITER
    if (
      /^(weiter|mehr|weiter bitte|mehr anzeigen|rest|rest anzeigen)$/.test(t)
    ) {
      await sendRemaining(from, env);
      return;
    }

    // QUELLEN
    if (isSourceQuestion(t)) {
      await answerSources(from, env);
      return;
    }

    // FRAGEN ÜBER DEN BOT
    if (isAboutQuestion(t)) {
      await answerAbout(from, t, env);
      return;
    }

    let intent = simpleParser(text);

    if (!intent) {
      intent = await understandWithAI(
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
      "Webhook error:",
      error
    );
  }
}


// ======================================================
// EINFACHER PARSER
// ======================================================

function simpleParser(text) {
  const t = normalizeInput(text);

  if (
    t === "hilfe" ||
    t === "help" ||
    t.includes("was kann ich fragen") ||
    t.includes("was kannst du") ||
    t.includes("beispiele")
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
    t.includes("welche autobahnen") ||
    t.includes("autobahnen auflisten") ||
    t === "autobahnen"
  ) {
    return {
      action: "roads"
    };
  }

  const match =
    t.match(
      /\b(a|b|l|st|s|k)\s*(\d{1,4})\b/i
    );

  if (!match) {
    return null;
  }

  const road =
    `${match[1].toUpperCase()}${match[2]}`;

  let category = "all";

  if (/baustell|bauarbeiten/.test(t)) {
    category = "roadworks";
  }

  if (/sperr|gesperrt|vollsperr/.test(t)) {
    category = "closure";
  }

  if (/warn|gefahr/.test(t)) {
    category = "warning";
  }

  const showAll =
    /\balle\b/.test(t) ||
    /\balles\b/.test(t) ||
    t.includes("sämtliche") ||
    t.includes("saemtliche") ||
    t.includes("sende mir alle") ||
    t.includes("zeig mir alle") ||
    t.includes("zeige mir alle");

  return {
    action: "traffic",
    road,
    location: null,
    category,
    show_all: showAll
  };
}


// ======================================================
// KI-PARSER
// ======================================================

async function understandWithAI(text, env) {
  if (!env.AI) {
    return {
      action: "chat",
      road: null,
      location: null,
      category: "all",
      show_all: false
    };
  }

  try {
    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          {
            role: "system",
            content: `
Du bist der Sprachparser eines deutschen
WhatsApp-Verkehrsbots.

Deine Aufgabe ist ausschließlich,
die Anfrage des Nutzers zu verstehen.

Erfinde niemals Verkehrsdaten.

Mögliche Aktionen:

traffic
help
commands
roads
chat
unknown

road:

Beispiele:
A46
A3
B8
L381
St2418

oder null.

location:

Zum Beispiel:
Düsseldorf
Köln
Düsseldorf Flughafen

oder null.

category:

all
warning
roadworks
closure

show_all:

true, wenn ausdrücklich alle Meldungen
angefordert werden.

Wenn der Nutzer normal mit dem Bot spricht,
verwende action "chat".

Aktuelle Verkehrsinformationen dürfen
niemals von der KI erfunden werden.

Antworte ausschließlich als JSON.
`
          },
          {
            role: "user",
            content: text
          }
        ]
      }
    );

    let response = result?.response;

    if (
      response &&
      typeof response === "object"
    ) {
      return normalizeIntent(response);
    }

    if (typeof response === "string") {
      response = response
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      return normalizeIntent(
        JSON.parse(response)
      );
    }

  } catch (error) {
    console.error(
      "Workers AI parser error:",
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


function normalizeIntent(intent) {
  const allowedActions = [
    "traffic",
    "help",
    "commands",
    "roads",
    "chat",
    "unknown"
  ];

  const allowedCategories = [
    "all",
    "warning",
    "roadworks",
    "closure"
  ];

  return {
    action:
      allowedActions.includes(intent?.action)
        ? intent.action
        : "unknown",

    road:
      intent?.road
        ? normalizeRoad(intent.road)
        : null,

    location:
      intent?.location
        ? String(intent.location).trim()
        : null,

    category:
      allowedCategories.includes(intent?.category)
        ? intent.category
        : "all",

    show_all:
      intent?.show_all === true
  };
}


// ======================================================
// ANFRAGE VERARBEITEN
// ======================================================

async function processIntent(
  from,
  originalText,
  intent,
  env
) {

  // HILFE
  if (intent.action === "help") {
    let answer =
`Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“
„Welche Baustellen gibt es auf der A3?“
„Gibt es Sperrungen auf der A40?“
„Zeig mir alle Meldungen auf der A57.“
„Welche Autobahnen kannst du abfragen?“
„Woher hast du deine Daten?“
„Was bist du?“

Wenn mehr als neun Meldungen gefunden werden,
zeige ich dir zunächst die ersten neun.
Danach kannst du „Weiter“ schreiben.

Du kannst deine Frage ganz normal formulieren.
Du musst keinen bestimmten Befehl verwenden.`;

    if (env.CONTACT_EMAIL) {
      answer +=
        `\n\nBei Fragen oder Problemen:\n${env.CONTACT_EMAIL}`;
    }

    await sendWhatsApp(
      from,
      answer,
      env
    );

    return;
  }


  // BEFEHLE
  if (intent.action === "commands") {
    await sendWhatsApp(
      from,
`Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“
„Welche Baustellen gibt es auf der A3?“
„Gibt es Sperrungen auf der A40?“
„Zeig mir alle Meldungen auf der A57.“
„Welche Autobahnen kannst du abfragen?“
„Woher hast du deine Daten?“
„Wie funktionierst du?“

Du kannst deine Frage auch ganz anders formulieren.`,
      env
    );

    return;
  }


  // AUTOBAHNLISTE
  if (intent.action === "roads") {
    await sendWhatsApp(
      from,
      `Klar, ich schaue nach, welche Autobahnen die Datenquelle aktuell bereitstellt. Einen Moment …`,
      env
    );

    const roads =
      await getAvailableRoads();

    if (!roads.length) {
      await sendWhatsApp(
        from,
        `Ich konnte die Liste gerade nicht abrufen. Versuch es bitte später noch einmal.`,
        env
      );

      return;
    }

    const autobahns =
      roads.filter(
        road =>
          /^A\s*\d+/i.test(road)
      );

    const answer =
`Hier sind die aktuell verfügbaren Autobahnen:

${autobahns.join(", ")}

Quelle: ${SOURCE_AUTOBAHN.name}`;

    await sendLongText(
      from,
      answer,
      env
    );

    return;
  }


  // NORMALER CHAT
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


  // ORT OHNE AUTOBAHN
  if (
    intent.action === "traffic" &&
    !intent.road &&
    intent.location
  ) {
    await sendWhatsApp(
      from,
`Ich habe „${cleanText(intent.location)}“ als Ort erkannt.

Für Bundesstraßen, Landes- und Staatsstraßen sowie Stadt- und Nebenstraßen stehen mir derzeit noch nicht ausreichend Verkehrs- und Vergleichsdaten zur Verfügung, um überall zuverlässige Auskünfte geben zu können.

Autobahnen kann ich bereits direkt abfragen.`,
      env
    );

    return;
  }


  if (
    intent.action !== "traffic" ||
    !intent.road
  ) {
    await normalChat(
      from,
      originalText,
      env
    );

    return;
  }


  const road =
    normalizeRoad(intent.road);


  // DERZEIT KEINE ZUVERLÄSSIGE FLÄCHENDECKUNG
  // FÜR ANDERE STRASSENKLASSEN
  if (!road.startsWith("A")) {
    await sendWhatsApp(
      from,
`Ich habe ${road} als Straße erkannt.

Für Bundesstraßen, Landes- und Staatsstraßen sowie Stadt- und Nebenstraßen stehen mir derzeit noch nicht ausreichend Verkehrs- und Vergleichsdaten zur Verfügung, um überall zuverlässige Auskünfte geben zu können.

Für Autobahnen kann ich bereits aktuelle Verkehrsmeldungen abrufen.`,
      env
    );

    return;
  }


  await sendWhatsApp(
    from,
    createLoadingMessage(
      road,
      intent
    ),
    env
  );


  const result =
    await getTrafficFromProviders(
      road,
      intent.category
    );

  const reports =
    result.reports;

  const sources =
    result.sources;


  // KEINE MELDUNGEN
  if (!reports.length) {
    await saveSession(
      from,
      {
        road,
        reports: [],
        sources:
          sources.length
            ? sources
            : [SOURCE_AUTOBAHN],
        created: Date.now(),
        allShown: true
      },
      env
    );

    await sendWhatsApp(
      from,
`Ich habe nachgesehen. Aktuell habe ich keine passenden Verkehrsmeldungen für die ${road} gefunden.

Das bedeutet nicht unbedingt, dass dort keinerlei Verkehr oder Verzögerungen bestehen. Die angebundene Datenquelle hat für deine Anfrage gerade keine passende Meldung geliefert.

${shortSourceLine(
  sources.length
    ? sources
    : [SOURCE_AUTOBAHN]
)}`,
      env
    );

    return;
  }


  // ALLE MELDUNGEN DIREKT
  if (intent.show_all) {
    await saveSession(
      from,
      {
        road,
        reports,
        sources,
        created: Date.now(),
        allShown: true
      },
      env
    );

    await sendAllReports(
      from,
      reports,
      sources,
      `Hier sind alle ${reports.length} gefundenen Meldungen für die ${road}:`,
      env
    );

    return;
  }


  // SESSION SPEICHERN
  await saveSession(
    from,
    {
      road,
      reports,
      sources,
      created: Date.now(),
      allShown:
        reports.length <= PREVIEW_SIZE
    },
    env
  );


  const preview =
    reports.slice(
      0,
      PREVIEW_SIZE
    );

  let answer;

  if (reports.length > PREVIEW_SIZE) {
    answer =
      `Hier sind die ersten ${PREVIEW_SIZE} von ${reports.length} Meldungen für die ${road}:\n\n`;
  }

  else if (reports.length === 1) {
    answer =
      `Hier ist die aktuell gefundene Meldung für die ${road}:\n\n`;
  }

  else {
    answer =
      `Hier sind die ${reports.length} gefundenen Meldungen für die ${road}:\n\n`;
  }

  answer +=
    formatReports(preview);

  if (reports.length > PREVIEW_SIZE) {
    const remaining =
      reports.length -
      PREVIEW_SIZE;

    answer +=
      `\n\nSchreib „Weiter“, um die weiteren ${remaining} ${
        remaining === 1
          ? "Meldung"
          : "Meldungen"
      } anzuzeigen.`;
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
// LADE-NACHRICHT
// ======================================================

function createLoadingMessage(
  road,
  intent
) {
  if (intent.category === "roadworks") {
    return `Klar, ich suche dir die aktuellen Baustellen auf der ${road} raus. Einen Moment …`;
  }

  if (intent.category === "closure") {
    return `Klar, ich schaue nach aktuellen Sperrungen auf der ${road}. Einen Moment …`;
  }

  if (intent.category === "warning") {
    return `Klar, ich prüfe die aktuellen Warnmeldungen für die ${road}. Einen Moment …`;
  }

  if (intent.show_all) {
    return `Klar, ich suche dir alle aktuellen Meldungen für die ${road} raus. Einen Moment …`;
  }

  return `Klar, ich schaue nach, was aktuell auf der ${road} los ist. Einen Moment …`;
}


// ======================================================
// VERKEHRSDATEN
// ======================================================

async function getTrafficFromProviders(
  road,
  category
) {
  const reports = [];
  const sources = [];

  const autobahn =
    await getAutobahnTraffic(
      road,
      category
    );

  if (autobahn.reports.length) {
    reports.push(
      ...autobahn.reports
    );

    sources.push(
      autobahn.source
    );
  }

  return {
    reports:
      deduplicateReports(reports),

    sources:
      uniqueSources(sources)
  };
}


// ======================================================
// AUTOBAHN-API
// ======================================================

async function getAutobahnTraffic(
  road,
  category
) {
  const categories = [];

  if (
    category === "all" ||
    category === "warning"
  ) {
    categories.push([
      "Warnung",
      "warning"
    ]);
  }

  if (
    category === "all" ||
    category === "roadworks"
  ) {
    categories.push([
      "Baustelle",
      "roadworks"
    ]);
  }

  if (
    category === "all" ||
    category === "closure"
  ) {
    categories.push([
      "Sperrung",
      "closure"
    ]);
  }

  const reports = [];

  for (
    const [label, endpoint]
    of categories
  ) {
    try {
      const response =
        await fetch(
          `${AUTOBAHN_API}/${encodeURIComponent(road)}/services/${endpoint}`
        );

      if (!response.ok) {
        console.error(
          "Traffic API HTTP error:",
          response.status,
          road,
          endpoint
        );

        continue;
      }

      const json =
        await response.json();

      const list =
        Array.isArray(json[endpoint])
          ? json[endpoint]
          : [];

      for (const item of list) {
        reports.push({
          category: label,

          title:
            buildTrafficTitle(item),

          sourceId:
            SOURCE_AUTOBAHN.id,

          sourceName:
            SOURCE_AUTOBAHN.name
        });
      }

    } catch (error) {
      console.error(
        "Traffic API error:",
        road,
        endpoint,
        error
      );
    }
  }

  return {
    reports,
    source:
      SOURCE_AUTOBAHN
  };
}


// ======================================================
// VERFÜGBARE AUTOBAHNEN
// ======================================================

async function getAvailableRoads() {
  try {
    const response =
      await fetch(
        `${AUTOBAHN_API}/`
      );

    if (!response.ok) {
      return [];
    }

    const json =
      await response.json();

    return Array.isArray(json.roads)
      ? json.roads
      : [];

  } catch (error) {
    console.error(
      "Road list error:",
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

  if (
    !session ||
    !Array.isArray(session.reports)
  ) {
    await sendWhatsApp(
      from,
`Ich habe gerade keine vorherige Verkehrsanfrage gespeichert, bei der ich weitermachen kann.

Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“`,
      env
    );

    return;
  }

  if (session.allShown) {
    await sendWhatsApp(
      from,
      `Bei deiner letzten Abfrage wurden bereits alle gefundenen Meldungen angezeigt.`,
      env
    );

    return;
  }

  const remaining =
    session.reports.slice(
      PREVIEW_SIZE
    );

  if (!remaining.length) {
    session.allShown = true;

    await saveSession(
      from,
      session,
      env
    );

    await sendWhatsApp(
      from,
      `Bei deiner letzten Abfrage wurden bereits alle gefundenen Meldungen angezeigt.`,
      env
    );

    return;
  }

  await sendAllReports(
    from,
    remaining,
    session.sources || [],
    `Hier sind die weiteren ${remaining.length} ${
      remaining.length === 1
        ? "Meldung"
        : "Meldungen"
    } für die ${session.road}:`,
    env
  );

  session.allShown = true;

  await saveSession(
    from,
    session,
    env
  );
}


// ======================================================
// ALLE MELDUNGEN
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

  for (const report of reports) {
    const line =
      `• ${cleanText(report.title)}\n`;

    if (
      current.length +
      line.length >
      MAX_MESSAGE_LENGTH
    ) {
      if (current.trim()) {
        chunks.push(
          current.trim()
        );
      }

      current = "";
    }

    current += line;
  }

  if (current.trim()) {
    chunks.push(
      current.trim()
    );
  }

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    let message =
      chunks[i];

    if (chunks.length > 1) {
      message =
        `Teil ${i + 1}/${chunks.length}\n\n${message}`;
    }

    if (i === chunks.length - 1) {
      message +=
        `\n\n${shortSourceLine(sources)}`;
    }

    await sendWhatsApp(
      from,
      message,
      env
    );
  }
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
      : [SOURCE_AUTOBAHN];

  let answer =
`Meine Verkehrsmeldungen werden aus angebundenen Verkehrsdatenquellen abgerufen und nicht von der KI erfunden.

${sources.length === 1
  ? "Datenquelle:"
  : "Datenquellen:"}`;

  for (
    let i = 0;
    i < sources.length;
    i++
  ) {
    const source =
      sources[i];

    answer +=
`\n\n${i + 1}. ${source.name}
Anbieter: ${source.provider}
Webseite: ${source.website}
Datendienst: ${source.dataUrl}`;
  }

  answer +=
`\n\nDie KI hilft mir hauptsächlich dabei, normal formulierte Nachrichten zu verstehen. Aktuelle Verkehrsmeldungen werden aus den angebundenen Datenquellen abgerufen.`;

  await sendLongText(
    from,
    answer,
    env
  );
}


// ======================================================
// FRAGEN ÜBER DEN BOT
// ======================================================

async function answerAbout(
  from,
  text,
  env
) {

  if (
    text.includes("normal sprechen") ||
    text.includes("normal mit dir")
  ) {
    await sendWhatsApp(
      from,
`Ja, klar. Du kannst ganz normal mit mir schreiben.

Ich bin hauptsächlich für Verkehrsinformationen gedacht, kann aber auch Fragen über mich und meine Funktionen beantworten.`,
      env
    );

    return;
  }


  if (
    text.includes("was bist du") ||
    text.includes("wer bist du")
  ) {
    await sendWhatsApp(
      from,
`Ich bin ein von Pauli Schuberth erstellter Verkehrsbot, der dir bei Fragen zum Straßenverkehr in Deutschland helfen kann.

Ich kann aktuelle Verkehrsmeldungen zu Autobahnen abrufen und dir zum Beispiel Informationen zu Staus, Baustellen, Sperrungen und anderen Verkehrsstörungen anzeigen.

Für Bundesstraßen, Landes- und Staatsstraßen sowie Stadt- und Nebenstraßen stehen mir derzeit noch nicht ausreichend Verkehrs- und Vergleichsdaten zur Verfügung, um überall zuverlässige Auskünfte geben zu können.

Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“
„Gibt es Baustellen auf der A3?“
„Zeig mir alle Meldungen auf der A40.“

Wenn du wissen möchtest, woher meine Verkehrsdaten stammen, kannst du mich auch nach meinen Quellen fragen.`,
      env
    );

    return;
  }


  if (
    text.includes("wer hat dich erstellt") ||
    text.includes("wer hat dich gemacht") ||
    text.includes("von wem wurdest du erstellt")
  ) {
    await sendWhatsApp(
      from,
`Ich wurde von Pauli Schuberth als Verkehrsbot erstellt.

Ich soll dabei helfen, aktuelle Verkehrsinformationen einfach über WhatsApp abzufragen.`,
      env
    );

    return;
  }


  let answer =
`Ich bin ein WhatsApp-Verkehrsbot.

Technisch nutze ich unter anderem:

• Cloudflare Workers
• WhatsApp Cloud API
• Cloudflare Workers AI zum Verstehen frei formulierter Nachrichten
• angebundene Verkehrsdatenquellen

Die KI dient hauptsächlich dazu, deine Anfrage zu verstehen.

Aktuelle Verkehrsmeldungen werden aus den angebundenen Verkehrsdatenquellen abgerufen und nicht von der KI erfunden.

Du kannst mich zum Beispiel fragen:

„Was ist auf der A46 los?“
„Welche Baustellen gibt es auf der A3?“
„Woher hast du deine Daten?“`;

  if (env.CONTACT_EMAIL) {
    answer +=
      `\n\nBei Fragen oder Problemen:\n${env.CONTACT_EMAIL}`;
  }

  await sendWhatsApp(
    from,
    answer,
    env
  );
}


// ======================================================
// NORMALER CHAT MIT GESPRÄCHSKONTEXT
// ======================================================

async function normalChat(
  from,
  text,
  env
) {
  if (!env.AI) {
    await sendWhatsApp(
      from,
      `Du kannst ganz normal mit mir schreiben. Wie kann ich dir helfen?`,
      env
    );

    return;
  }

  try {
    const key =
      `chat:${from}`;

    let history = [];

    if (env.SESSIONS) {
      try {
        history =
          await env.SESSIONS.get(
            key,
            "json"
          ) || [];
      } catch (error) {
        console.error(
          "Chat history load error:",
          error
        );
      }
    }

    history =
      Array.isArray(history)
        ? history.slice(-8)
        : [];

    const messages = [
      {
        role: "system",
        content: `
Du bist der WhatsApp-Assistent von
Paulis Verkehrsservice.

SPRACHE:

Sprich den Nutzer immer mit "du" an.

Verwende nicht "Sie", "Ihnen", "Ihr"
oder andere förmliche Anreden,
außer der Nutzer verlangt ausdrücklich
eine förmliche Anrede.

Antworte natürlich und passend zur
konkreten Nachricht.

Bei einer einfachen Begrüßung wie
"Hallo", "Hi" oder "Hey" antworte kurz
und freundlich, zum Beispiel:
"Hallo! Wie kann ich dir helfen?"

Gib bei einer einfachen Begrüßung nicht
ungefragt eine lange Funktionsbeschreibung.

GESPRÄCHSKONTEXT:

Beziehe vorherige Nachrichten mit ein.

Wenn der Nutzer beispielsweise schreibt:

"Warum?"
"Warum Ihnen?"
"Was meinst du?"
"Wie meinst du das?"
"Und warum?"
"Das meine ich"

dann bezieht sich die Nachricht
möglicherweise auf deine vorherige Antwort.

Beantworte die Rückfrage im Zusammenhang
mit dem bisherigen Gespräch.

Beginne nicht unnötig wieder bei null.

Wenn du vorher versehentlich die Sie-Form
verwendet hast und der Nutzer darauf
hinweist, korrigiere dich kurz.

BEISPIELFRAGEN:

Wenn Beispiele sinnvoll sind, verwende
die Formulierung:

"Du kannst mich zum Beispiel fragen:"

Danach können passende Beispielfragen
folgen.

VERKEHR:

Du bist hauptsächlich ein Verkehrsbot
für Deutschland.

Aktuelle Verkehrsdaten, Staus,
Baustellen, Sperrungen und
Verkehrsstörungen darfst du niemals
erfinden.

Behaupte niemals, aktuelle Verkehrsdaten
abgerufen zu haben, wenn keine echte
Datenquelle abgefragt wurde.

Wenn aktuelle Verkehrsdaten benötigt
werden, bitte den Nutzer, eine Autobahn
zu nennen.

Für Bundesstraßen, Landes- und
Staatsstraßen sowie Stadt- und
Nebenstraßen stehen derzeit noch nicht
ausreichend Verkehrs- und Vergleichsdaten
zur Verfügung, um überall zuverlässige
Auskünfte geben zu können.

Wiederhole nicht bei jeder Nachricht
deine vollständige Funktionsbeschreibung.
`
      },

      ...history,

      {
        role: "user",
        content: text
      }
    ];

    const result =
      await env.AI.run(
        "@cf/meta/llama-3.1-8b-instruct-fast",
        {
          messages
        }
      );

    const answer =
      typeof result?.response === "string"
        ? result.response.trim()
        : "Wie kann ich dir helfen?";


    // Gespräch speichern
    if (env.SESSIONS) {
      const newHistory = [
        ...history,

        {
          role: "user",
          content: text
        },

        {
          role: "assistant",
          content: answer
        }

      ].slice(-8);

      try {
        await env.SESSIONS.put(
          key,
          JSON.stringify(newHistory),
          {
            expirationTtl: 1800
          }
        );

      } catch (error) {
        console.error(
          "Chat history save error:",
          error
        );
      }
    }

    await sendWhatsApp(
      from,
      answer,
      env
    );

  } catch (error) {
    console.error(
      "Normal chat error:",
      error
    );

    await sendWhatsApp(
      from,
      `Du kannst ganz normal mit mir schreiben. Wie kann ich dir helfen?`,
      env
    );
  }
}


// ======================================================
// VERKEHRS-SESSION SPEICHERN
// ======================================================

async function saveSession(
  from,
  session,
  env
) {
  if (!env.SESSIONS) {
    console.error(
      "KV Binding SESSIONS fehlt."
    );

    return;
  }

  try {
    await env.SESSIONS.put(
      `wa:${from}`,
      JSON.stringify(session),
      {
        expirationTtl: 1800
      }
    );

  } catch (error) {
    console.error(
      "Session save error:",
      error
    );
  }
}


async function loadSession(
  from,
  env
) {
  if (!env.SESSIONS) {
    return null;
  }

  try {
    return await env.SESSIONS.get(
      `wa:${from}`,
      "json"
    );

  } catch (error) {
    console.error(
      "Session load error:",
      error
    );

    return null;
  }
}


// ======================================================
// MELDUNGEN FORMATIEREN
// ======================================================

function buildTrafficTitle(item) {
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
    Array.isArray(item.description)
  ) {
    const description =
      item.description
        .filter(Boolean)
        .slice(0, 2)
        .join(" ");

    if (description) {
      parts.push(description);
    }
  }

  return cleanText(
    parts.join(" – ") ||
    "Verkehrsmeldung"
  );
}


function formatReports(reports) {
  return reports
    .map(
      report =>
        `• ${cleanText(report.title)}`
    )
    .join("\n");
}


// ======================================================
// QUELLENZEILE
// ======================================================

function shortSourceLine(sources) {
  if (
    !sources ||
    !sources.length
  ) {
    return "Quelle: angebundene Verkehrsdatenquelle";
  }

  if (sources.length === 1) {
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


// ======================================================
// DUPLIKATE
// ======================================================

function deduplicateReports(reports) {
  const seen = new Set();
  const result = [];

  for (const report of reports) {
    const key =
      normalizeSearch(
        report.title
      );

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(report);
  }

  return result;
}


function uniqueSources(sources) {
  const map = new Map();

  for (const source of sources) {
    map.set(
      source.id,
      source
    );
  }

  return [...map.values()];
}


// ======================================================
// LANGE WHATSAPP-NACHRICHTEN
// ======================================================

async function sendLongText(
  to,
  text,
  env
) {
  if (
    text.length <=
    MAX_MESSAGE_LENGTH
  ) {
    await sendWhatsApp(
      to,
      text,
      env
    );

    return;
  }

  const lines =
    text.split("\n");

  const chunks = [];
  let current = "";

  for (const line of lines) {
    const addition =
      `${line}\n`;

    if (
      current.length +
      addition.length >
      MAX_MESSAGE_LENGTH
    ) {
      if (current.trim()) {
        chunks.push(
          current.trim()
        );
      }

      current = "";
    }

    current += addition;
  }

  if (current.trim()) {
    chunks.push(
      current.trim()
    );
  }

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    let message =
      chunks[i];

    if (chunks.length > 1) {
      message =
        `Teil ${i + 1}/${chunks.length}\n\n${message}`;
    }

    await sendWhatsApp(
      to,
      message,
      env
    );
  }
}


// ======================================================
// WHATSAPP SENDEN
// ======================================================

async function sendWhatsApp(
  to,
  text,
  env
) {
  if (
    !env.WHATSAPP_TOKEN ||
    !env.PHONE_NUMBER_ID
  ) {
    console.error(
      "WHATSAPP_TOKEN oder PHONE_NUMBER_ID fehlt."
    );

    return;
  }

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
              preview_url: false,
              body: String(text)
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

function normalizeInput(text) {
  return String(text)
    .toLowerCase()
    .replace(/[?!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function normalizeSearch(text) {
  return String(text)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(
      /[^\p{L}\p{N}]/gu,
      ""
    );
}


function normalizeRoad(road) {
  return String(road)
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}


function cleanText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}


// ======================================================
// QUELLENFRAGEN
// ======================================================

function isSourceQuestion(text) {
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
      "welche quellen"
    ) ||
    text.includes(
      "welche api"
    ) ||
    text.includes(
      "welche apis"
    ) ||
    text.includes(
      "sind die daten erfunden"
    ) ||
    text.includes(
      "sind die meldungen erfunden"
    )
  );
}


// ======================================================
// BOT-FRAGEN
// ======================================================

function isAboutQuestion(text) {
  return (
    text.includes(
      "was bist du"
    ) ||
    text.includes(
      "wer bist du"
    ) ||
    text.includes(
      "wer hat dich erstellt"
    ) ||
    text.includes(
      "wer hat dich gemacht"
    ) ||
    text.includes(
      "von wem wurdest du erstellt"
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
