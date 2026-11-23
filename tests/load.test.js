const enabled = Deno.env.get("VILLIFE_LOAD") === "1";
const base = Deno.env.get("VILLIFE_LOAD_TARGET") || "https://villife-search-staging.telesamafia.workers.dev";
const total = Number(Deno.env.get("VILLIFE_LOAD_REQUESTS") || 50);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "load: parallel warm requests",
  ignore: !enabled,
  async fn() {
    const responses = await Promise.all(Array.from({ length: total }, () => fetch(base + "/warm")));
    const ok = responses.filter(response => response.status === 200).length;
    check(ok === total, "all warm requests succeeded: " + ok + "/" + total);
  }
});

Deno.test({
  name: "load: parallel search requests",
  ignore: !enabled,
  async fn() {
    const responses = await Promise.all(Array.from({ length: Math.min(total, 20) }, (_, index) => fetch(base + "/search?q=load" + index)));
    const ok = responses.filter(response => response.status === 200).length;
    check(ok === Math.min(total, 20), "all search requests succeeded: " + ok);
  }
});
