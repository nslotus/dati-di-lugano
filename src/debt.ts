// Debt profile: joins the city's own debt figures (out/city-figures.json, from `npm run figures`)
// with the bond register (src/bonds.ts: terms only, no market prices).
//   - per snapshot date: how much of gross debt is bonds, and how much is other (bank / short-term) debt
//   - today: maturity ladder, refinancing wall, volume-weighted coupon and remaining life
//
//   npm run debt

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bondRegister, type RegisteredBond as BondQuote } from "./bonds";

type Figure = { valueCHF: number | null; status: string };
type CityFigures = { results: {
  kind?: "consuntivo" | "preventivo"; year: number; source: string; figures: Record<string, Figure>;
  years?: Record<string, { year: number | null; status: string }>;
}[] };

const M = 1e6;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const years = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / (365.25 * 864e5);

/** Outstanding on `date`: listed (first trading) on or before it and not yet matured.
 *  Bonds without a SIX listing date are assumed outstanding and reported as such. */
function outstandingOn(quotes: BondQuote[], date: string) {
  const out = quotes.filter((q) => q.maturity > date && (q.listed === null || q.listed <= date));
  const sum = (xs: BondQuote[]) => xs.reduce((s, q) => s + (q.volumeMCHF ?? 0), 0);
  const pub = out.filter((q) => q.kind !== "private"), priv = out.filter((q) => q.kind === "private");
  return { bonds: out, totalM: sum(out), publicM: sum(pub), privateM: sum(priv),
    unknownVolume: out.filter((q) => q.volumeMCHF === null).map((q) => q.isin),
    assumed: out.filter((q) => q.listed === null && q.kind !== "private").map((q) => q.isin) };
}

function snapshots(city: CityFigures | null, quotes: BondQuote[]) {
  const actuals = city?.results.filter((r) => (r.kind ?? "consuntivo") === "consuntivo") ?? [];
  if (!actuals.length) return [];
  const latest = [...actuals].sort((a, b) => b.year - a.year)[0];
  const f = latest.figures, y = latest.year;
  const points = [
    { label: `end ${y - 1}`, date: `${y - 1}-12-31`, gross: f.debitoLordoAnnoPrecedente, cash: f.liquiditaAnnoPrecedente, net: f.debitoNettoAnnoPrecedente },
    { label: `end ${y}`, date: `${y}-12-31`, gross: f.debitoLordoFineAnno, cash: f.liquiditaFineAnno, net: f.debitoNettoFineAnno },
    { label: `Q1 ${y + 1}`, date: `${y + 1}-03-31`, gross: f.debitoLordoTrimestreSuccessivo, cash: undefined, net: f.debitoNettoTrimestreSuccessivo },
  ];
  return points.map((p) => {
    const gross = p.gross?.valueCHF ?? null;
    const b = outstandingOn(quotes, p.date);
    const fig = (x?: Figure) => (x?.valueCHF == null ? null : { M: round(x.valueCHF / M), status: x.status });
    return {
      label: p.label, date: p.date,
      grossDebt: fig(p.gross), cash: fig(p.cash), netDebt: fig(p.net),
      publicBondsM: b.publicM, privatePlacementsM: b.privateM, bondCount: b.bonds.length,
      bondShareOfGross: gross ? round((b.totalM * M) / gross, 3) : null,
      otherDebtM: gross ? round(gross / M - b.totalM) : null, // bank loans, short-term paper, etc.
      unknownVolume: b.unknownVolume, // in the count but not the sums
      assumedOutstanding: b.assumed, // no SIX listing date: issued before the snapshot (pre-2024 ISINs)
      source: latest.source,
    };
  });
}

/** Forward path from the latest budget + financial plan, set against the latest actuals. */
function plan(city: CityFigures | null) {
  const budgets = city?.results.filter((r) => r.kind === "preventivo") ?? [];
  if (!budgets.length) return null;
  const b = [...budgets].sort((x, y) => y.year - x.year)[0];
  const actual = city!.results.filter((r) => (r.kind ?? "consuntivo") === "consuntivo" && r.year === b.year - 1)[0];
  const m = (f?: Figure) => (f?.valueCHF == null ? null : { M: round(f.valueCHF / M), status: f.status });
  const base = actual?.figures.debitoLordoFineAnno?.valueCHF ?? null;
  const need = b.figures.risultatoGlobale?.valueCHF ?? null;
  const yr = (k: string) => (b.years?.[k]?.status === "accepted" ? b.years[k].year : null);
  return {
    budgetYear: b.year, source: b.source,
    budget: { risultatoEsercizio: m(b.figures.risultatoEsercizio), investimentiNetti: m(b.figures.investimentiNetti),
      autofinanziamento: m(b.figures.autofinanziamento), risultatoGlobale: m(b.figures.risultatoGlobale), disinvestimentiPiano: m(b.figures.disinvestimentiPiano) },
    debtPath: [
      { label: `end ${b.year - 1} (actual)`, year: b.year - 1, M: base === null ? null : round(base / M) },
      // budget borrowing need on top of last year's actual debt, before any asset sales
      { label: `end ${b.year} implied by budget`, year: b.year, M: base !== null && need !== null ? round((base - need) / M) : null },
      { label: `end ${b.year} per plan`, year: b.year, ...m(b.figures.debitoDopoInvestimenti) },
      { label: "plan peak", year: yr("annoPiccoDebito"), ...m(b.figures.debitoPiccoPiano) },
      { label: "end of plan", year: yr("annoFinePiano"), ...m(b.figures.debitoFinePiano) },
    ],
  };
}

function profile(quotes: BondQuote[], today: string) {
  const { bonds, totalM } = outstandingOn(quotes, today);
  const w = (fn: (q: BondQuote) => number | null) => {
    const xs = bonds.filter((q) => fn(q) !== null && q.volumeMCHF);
    const vol = xs.reduce((s, q) => s + q.volumeMCHF!, 0);
    return vol ? xs.reduce((s, q) => s + fn(q)! * q.volumeMCHF!, 0) / vol : null;
  };
  const ladder: Record<string, number> = {};
  for (const q of bonds) ladder[q.maturity.slice(0, 4)] = (ladder[q.maturity.slice(0, 4)] ?? 0) + (q.volumeMCHF ?? 0);
  const within = (n: number) => bonds.filter((q) => years(today, q.maturity) <= n).reduce((s, q) => s + (q.volumeMCHF ?? 0), 0);
  const coupon = w((q) => q.coupon);
  return {
    asOf: today,
    outstandingM: totalM, bondCount: bonds.length,
    weightedCouponPct: coupon === null ? null : round(coupon, 3),
    weightedRemainingYears: round(w((q) => years(today, q.maturity))!, 1),
    maturingWithin: { "1y": within(1), "3y": within(3), "5y": within(5) },
    ladderM: Object.fromEntries(Object.entries(ladder).sort()),
    bonds: bonds.map((q) => ({ isin: q.isin, coupon: q.coupon, maturity: q.maturity, volumeMCHF: q.volumeMCHF,
      listed: q.listed, kind: q.kind ?? "public", sixUrl: q.sixUrl, note: q.note })),
  };
}

async function main() {
  const city: CityFigures | null = existsSync("out/city-figures.json")
    ? JSON.parse(readFileSync("out/city-figures.json", "utf8")) : null;
  if (!city) console.warn("out/city-figures.json missing — run `npm run figures` for the debt snapshots; showing bonds only.");

  const now = new Date().toISOString(), today = now.slice(0, 10);
  const register = bondRegister(today);
  const result = { generatedAt: now, snapshots: snapshots(city, register), plan: plan(city), today: profile(register, today) };

  mkdirSync("out", { recursive: true });
  writeFileSync("out/debt-profile.json", JSON.stringify(result, null, 2));

  console.log("Debt snapshots (city figures × bond register)");
  for (const s of result.snapshots) {
    const g = s.grossDebt ? `${s.grossDebt.M.toFixed(1)}M${s.grossDebt.status === "accepted" ? "" : ` [${s.grossDebt.status}]`}` : "n/a";
    const n = s.netDebt ? `${s.netDebt.M.toFixed(1)}M${s.netDebt.status === "accepted" ? "" : ` [${s.netDebt.status}]`}` : "n/a";
    console.log(`  ${s.label.padEnd(9)} gross ${g.padEnd(18)} net ${n.padEnd(18)} public bonds ${String(s.publicBondsM).padStart(5)}M` +
      ` + private ${s.privatePlacementsM}M${s.unknownVolume.length ? ` (+${s.unknownVolume.length} unknown size)` : ""}` +
      `  ${s.bondShareOfGross !== null ? `= ${(s.bondShareOfGross * 100).toFixed(0)}% of gross, other debt ${s.otherDebtM}M` : ""}`);
  }
  if (result.plan) {
    const p = result.plan;
    console.log(`
Plan (preventivo ${p.budgetYear} + financial plan)`);
    for (const d of p.debtPath) console.log(`  ${d.label.padEnd(28)} ${d.year ?? "?"}  ${"M" in d && d.M != null ? d.M.toFixed(1) + "M" : "n/a"}${"status" in d && d.status && d.status !== "accepted" ? ` [${d.status}]` : ""}`);
  }
  const t = result.today;
  console.log(`\nBond book today (${t.asOf}; for prices follow the SIX links in out/debt-profile.json)`);
  console.log(`  outstanding ${t.outstandingM}M in ${t.bondCount} bonds`);
  console.log(`  avg coupon ${t.weightedCouponPct}% · avg remaining life ${t.weightedRemainingYears}y`);
  console.log(`  maturing ≤1y ${t.maturingWithin["1y"]}M · ≤3y ${t.maturingWithin["3y"]}M · ≤5y ${t.maturingWithin["5y"]}M`);
  console.log(`  ladder: ${Object.entries(t.ladderM).map(([y, v]) => `${y}:${v}`).join("  ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
