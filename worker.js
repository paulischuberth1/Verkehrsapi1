export default {
  async fetch(request) {
    const url = new URL(request.url);

    const autobahn = (url.searchParams.get("autobahn") || "A3")
      .toUpperCase()
      .replace(/\s/g, "");

    if (!/^A\d{1,3}$/.test(autobahn)) {
      return Response.json({
        fehler: "Ungültige Autobahn",
        beispiele: ["?autobahn=A3", "?autobahn=A46"]
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
          const meldungen = Array.isArray(data[endpoint])
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
        .reduce((sum, k) => sum + (k.anzahl || 0), 0);

      return Response.json({
        autobahn,
        gesamt,
        ...ergebnisse
      });

    } catch (error) {
      return Response.json({
        fehler: "Verkehrsdaten konnten nicht geladen werden",
        details: error.message
      }, { status: 502 });
    }
  }
};
