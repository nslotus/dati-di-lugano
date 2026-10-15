// Headline figures from the city's own accounts PDFs, using TypeSafe "pre-parsed value extraction":
//   1. code finds every amount in the PDF text, with its line, neighbours and column position;
//   2. Jev picks which candidate id is each requested figure (or "none"), one Choice per field,
//      all fields in one request;
//   3. code copies the picked number verbatim. The model selects, it never types a number.
// This fills what the cantonal annex can't: the latest year (2025) and post-year-end debt (Q1 2026).
// The 2024 deck is scored against the annex (ground truth) so the picks are measurable.
//
//   TYPESAFE_API_KEY=... npm run figures

import pdf from "pdf-parse/lib/pdf-parse.js";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseAnnex } from "./annex";

export const MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.14.0";
const MIN_CONFIDENCE = 0.8; // on pooled value probability; tuned against the 2024 validation below
const NONE = "none";
const CACHE = "data/cache/typesafe.json";

type Kind = "consuntivo" | "preventivo";

const DOCS: { kind: Kind; year: number; file: string; url: string }[] = [
  { kind: "consuntivo", year: 2024, file: "data/raw/city-consuntivo-2024-slides.pdf",
    url: "https://www.lugano.ch/dam/jcr:66e7b5df-519e-4fcb-83aa-a9db062b7081/20250404-cs-consuntivo-2024-presentazione.pdf" },
  { kind: "consuntivo", year: 2025, file: "data/raw/city-consuntivo-2025-slides.pdf",
    url: "https://www.lugano.ch/dam/jcr:8e5c3ada-87b4-4397-a3c7-e55dd4a9199a/20260423-consuntivo-2025-presentazione.pdf" },
  { kind: "preventivo", year: 2026, file: "data/raw/city-preventivo-2026-comunicato.pdf",
    url: "https://www.lugano.ch/dam/jcr:0a793cce-fba0-4c83-b596-e65560732832/20251023-cs-preventivo-2026-piano-finanziario-2026-2033.pdf" },
];

interface Field {
  key: string;
  ask: (y: number) => string;
  /** header in the SEL annex (CHF thousands) used to score the pick, where one exists */
  annexKey?: [section: "contoEconomico" | "investimentiEFinanziamento", re: RegExp];
  /** the document states it as a positive "disavanzo" amount; stored negative */
  deficit?: true;
}

const READING_GUIDE: Record<Kind, string> = {
  consuntivo: "In the recap tables each row lists, in order: actual (consuntivo), budget (preventivo), difference, percent. " +
    "`rowLabel` is the table row an amount belongs to and `positionInRow` its position in that row (1 = consuntivo, 2 = preventivo, " +
    "3 = difference). Short labels like C2024 mean consuntivo 2024, P2025 means preventivo 2025, T1/2026 means first quarter 2026.",
  preventivo: "A press release in prose. Bullet points give the budget figure first, often followed by a comparison in brackets " +
    "with an earlier budget or consuntivo; the comparison is not the budget figure. `rowLabel` is the text before the amount on its line.",
};

// preventivo: budget for the year plus the multi-year financial plan announced with it
const PREVENTIVO_FIELDS: Field[] = [
  { key: "risultatoEsercizio", deficit: true,
    ask: (y) => `Which candidate is the budgeted operating deficit (disavanzo d'esercizio / di gestione corrente) for ${y} — not the ${y - 1} budget or the ${y - 2} consuntivo given for comparison?` },
  { key: "investimentiNetti",
    ask: (y) => `Which candidate is the budgeted net investment (investimenti netti) for ${y} alone — not the multi-year plan total?` },
  { key: "autofinanziamento",
    ask: (y) => `Which candidate is the budgeted self-financing (autofinanziamento) for ${y} — not the previous budget's figure?` },
  { key: "risultatoGlobale",
    ask: (y) => `Which candidate is the budgeted overall financing result (risultato globale) for ${y} — the amount the city must borrow — not a figure given for comparison?` },
  { key: "disinvestimentiPiano",
    ask: () => `Which candidate is the total planned income from asset sales or revaluations (disinvestimenti / rivalorizzazioni di beni patrimoniali) over the financial plan?` },
  { key: "debitoDopoInvestimenti",
    ask: (y) => `The plan describes the debt first reaching a level as a direct consequence of the ${y} investments, and only later climbing further to its maximum. Which candidate is that first level caused by the ${y} investments — not the later maximum and not the end-of-plan value?` },
  { key: "debitoPiccoPiano",
    ask: () => `Which candidate is the peak (maximum) financial debt foreseen by the financial plan?` },
  { key: "debitoFinePiano",
    ask: () => `Which candidate is the financial debt foreseen at the end of the financial plan, after the peak?` },
];

const CONSUNTIVO_FIELDS: Field[] = [
  { key: "risultatoTotaleEsercizio", annexKey: ["contoEconomico", /RISULTATO TOTALE/i],
    ask: (y) => `Which candidate is the city's actual total operating result (risultato totale d'esercizio) for ${y}, as closed in the consuntivo — not the budget (preventivo) figure and not the difference between them?` },
  { key: "risultatoGlobale", annexKey: ["investimentiEFinanziamento", /RISULTATO GLOBALE/i],
    ask: (y) => `Which candidate is the actual overall financing result (risultato globale) for ${y} in the consuntivo — not the budget figure and not the difference?` },
  { key: "autofinanziamento", annexKey: ["investimentiEFinanziamento", /Autofinanziamento/i],
    ask: (y) => `Which candidate is the actual self-financing amount in francs (autofinanziamento) for ${y} in the consuntivo — not a percentage, not the budget, not the difference?` },
  { key: "usciteInvestimenti", annexKey: ["investimentiEFinanziamento", /Uscite per investimenti/i],
    ask: (y) => `Which candidate is the actual gross investment spending (uscite per investimenti) for ${y} in the consuntivo — not the budget and not the difference?` },
  { key: "onereNettoInvestimenti", annexKey: ["investimentiEFinanziamento", /ONERE NETTO/i],
    ask: (y) => `Which candidate is the actual net investment burden (onere netto per investimenti / investimenti netti) for ${y} in the consuntivo — not the budget and not the difference?` },
  { key: "debitoLordoFineAnno",
    ask: (y) => `Which candidate is the city's total gross financial debt (short plus long term, breve e lungo termine) at the end of ${y}, given as one single figure? If the document only shows short- and long-term debt separately, answer none.` },
  { key: "liquiditaFineAnno",
    ask: (y) => `Which candidate is the city's cash and term deposits (cassa e depositi) at the end of ${y}?` },
  { key: "debitoNettoFineAnno",
    ask: (y) => `Which candidate is the city's net debt (indebitamento netto: gross debt minus cash and deposits) at the end of ${y}?` },
  { key: "debitoLordoAnnoPrecedente",
    ask: (y) => `The document may restate the previous year-end for comparison, labelled like C${y - 1}. Which candidate is the gross debt (breve/lungo termine) at the end of ${y - 1}? Answer none if no previous-year comparison is given.` },
  { key: "liquiditaAnnoPrecedente",
    ask: (y) => `The document may restate the previous year-end for comparison, labelled like C${y - 1}. Which candidate is cash and deposits (cassa/depositi) at the end of ${y - 1}? Answer none if no previous-year comparison is given.` },
  { key: "debitoNettoAnnoPrecedente",
    ask: (y) => `The document may restate the previous year-end for comparison, labelled like C${y - 1}. Which candidate is net debt (netto) at the end of ${y - 1}? Answer none if no previous-year comparison is given.` },
  { key: "debitoLordoTrimestreSuccessivo",
    ask: (y) => `The document may report debt at a quarter-end after ${y}, such as T1/${y + 1}. Which candidate is that later quarter's total gross debt (breve/lungo termine)? Answer none if no such later figure is given.` },
  { key: "debitoNettoTrimestreSuccessivo",
    ask: (y) => `The document may report debt at a quarter-end after ${y}, such as T1/${y + 1}. Which candidate is that later quarter's net debt (netto)? Answer none if no such later figure is given.` },
];

interface Candidate {
  id: string; raw: string; chf: number; unit: "CHF" | "CHF million"; line: string; before: string[];
  /** Text label of the table row this amount belongs to, and its position among that row's amounts.
   *  Works for both layouts: "Label 1’000.00 2’000.00" on one line, or label then one amount per line. */
  rowLabel: string; positionInRow: number;
  /** half the last printed digit, in CHF: 1’356 milioni ±0.5M, 23.7 Mio ±0.05M, exact francs ±1 */
  tol: number;
}

const EXACT = /-?\d{1,3}(?:[’']\d{3})+\.\d{2}/g; // 473’565’042.50 (also splits run-together columns)
const MIO = /-?\s?\d{1,3}(?:[’']\d{3})*(?:\.\d+)?(?=\s*(?:Mio|mio|milioni))|(?<=CHF\s*)-?\d{1,3}(?:[’']\d{3})*\.\d(?![\d’'])/g; // CHF 23.7 Mio, - 24.0 Mio, CHF1’049.9 Mio, 1'356 milioni, CHF 201.8
const FIELDS_BY_KIND: Record<Kind, Field[]> = { consuntivo: CONSUNTIVO_FIELDS, preventivo: PREVENTIVO_FIELDS };

const toNumber = (raw: string) => Number(raw.replace(/[’'\s]/g, ""));

export function findCandidates(text: string): Candidate[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Candidate[] = [];
  let rowLabel = "", positionInRow = 0;
  lines.forEach((line, i) => {
    const exact = [...line.matchAll(EXACT)].map((m) => ({ raw: m[0], unit: "CHF" as const, at: m.index! }));
    const mio = exact.length ? [] : [...line.matchAll(MIO)].map((m) => ({ raw: m[0].trim(), unit: "CHF million" as const, at: m.index! }));
    const found = [...exact, ...mio];
    const text = (found.length ? line.slice(0, found[0].at) : line).replace(/[\d’'.,%+\-\s]+$/, "").trim();
    // a line with words starts a new row; a bare amount line continues the current row
    if (/[A-Za-zà-ù]{3,}/.test(text)) { rowLabel = text; positionInRow = 0; }
    found.forEach((f) => out.push({
      id: `c${out.length + 1}`, raw: f.raw, unit: f.unit,
      chf: Math.round(toNumber(f.raw) * (f.unit === "CHF million" ? 1e6 : 100)) / (f.unit === "CHF million" ? 1 : 100),
      line, before: lines.slice(Math.max(0, i - 3), i), rowLabel, positionInRow: ++positionInRow,
      tol: f.unit === "CHF" ? 1 : 0.5 * 10 ** -(f.raw.split(".")[1]?.length ?? 0) * 1e6,
    }));
  });
  return out;
}

// --- cached TypeSafe call: re-runs cost nothing unless the state or questions change ---
export function cached<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const store: Record<string, T> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  if (key in store) return Promise.resolve(store[key]);
  return run().then((v) => {
    mkdirSync("data/cache", { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ ...store, [key]: v }, null, 1));
    return v;
  });
}

async function pickFigures(client: TypeSafeClient, kind: Kind, year: number, cands: Candidate[], text: string) {
  const state = {
    document: kind === "consuntivo"
      ? `Città di Lugano – Consuntivo ${year}, press-conference slides (text extracted from PDF; table columns may run together).`
      : `Città di Lugano – Preventivo ${year} and financial plan, press release (text extracted from PDF).`,
    readingGuide: READING_GUIDE[kind],
    candidates: cands.map(({ id, raw, unit, line, before, rowLabel, positionInRow }) =>
      ({ id, amount: raw, unit, rowLabel, positionInRow, line, precedingLines: before })),
  };
  const labels = Object.fromEntries([...cands.map((c) => [c.id, null]), [NONE, "None of the candidates is this figure."]]);
  const questions: Record<string, ReturnType<typeof choice>> =
    Object.fromEntries(FIELDS_BY_KIND[kind].map((f) => [f.key, choice(f.ask(year), labels)]));
  if (kind === "preventivo") {
    // select-don't-generate for the year too: options are the years printed in the release
    const years = [...new Set(text.match(/\b20[2-4]\d\b/g) ?? [])].sort();
    const yearLabels = Object.fromEntries([...years.map((y) => [y, null]), [NONE, "The text does not say."]]);
    Object.assign(state, { text: text.replace(/\s+/g, " ").trim() });
    questions.annoPiccoDebito = choice("According to the text, in which year does the financial plan expect the city's financial debt to peak?", yearLabels);
    questions.annoFinePiano = choice("According to the text, which year is the last year of the financial plan?", yearLabels);
  }
  const req = { model: MODEL, state, questions };
  return cached(req, async () => {
    const res = await client.systemOne(req);
    return { model: res.model, usage: res.usage,
      answers: Object.fromEntries(Object.entries(res.answers).map(([k, a]) => {
        const c = a as { choice: string; confidence: number; probabilities: Record<string, number> };
        return [k, { choice: c.choice, confidence: c.confidence, probabilities: c.probabilities }];
      })) as Record<string, Answer> };
  });
}

type Answer = { choice: string; confidence: number; probabilities: Record<string, number> };

/** Same figure printed twice (table 23’734’916.92 and summary "CHF 23.7 Mio") splits probability across
 *  equivalent candidates. Pool probability per value, so confidence is about the number, not the occurrence. */
export function resolveByValue(a: Answer, cands: Candidate[]) {
  const same = (x: Candidate, y: Candidate) =>
    Math.abs(x.chf - y.chf) <= Math.max(x.tol, y.tol);
  const ranked = cands.map((c) => ({ c, p: a.probabilities[c.id] ?? 0 })).sort((x, y) => y.p - x.p);
  const groups: { members: Candidate[]; mass: number }[] = [];
  for (const { c, p } of ranked) {
    const g = groups.find((g) => same(g.members[0], c));
    if (g) { g.members.push(c); g.mass += p; } else groups.push({ members: [c], mass: p });
  }
  groups.push({ members: [], mass: a.probabilities[NONE] ?? 0 }); // "none" competes as its own outcome
  groups.sort((x, y) => y.mass - x.mass);
  const [top, second] = groups;
  // representative: the most precise printing of the value (exact francs beat rounded "Mio")
  const rep = [...top.members].sort((a, b) => a.tol - b.tol)[0] ?? null;
  return { rep, mass: top.mass, occurrences: top.members.length,
    runnerUp: second ? { valueCHF: second.members[0]?.chf ?? null, mass: Number(second.mass.toFixed(3)) } : null };
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY && !existsSync(CACHE))
    throw new Error("Set TYPESAFE_API_KEY (https://console.typesafe.ai) — figures.ts calls Jev.");
  const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "cache-only" });
  const results = [];

  for (const doc of DOCS) {
    if (!existsSync(doc.file)) {
      mkdirSync("data/raw", { recursive: true });
      writeFileSync(doc.file, Buffer.from(await (await fetch(doc.url)).arrayBuffer()));
    }
    const text = (await pdf(readFileSync(doc.file))).text;
    const cands = findCandidates(text);
    const picked = await pickFigures(client, doc.kind, doc.year, cands, text);
    const annex = doc.kind === "consuntivo" ? await parseAnnex(doc.year).catch(() => null) : null; // 2025 not yet published by the canton

    const figures = Object.fromEntries(FIELDS_BY_KIND[doc.kind].map((f) => {
      const a = picked.answers[f.key];
      const { rep, mass, occurrences, runnerUp } = resolveByValue(a, cands);
      const c = rep && f.deficit ? { ...rep, chf: -Math.abs(rep.chf) } : rep;
      const status = mass < MIN_CONFIDENCE ? "review" : !c ? "none" : "accepted";
      let check: { annexCHF: number; match: boolean } | undefined;
      if (f.annexKey && annex) {
        const [sec, re] = f.annexKey;
        const v = Object.entries(annex[sec] ?? {}).find(([k]) => re.test(k))?.[1];
        // annex is CHF thousands; city "Mio" figures are rounded to 0.1M, so allow that tolerance
        if (v !== undefined) check = { annexCHF: v * 1000, match: !!c && Math.abs(c.chf - v * 1000) <= c.tol };
      }
      return [f.key, { valueCHF: c?.chf ?? null, raw: c?.raw ?? null, unit: c?.unit ?? null, line: c?.line ?? null,
        candidate: c?.id ?? NONE, valueProbability: Number(mass.toFixed(3)), occurrences, runnerUp,
        rawChoice: { id: a.choice, confidence: Number(a.confidence.toFixed(3)) }, status, check }];
    }));
    const years = Object.fromEntries(["annoPiccoDebito", "annoFinePiano"].filter((k) => picked.answers[k]).map((k) => {
      const a = picked.answers[k];
      return [k, { year: a.choice === NONE ? null : Number(a.choice), confidence: Number(a.confidence.toFixed(3)),
        status: a.choice === NONE ? "none" : a.confidence >= MIN_CONFIDENCE ? "accepted" : "review" }];
    }));
    // internal consistency: risultato globale = autofinanziamento − investimenti netti (within rounding/scope noise)
    const v = (k: string) => (figures[k] as { valueCHF: number | null } | undefined)?.valueCHF ?? null;
    const [af, inv, rg] = doc.kind === "preventivo"
      ? [v("autofinanziamento"), v("investimentiNetti"), v("risultatoGlobale")]
      : [v("autofinanziamento"), v("onereNettoInvestimenti"), v("risultatoGlobale")];
    const consistency = af !== null && inv !== null && rg !== null
      ? { expectedCHF: af - inv, reportedCHF: rg, ok: Math.abs(af - inv - rg) <= 2e6 } : null;
    results.push({ kind: doc.kind, year: doc.year, source: doc.url, model: picked.model, candidates: cands.length,
      usage: picked.usage, figures, years, consistency });
  }

  mkdirSync("out", { recursive: true });
  writeFileSync("out/city-figures.json", JSON.stringify({ generatedAt: new Date().toISOString(), minConfidence: MIN_CONFIDENCE, results }, null, 2));

  for (const r of results) {
    console.log(`\n${r.kind === "consuntivo" ? "Consuntivo" : "Preventivo"} ${r.year}  (${r.candidates} candidates, ${r.usage?.input_tokens ?? "?"} input tokens, ${r.model})`);
    for (const [k, y] of Object.entries(r.years)) console.log(`  ${k.padEnd(32)} ${String(y.year ?? "—").padStart(12)}  ${y.status.padEnd(8)} conf ${y.confidence.toFixed(2)}`);
    if (r.consistency) console.log(`  consistency autofin − invest = globale: ${r.consistency.ok ? "✓" : "✗"} ` +
      `(${(r.consistency.expectedCHF / 1e6).toFixed(1)} vs ${(r.consistency.reportedCHF / 1e6).toFixed(1)} M)`);
    for (const [k, f] of Object.entries(r.figures)) {
      const v = f.valueCHF === null ? "—" : `${(f.valueCHF / 1e6).toFixed(2)} M`;
      const chk = f.check ? (f.check.match ? "✓ annex" : `✗ annex ${(f.check.annexCHF / 1e6).toFixed(2)} M`) : "";
      console.log(`  ${k.padEnd(32)} ${v.padStart(12)}  ${f.status.padEnd(8)} p(value) ${f.valueProbability.toFixed(2)} ×${f.occurrences}  ${chk}`);
    }
  }
  const checks = results.flatMap((r) => Object.values(r.figures).map((f) => f.check).filter(Boolean));
  console.log(`\nvalidation vs canton annex: ${checks.filter((c) => c!.match).length}/${checks.length} match`);
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
