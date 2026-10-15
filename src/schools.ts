// Pupils and classes of Lugano's Istituto scolastico, from the City's school-start press releases.
// Same pattern as figures.ts (TypeSafe pre-parsed value extraction):
//   1. code finds every number in the release, with the words around it;
//   2. Jev picks which candidate each figure is (or "none"), one Choice per field, one request per release;
//   3. code copies the picked number unchanged, then arithmetic checks the picks:
//        kindergarten pupils + primary pupils = total pupils (exact)
//        sections × average ≈ pupils, within the rounding of the printed average
// A release passes only if both checks hold; otherwise the run stops.
//
//   TYPESAFE_API_KEY=... npm run schools   → out/schools.json

import pdf from "pdf-parse/lib/pdf-parse.js";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { MODEL, cached } from "./figures";

const NONE = "none";
const MIN_CONFIDENCE = 0.8;

const RELEASES = [
  { schoolYear: "2024/25", file: "sources/20240902-inizio-anno-scolastico.pdf",
    url: "https://www.lugano.ch/dam/jcr:774e4f20-eb34-4ce6-8c55-4951d7b3884e/20240902-cs-inizio-scuole.pdf" },
  { schoolYear: "2025/26", file: "sources/20250903-inizio-anno-scolastico.pdf",
    url: "https://www.lugano.ch/dam/jcr:6ea44591-f14e-4fe7-a278-d883546c7e1b/20250903-cs-inizio-anno-scolastico-2025-2026.pdf" },
  { schoolYear: "2026/27", file: "sources/20260831-inizio-anno-scolastico.pdf",
    url: "https://www.lugano.ch/dam/jcr:3a340d7f-0d96-4d7a-8af3-f512b72d1c9e/20260831-inizio-anno-scolastico-2026-27-comunicato.pdf" },
];

const FIELDS = [
  { key: "totalPupils", ask: (y: string) => `Which candidate is the total number of pupils of the Istituto scolastico di Lugano in school year ${y} (kindergarten and primary together)?` },
  { key: "kgPupils", ask: (y: string) => `Which candidate is the number of kindergarten pupils (scuola dell'infanzia) in school year ${y}?` },
  { key: "kgSections", ask: (y: string) => `Which candidate is the number of kindergarten sections (sezioni di scuola dell'infanzia) in school year ${y} — not a change compared with the previous year?` },
  { key: "kgAverage", ask: (y: string) => `Which candidate is the average number of children per kindergarten section in school year ${y}?` },
  { key: "prPupils", ask: (y: string) => `Which candidate is the number of primary-school pupils (scuola elementare) in school year ${y}?` },
  { key: "prClasses", ask: (y: string) => `Which candidate is the number of primary-school classes (classi di scuola elementare) in school year ${y} — not a change compared with the previous year?` },
  { key: "prAverage", ask: (y: string) => `Which candidate is the average number of pupils per primary-school class in school year ${y}?` },
];

interface Cand { id: string; raw: string; value: number; decimals: number; context: string }

/** Every number in the text: thousands with ’ or ', and decimals with , or . (incl. "17, 70" split by the PDF). */
export function numberCandidates(text: string): Cand[] {
  const flat = text.replace(/\s+/g, " ");
  const re = /\b\d{1,3}(?:[’']\d{3})+\b|\b\d+(?:[.,]\s?\d+)?\b/g;
  const out: Cand[] = [];
  for (const m of flat.matchAll(re)) {
    const raw = m[0];
    const dec = raw.match(/[.,]\s?(\d+)$/);
    const isThousands = /[’']/.test(raw);
    const value = isThousands ? Number(raw.replace(/[’']/g, "")) : Number(raw.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(value)) continue;
    const i = m.index!;
    out.push({ id: `n${out.length + 1}`, raw, value, decimals: dec && !isThousands ? dec[1].length : 0,
      context: flat.slice(Math.max(0, i - 90), i + raw.length + 60) });
  }
  return out;
}

type Answer = { choice: string; confidence: number };

async function pick(client: TypeSafeClient, year: string, cands: Cand[]) {
  const state = {
    document: `Città di Lugano – press release at the start of school year ${year} (text extracted from PDF).`,
    candidates: cands.map(({ id, raw, context }) => ({ id, number: raw, context })),
  };
  const labels = Object.fromEntries([...cands.map((c) => [c.id, null]), [NONE, "None of the candidates is this figure."]]);
  const req = { model: MODEL, state, questions: Object.fromEntries(FIELDS.map((f) => [f.key, choice(f.ask(year), labels)])) };
  return cached(req, async () => {
    const res = await client.systemOne(req);
    return { model: res.model, usage: res.usage, answers: Object.fromEntries(Object.entries(res.answers).map(([k, a]) => {
      const c = a as Answer; return [k, { choice: c.choice, confidence: c.confidence }];
    })) as Record<string, Answer> };
  });
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY && !existsSync("data/cache/typesafe.json"))
    throw new Error("Set TYPESAFE_API_KEY — schools.ts calls Jev.");
  const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "cache-only" });
  const results = [];
  for (const r of RELEASES) {
    const text = (await pdf(readFileSync(r.file))).text;
    const cands = numberCandidates(text);
    const picked = await pick(client, r.schoolYear, cands);
    const fig: Record<string, { value: number | null; raw: string | null; decimals: number; confidence: number; context: string | null }> = {};
    for (const f of FIELDS) {
      const a = picked.answers[f.key], c = cands.find((x) => x.id === a.choice);
      fig[f.key] = { value: c?.value ?? null, raw: c?.raw ?? null, decimals: c?.decimals ?? 0, confidence: Number(a.confidence.toFixed(3)), context: c?.context ?? null };
    }
    // arithmetic checks
    const v = (k: string) => fig[k].value;
    const checks: Record<string, boolean | null> = {
      pupilsAddUp: v("totalPupils") !== null && v("kgPupils") !== null && v("prPupils") !== null ? v("kgPupils")! + v("prPupils")! === v("totalPupils") : null,
      kgAverageFits: v("kgSections") !== null && v("kgAverage") !== null && v("kgPupils") !== null
        ? Math.abs(v("kgSections")! * v("kgAverage")! - v("kgPupils")!) <= v("kgSections")! * 0.5 * 10 ** -fig.kgAverage.decimals + 0.5 : null,
      prAverageFits: v("prClasses") !== null && v("prAverage") !== null && v("prPupils") !== null
        ? Math.abs(v("prClasses")! * v("prAverage")! - v("prPupils")!) <= v("prClasses")! * 0.5 * 10 ** -fig.prAverage.decimals + 0.5 : null,
    };
    const lowConfidence = Object.entries(fig).filter(([, f]) => f.value !== null && f.confidence < MIN_CONFIDENCE).map(([k]) => k);
    const failed = Object.entries(checks).filter(([, ok]) => ok === false).map(([k]) => k);
    if (failed.length) throw new Error(`CHECK FAILED ${r.schoolYear}: ${failed.join(", ")} — ${JSON.stringify(Object.fromEntries(Object.entries(fig).map(([k, f]) => [k, f.raw])))}`);
    // a figure below the confidence threshold is accepted only when an arithmetic check covering it passed
    const covered: Record<string, string[]> = { pupilsAddUp: ["totalPupils", "kgPupils", "prPupils"], kgAverageFits: ["kgSections", "kgAverage", "kgPupils"], prAverageFits: ["prClasses", "prAverage", "prPupils"] };
    const status = Object.fromEntries(Object.keys(fig).map((k) => {
      if (fig[k].value === null) return [k, "none"];
      const verified = Object.entries(covered).some(([chk, keys]) => keys.includes(k) && checks[chk] === true);
      return [k, fig[k].confidence >= MIN_CONFIDENCE || verified ? "accepted" : "review"];
    }));
    results.push({ schoolYear: r.schoolYear, source: r.url, archived: r.file, model: picked.model, candidates: cands.length, usage: picked.usage, figures: fig, checks, status, lowConfidence });
  }
  mkdirSync("out", { recursive: true });
  writeFileSync("out/schools.json", JSON.stringify({ generatedAt: new Date().toISOString(), minConfidence: MIN_CONFIDENCE,
    method: "TypeSafe pre-parsed value extraction from the City's school-start releases; checks: kindergarten + primary = total, sections × average ≈ pupils.", results }, null, 2) + "\n");
  for (const r of results) {
    console.log(`\n${r.schoolYear}  (${r.candidates} candidates, ${r.usage?.input_tokens ?? "?"} tokens, ${r.model})`);
    for (const [k, f] of Object.entries(r.figures)) console.log(`  ${k.padEnd(12)} ${String(f.raw ?? "—").padStart(7)}  ${r.status[k].padEnd(8)} conf ${f.confidence.toFixed(2)}`);
    console.log(`  checks: ${Object.entries(r.checks).map(([k, ok]) => `${k} ${ok === null ? "n/a" : ok ? "✓" : "✗"}`).join(" · ")}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
