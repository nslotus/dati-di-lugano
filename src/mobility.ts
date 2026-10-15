// Public transport and bike sharing in Lugano, from the operators' and the City's own releases.
// Same pattern as schools.ts (TypeSafe pre-parsed value extraction): code lists every number with its context,
// Jev picks one candidate per field, code copies the printed value. Checks that stop the run:
//   TPL:       total − bus passengers ≈ funicular passengers (printed as "oltre 3.1 milioni": between 3.1M and 3.2M)
//   PubliBike: e-bikes + standard bikes = bikes in the renewed fleet
//
//   TYPESAFE_API_KEY=... npm run mobility   → out/mobility.json

import pdf from "pdf-parse/lib/pdf-parse.js";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MODEL, cached } from "./figures";
import { numberCandidates } from "./schools";

const NONE = "none";
const MIN_CONFIDENCE = 0.8;

type Field = { key: string; ask: string; scale?: number };
const DOCS: { id: string; year: number; publisher: string; file: string; url: string; document: string; fields: Field[] }[] = [
  { id: "tpl", year: 2025, publisher: "TPL – Trasporti Pubblici Luganesi SA", file: "sources/tpl-cs-assemblea-2026.pdf",
    url: "https://www.tplsa.ch/repository/pdf/125163517-CS_Assembleaazionisti2026_TPL.pdf",
    document: "TPL (Trasporti Pubblici Luganesi SA) – press release of the 2026 general meeting, on the 2025 financial year.",
    fields: [
      { key: "totalPassengers", ask: "Which candidate is the total number of passengers TPL carried in 2025?" },
      { key: "busPassengers", ask: "Which candidate is the number of passengers (users) on TPL's bus lines (linee su gomma) in 2025?" },
      { key: "funicularMillions", ask: "Which candidate is the number of passengers of the Funicolare Lugano–Stazione in 2025, given in millions?", scale: 1e6 },
      { key: "growthPct", ask: "Which candidate is the percentage increase of TPL's total passengers compared with 2024?" },
    ] },
  { id: "publibike", year: 2024, publisher: "Città di Lugano", file: "sources/20250805-rete-bikesharing.pdf",
    url: "https://www.lugano.ch/dam/jcr:fde47d24-6fc7-4ce2-9e73-cef2b0aa0ab7/20250805-cs-rete-bikesharing.pdf",
    document: "City of Lugano – press release of 5 August 2025 on the renewal of the bike-sharing network (PubliBike).",
    fields: [
      { key: "rentals2024", ask: "Which candidate is the number of bike-sharing rentals (movimentazioni) recorded in 2024?" },
      { key: "bikesBefore", ask: "Which candidate is the number of bikes in the fleet before the renewal?" },
      { key: "bikesAfter", ask: "Which candidate is the total number of bikes in the renewed fleet?" },
      { key: "eBikes", ask: "Which candidate is the number of e-bikes in the renewed fleet?" },
      { key: "standardBikes", ask: "Which candidate is the number of standard (muscle-powered) bikes in the renewed fleet?" },
      { key: "lightStations", ask: "Which candidate is the number of new 'light' stations introduced?" },
      { key: "netCostNow", ask: "Which candidate is the City's current net yearly cost of the bike-sharing service, in francs?" },
      { key: "netCost2027", ask: "Which candidate is the City's net yearly cost of the service from 2027, in francs?" },
    ] },
];

async function main() {
  if (!process.env.TYPESAFE_API_KEY && !existsSync("data/cache/typesafe.json")) throw new Error("Set TYPESAFE_API_KEY — mobility.ts calls Jev.");
  const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "cache-only" });
  const results = [];
  for (const d of DOCS) {
    const cands = numberCandidates((await pdf(readFileSync(d.file))).text);
    const labels = Object.fromEntries([...cands.map((c) => [c.id, null]), [NONE, "None of the candidates is this figure."]]);
    const req = { model: MODEL, state: { document: d.document, candidates: cands.map(({ id, raw, context }) => ({ id, number: raw, context })) },
      questions: Object.fromEntries(d.fields.map((f) => [f.key, choice(f.ask, labels)])) };
    const picked = await cached(req, async () => {
      const res = await client.systemOne(req);
      return { model: res.model, usage: res.usage, answers: Object.fromEntries(Object.entries(res.answers).map(([k, a]) => {
        const c = a as { choice: string; confidence: number }; return [k, { choice: c.choice, confidence: c.confidence }];
      })) as Record<string, { choice: string; confidence: number }> };
    });
    const fig: Record<string, { value: number | null; raw: string | null; confidence: number; context: string | null }> = {};
    for (const f of d.fields) {
      const a = picked.answers[f.key], c = cands.find((x) => x.id === a.choice);
      fig[f.key] = { value: c ? c.value * (f.scale ?? 1) : null, raw: c?.raw ?? null, confidence: Number(a.confidence.toFixed(3)), context: c?.context ?? null };
    }
    const v = (k: string) => fig[k]?.value ?? null;
    const checks: Record<string, boolean | null> = d.id === "tpl"
      ? { funicularFits: v("totalPassengers") !== null && v("busPassengers") !== null && v("funicularMillions") !== null
          ? (() => { const f = v("totalPassengers")! - v("busPassengers")!; return f >= v("funicularMillions")! && f < v("funicularMillions")! + 0.1e6; })() : null }
      : { fleetAddsUp: v("bikesAfter") !== null && v("eBikes") !== null && v("standardBikes") !== null ? v("eBikes")! + v("standardBikes")! === v("bikesAfter") : null };
    const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
    if (failed.length) throw new Error(`CHECK FAILED ${d.id}: ${failed.join(", ")} — ${JSON.stringify(Object.fromEntries(Object.entries(fig).map(([k, f]) => [k, f.raw])))}`);
    const covered = d.id === "tpl" ? ["totalPassengers", "busPassengers", "funicularMillions"] : ["bikesAfter", "eBikes", "standardBikes"];
    const status = Object.fromEntries(Object.keys(fig).map((k) => [k, fig[k].value === null ? "none"
      : fig[k].confidence >= MIN_CONFIDENCE || covered.includes(k) ? "accepted" : "review"]));
    results.push({ id: d.id, year: d.year, publisher: d.publisher, source: d.url, archived: d.file, model: picked.model, candidates: cands.length, usage: picked.usage, figures: fig, checks, status });
  }
  mkdirSync("out", { recursive: true });
  writeFileSync("out/mobility.json", JSON.stringify({ generatedAt: new Date().toISOString(), minConfidence: MIN_CONFIDENCE,
    method: "TypeSafe pre-parsed value extraction from TPL's and the City's releases; checks: total − bus = funicular (printed as a lower bound in millions), e-bikes + standard bikes = fleet.", results }, null, 2) + "\n");
  for (const r of results) {
    console.log(`\n${r.id} ${r.year}  (${r.candidates} candidates, ${r.usage?.input_tokens ?? "?"} tokens, ${r.model})`);
    for (const [k, f] of Object.entries(r.figures)) console.log(`  ${k.padEnd(18)} ${String(f.raw ?? "—").padStart(11)}  ${r.status[k].padEnd(8)} conf ${f.confidence.toFixed(2)}`);
    console.log(`  checks: ${Object.entries(r.checks).map(([k, ok]) => `${k} ${ok ? "✓" : "✗"}`).join(" · ")}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
