// Budget vs actual, read deterministically from the recap tables of the city's final-accounts decks.
// Each recap row prints: actual (consuntivo) · budget (preventivo) · difference · percent.
// Checks that stop the run:
//   - actual − budget = printed difference, to the cent, for every row
//   - the actual matches the figure already extracted and checked in out/city-figures.json, where one exists
//
//   npm run budget   → out/budget-vs-actual.json

import pdf from "pdf-parse/lib/pdf-parse.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { findCandidates } from "./figures";

const DECKS = [
  { year: 2024, file: "sources/city-consuntivo-2024-slides.pdf",
    url: "https://www.lugano.ch/dam/jcr:66e7b5df-519e-4fcb-83aa-a9db062b7081/20250404-cs-consuntivo-2024-presentazione.pdf" },
  { year: 2025, file: "sources/city-consuntivo-2025-slides.pdf",
    url: "https://www.lugano.ch/dam/jcr:8e5c3ada-87b4-4397-a3c7-e55dd4a9199a/20260423-consuntivo-2025-presentazione.pdf" },
];

// row label in the deck → key, English label, and the matching key in out/city-figures.json (if extracted there)
const ROWS: { label: string; key: string; en: string; figure?: string }[] = [
  { label: "Spese operative", key: "speseOperative", en: "Operating spending" },
  { label: "Ricavi operativi", key: "ricaviOperativi", en: "Operating revenue" },
  { label: "Risultato operativo", key: "risultatoOperativo", en: "Operating balance" },
  { label: "Risultato totale d'esercizio", key: "risultatoTotaleEsercizio", en: "Total operating result", figure: "risultatoTotaleEsercizio" },
  { label: "Uscite per investimenti", key: "usciteInvestimenti", en: "Gross investment", figure: "usciteInvestimenti" },
  { label: "Entrate per investimenti", key: "entrateInvestimenti", en: "Investment receipts" },
  { label: "Onere netto per investimenti", key: "onereNettoInvestimenti", en: "Net investment", figure: "onereNettoInvestimenti" },
  { label: "Autofinanziamento", key: "autofinanziamento", en: "Self-financing", figure: "autofinanziamento" },
  { label: "Risultato globale", key: "risultatoGlobale", en: "Overall financing result", figure: "risultatoGlobale" },
];

const squash = (s: string) => s.replace(/\s+/g, "");

async function pages(file: string) {
  // default text keeps line structure (needed for rows); per-page text is only for locating the page
  const text = (await pdf(readFileSync(file))).text;
  const out: string[] = [];
  await pdf(readFileSync(file), { pagerender: async (p: any) => {
    const t = await p.getTextContent(); const s = t.items.map((i: { str: string }) => i.str).join(" ");
    out[p.pageIndex] = s; return s;
  } });
  return { text, pages: out };
}

async function main() {
  const figures = existsSync("out/city-figures.json") ? JSON.parse(readFileSync("out/city-figures.json", "utf8")) : null;
  const decks = [];
  for (const d of DECKS) {
    const { text, pages: pp } = await pages(d.file);
    const cands = findCandidates(text).filter((c) => c.unit === "CHF");
    const extracted = figures?.results.find((r: any) => r.kind === "consuntivo" && r.year === d.year)?.figures ?? {};
    const rows = ROWS.map((row) => {
      // first occurrence of the row = the recap table; positions 1–3 = actual, budget, difference
      const cells = cands.filter((c) => c.rowLabel.replace(/^[+\-–\s]+/, "") === row.label);
      const at = (p: number) => cells.find((c) => c.positionInRow === p);
      const [a, b, diff] = [at(1), at(2), at(3)];
      if (!a || !b || !diff) throw new Error(`CHECK FAILED ${d.year} ${row.label}: recap row incomplete`);
      if (Math.abs(a.chf - b.chf - diff.chf) > 0.02) throw new Error(`CHECK FAILED ${d.year} ${row.label}: ${a.raw} − ${b.raw} ≠ ${diff.raw}`);
      const ex = row.figure ? extracted[row.figure] : undefined;
      if (ex?.valueCHF != null && Math.abs(ex.valueCHF - a.chf) > 1)
        throw new Error(`CHECK FAILED ${d.year} ${row.label}: actual ${a.raw} differs from extracted ${ex.valueCHF}`);
      const page = pp.findIndex((p) => squash(p).includes(squash(a.raw)) && squash(p).includes(squash(b.raw))) + 1 || null;
      return { key: row.key, label: { it: row.label, en: row.en }, actualCHF: a.chf, budgetCHF: b.chf, differenceCHF: diff.chf,
        printed: { actual: a.raw, budget: b.raw, difference: diff.raw }, page,
        checks: { differenceAddsUp: true, matchesExtractedFigure: ex?.valueCHF != null ? true : null } };
    });
    decks.push({ year: d.year, source: d.url, archived: d.file, rows });
  }
  mkdirSync("out", { recursive: true });
  writeFileSync("out/budget-vs-actual.json", JSON.stringify({
    generatedAt: new Date().toISOString(),
    method: "Read from the recap tables of the City's final-accounts decks (columns: actual, budget, difference). Every row passes actual − budget = printed difference; where the actual was already extracted (out/city-figures.json) it must match.",
    decks }, null, 2) + "\n");

  for (const d of decks) {
    console.log(`\nConsuntivo ${d.year} vs preventivo`);
    for (const r of d.rows) console.log(`  ${r.label.it.padEnd(30)} actual ${(r.actualCHF / 1e6).toFixed(2).padStart(8)}M  budget ${(r.budgetCHF / 1e6).toFixed(2).padStart(8)}M  diff ${(r.differenceCHF / 1e6).toFixed(2).padStart(7)}M  p.${r.page}${r.checks.matchesExtractedFigure ? "  ✓ = extracted" : ""}`);
  }
  console.log("\nall rows: actual − budget = printed difference ✓");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
