const enabled = Deno.env.get("VILLIFE_LIVE") === "1";
const searchBase = Deno.env.get("VILLIFE_SEARCH") || "https://villife-search.telesamafia.workers.dev";
const catalogBase = Deno.env.get("VILLIFE_CATALOG") || "https://villife-catalog.telesamafia.workers.dev";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "live search worker health",
  ignore: !enabled,
  async fn() {
    const response = await fetch(searchBase + "/warm");
    check(response.status === 200, "search warm status");
    check(response.headers.get("X-Villife-Worker") === "7", "search version");
  }
});

Deno.test({
  name: "live search returns tracks",
  ignore: !enabled,
  async fn() {
    const response = await fetch(searchBase + "/search?q=test");
    check(response.status === 200, "search status");
    const data = await response.json();
    check(Array.isArray(data), "search body");
  }
});

Deno.test({
  name: "live image range",
  ignore: !enabled,
  async fn() {
    const search = await fetch(searchBase + "/search?q=test");
    const tracks = await search.json();
    const artwork = tracks[0] && tracks[0].artwork;
    check(!!artwork, "artwork available");
    const response = await fetch(artwork, { headers: { Range: "bytes=0-99" } });
    check(response.status === 206, "image range status");
    check(response.headers.get("Content-Range"), "content range");
  }
});

Deno.test({
  name: "live catalog health",
  ignore: !enabled,
  async fn() {
    const response = await fetch(catalogBase + "/health");
    check(response.status === 200, "catalog health status");
    const data = await response.json();
    check(data.ready === true && data.db === true && data.r2 === true, "catalog bindings");
  }
});

Deno.test({
  name: "live catalog public catalog",
  ignore: !enabled,
  async fn() {
    const response = await fetch(catalogBase + "/search?q=test");
    check(response.status === 200, "catalog search status");
    const data = await response.json();
    check(Array.isArray(data.tracks), "catalog search body");
  }
});

Deno.test({
  name: "live catalog hides admin routes",
  ignore: !enabled,
  async fn() {
    const response = await fetch(catalogBase + "/releases");
    check(response.status === 403, "catalog admin status");
  }
});
