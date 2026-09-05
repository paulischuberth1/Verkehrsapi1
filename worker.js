export default {
  async fetch(request) {
    const url = new URL(request.url);

    const autobahn = (url.searchParams.get("autobahn") || "A3")
      .toUpperCase()
      .replace(/\s/g, "");

    if (!/^A\d{1,3}$/.test(autobahn)) {
      return Response.json({
        fehler: "Ungültige Autobahn",
        beispiel: "?autobahn=A46"
      }, { status: 400 });
    }

    try {
      const api =
        `https://verkehr.autobahn.de/o/autobahn/${autobahn}/services/warning`;

      const response = await fetch(api);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      return new Response(JSON.stringify(data, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      });
    } catch (error) {
      return Response.json({
        fehler: "Verkehrsdaten konnten nicht geladen werden",
        details: error.message
      }, { status: 502 });
    }
  }
};
