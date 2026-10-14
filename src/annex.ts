// Parser for the Canton Ticino SEL "allegato statistico" (per-municipality municipal accounts).
// Sheet numbers shift between years (indicators are tab13 in 2023, tab12 in 2024), so sheets are
// located by their title text. Amounts are CHF thousands; indicator ratios are fractions (0.26 = 26%).

import * as XLSX from "xlsx";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEL_BASE } from "./sources";

type Row = unknown[];
type Rating = { label: string; level: "good" | "neutral" | "warning" | "bad" };

const isAggregate = (n: string) => /^(media|mediana|totale)/.test(n);

export const normName = (s: unknown) =>
  String(s ?? "").replace(/\[\*\]/g, "").trim().toLowerCase();

const normHeader = (s: unknown) =>
  String(s ?? "").replace(/([a-z])-\s*([a-z])/gi, "$1$2").replace(/\s+/g, " ").trim(); // "autofinan-ziamento", keep "2025-26"

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function ensureAnnex(year: number, dir = "data/raw"): Promise<string> {
  const ext = year >= 2023 ? "xlsx" : "xls";
  const file = join(dir, `${year}-allegato.${ext}`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const res = await fetch(`${SEL_BASE}/${year}-allegato.${ext}`);
    if (!res.ok) throw new Error(`annex ${year}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

function findSheet(wb: XLSX.WorkBook, title: RegExp): Row[] | null {
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { header: 1, blankrows: false });
    if (title.test(String(rows[0]?.[0] ?? ""))) return rows;
  }
  return null;
}

/** First row whose first cell is a municipality name (header rows have an empty first cell). */
function firstDataRow(rows: Row[]): number {
  return rows.findIndex((r, i) => i > 0 && typeof r[0] === "string" && r.slice(1).some((c) => num(c) !== null));
}

/** Column labels from the multi-row header: deepest non-empty cell, prefixed by a forward-filled group label. */
function headers(rows: Row[], start: number): string[] {
  const hdr = rows.slice(1, start);
  const width = Math.max(...rows.slice(0, start + 5).map((r) => r.length));
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    hdr.forEach((r, depth) => {
      let v = r[c];
      // forward-fill group labels (merged cells) only when a deeper header row has a label here
      if ((v == null || v === "") && depth < hdr.length - 1 && hdr.slice(depth + 1).some((d) => d[c] != null)) {
        for (let k = c - 1; k >= 0 && (v == null || v === ""); k--) v = r[k];
      }
      if (v != null && v !== "") parts.push(normHeader(v));
    });
    out.push([...new Set(parts)].join(" › "));
  }
  return out;
}

function comuneRows(rows: Row[], start: number): Row[] {
  return rows.slice(start).filter((r) => {
    const n = normName(r[0]);
    return typeof r[0] === "string" && n && !isAggregate(n) && !n.startsWith("[") && !/^\d/.test(n) &&
      r.slice(1).some((c) => num(c) !== null);
  });
}

/** Wide sheet → { header: value } for one municipality, skipping spacer columns. */
function extractWide(rows: Row[] | null, who: string, keep?: (h: string) => boolean) {
  if (!rows) return null;
  const start = firstDataRow(rows);
  const hs = headers(rows, start);
  const row = rows.slice(start).find((r) => normName(r[0]) === who);
  if (!row) return null;
  const out: Record<string, number> = {};
  hs.forEach((h, c) => {
    const v = num(row[c]);
    if (c === 0 || !h || v === null || (keep && !keep(h)) || h in out) return;
    out[h] = v;
  });
  return out;
}

/** Functional split: three rows (Spese / Ricavi / Spesa netta) per comune, name only on the first. */
function extractFunctional(rows: Row[] | null, who: string) {
  if (!rows) return null;
  const i = rows.findIndex((r) => normName(r[1]) === who);
  if (i < 0) return null;
  const hs = headers(rows, firstDataRow(rows));
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows.slice(i, i + 3)) {
    const kind = normHeader(r[0]);
    out[kind] = {};
    hs.forEach((h, c) => { const v = num(r[c]); if (c > 1 && h && v !== null) out[kind][h] = v; });
  }
  return out;
}

// ---- official indicators (Regolamento sulla gestione finanziaria dei comuni, art. 22) ----

interface IndicatorDef {
  key: string;
  label: string;
  en: string;
  header: RegExp;
  unit: "points" | "ratio" | "CHF" | "CHF thousands";
  better: "higher" | "lower" | null;
  rate?: (v: number) => Rating;
}

const r = (label: string, level: Rating["level"]): Rating => ({ label, level });

export const INDICATORS: IndicatorDef[] = [
  { key: "risultatoPuntiMA", label: "Risultato in punti di moltiplicatore aritmetico", en: "Result in tax-multiplier points",
    header: /moltiplicatore aritmetico/i, unit: "points", better: "higher",
    rate: (v) => (v > 0 ? r("avanzo", "good") : v === 0 ? r("pareggio", "neutral") : r("disavanzo", "bad")) },
  { key: "tassoIndebitamentoNetto", label: "Tasso di indebitamento netto I", en: "Net debt / tax revenue",
    header: /tasso di indebitamento/i, unit: "ratio", better: "lower",
    rate: (v) => (v < 1 ? r("basso", "good") : v <= 1.5 ? r("medio", "warning") : r("eccessivo", "bad")) },
  { key: "gradoAutofinanziamento", label: "Grado di autofinanziamento", en: "Self-financing ratio",
    header: /autofinanziamento/i, unit: "ratio", better: "higher",
    rate: (v) => (v < 0 ? r("negativo – verificare causa", "bad") : v > 1 ? r("buono", "good")
      : v >= 0.8 ? r("sufficiente", "warning") : r("debole", "bad")) },
  { key: "quotaInteressi", label: "Quota delle spese per interessi", en: "Net interest / current revenue",
    header: /spese per interessi/i, unit: "ratio", better: "lower",
    rate: (v) => (v < 0.04 ? r("bassa", "good") : v <= 0.09 ? r("media", "warning") : r("eccessiva", "bad")) },
  { key: "debitoNettoProCapite", label: "Debito pubblico netto I pro capite", en: "Net public debt per resident",
    header: /procapite|pro capite/i, unit: "CHF", better: "lower",
    rate: (v) => (v < 1000 ? r("basso", "good") : v <= 3000 ? r("medio", "neutral")
      : v <= 5000 ? r("elevato", "warning") : r("molto elevato", "bad")) },
  { key: "debitoNetto", label: "Debito pubblico netto I", en: "Net public debt (canton definition)",
    header: /\(1'000 fr/i, unit: "CHF thousands", better: null }, // "(1'000 fr.)" 2024, "(1'000 franchi)" 2023
  { key: "quotaInvestimenti", label: "Quota degli investimenti", en: "Investment share of spending",
    header: /quota degli investimenti/i, unit: "ratio", better: null,
    rate: (v) => (v > 0.3 ? r("molto elevata", "neutral") : v > 0.2 ? r("elevata", "neutral")
      : v >= 0.1 ? r("media", "neutral") : r("ridotta", "warning")) },
  { key: "quotaCapitaleProprio", label: "Quota di capitale proprio", en: "Equity / total liabilities",
    header: /capitale proprio/i, unit: "ratio", better: "higher",
    rate: (v) => (v > 0.4 ? r("molto elevata", "good") : v >= 0.2 ? r("buona", "good")
      : v >= 0.1 ? r("media", "warning") : r("debole", "bad")) },
  { key: "quotaEccedenze", label: "Quota delle eccedenze di bilancio", en: "Accumulated surplus / total liabilities",
    header: /eccedenze di bilancio/i, unit: "ratio", better: "higher",
    rate: (v) => (v > 0.4 ? r("molto elevata", "good") : v >= 0.2 ? r("buona", "good")
      : v >= 0.1 ? r("media", "warning") : r("debole", "bad")) },
];

export interface IndicatorResult {
  key: string; label: string; en: string; unit: string;
  value: number | null; display: string; rating: Rating | null;
  cantonMean: number | null; cantonMedian: number | null;
  rank: number | null; of: number; betterThanPct: number | null;
}

const fmt = (v: number | null, unit: string) =>
  v === null ? "n/a" : unit === "ratio" ? `${(v * 100).toFixed(1)}%`
    : unit === "points" ? v.toFixed(2) : Math.round(v).toLocaleString("de-CH");

function extractIndicators(rows: Row[] | null, who: string): IndicatorResult[] {
  if (!rows) return [];
  const start = firstDataRow(rows);
  const hs = headers(rows, start);
  const comuni = comuneRows(rows, start);
  const stat = (name: string) => rows.slice(start).find((x) => normName(x[0]).startsWith(name));
  const mean = stat("media"), median = stat("mediana");
  const me = comuni.find((x) => normName(x[0]) === who);

  return INDICATORS.map((d) => {
    const c = hs.findIndex((h) => d.header.test(h));
    const value = c >= 0 && me ? num(me[c]) : null;
    const all = c >= 0 ? comuni.map((x) => num(x[c])).filter((v): v is number => v !== null) : [];
    let rank: number | null = null, betterThanPct: number | null = null;
    if (value !== null && all.length > 1 && d.better) { // no rank for direction-less indicators (size, investment share)
      const sorted = [...all].sort((a, b) => (d.better === "lower" ? a - b : b - a));
      rank = sorted.indexOf(value) + 1;
      const worse = all.filter((v) => (d.better === "lower" ? v > value : v < value)).length;
      betterThanPct = Math.round((worse / (all.length - 1)) * 100);
    }
    return {
      key: d.key, label: d.label, en: d.en, unit: d.unit, value,
      display: c < 0 ? "not published this year" : fmt(value, d.unit),
      rating: value !== null && d.rate ? d.rate(value) : null,
      cantonMean: c >= 0 && mean ? num(mean[c]) : null,
      cantonMedian: c >= 0 && median ? num(median[c]) : null,
      rank, of: all.length, betterThanPct,
    };
  });
}

export interface AnnexYear {
  year: number;
  source: string;
  units: { amounts: "CHF thousands"; ratios: "fraction (0.26 = 26%)" };
  caveats: string[];
  valoriIndicativi: Record<string, number> | null;
  contoEconomico: Record<string, number> | null;
  investimentiEFinanziamento: Record<string, number> | null;
  bilancio: Record<string, number> | null;
  ricaviFiscali: Record<string, number> | null;
  ripartizioneFunzionale: Record<string, Record<string, number>> | null;
  indicatori: IndicatorResult[];
  water: "not in comune accounts (separate company)" | Record<string, number> | null;
}

export async function parseAnnex(year: number, comune = "Lugano"): Promise<AnnexYear> {
  const file = await ensureAnnex(year);
  const wb = XLSX.read(readFileSync(file));
  const who = normName(comune);
  const water = extractWide(findSheet(wb, /approv+igionamento idrico/i), who);
  const ce = extractWide(findSheet(wb, /Conto economico \(senza imputazioni/i), who);
  const inv = extractWide(findSheet(wb, /Conto degli investimenti e Conto di finanziamento/i), who);
  const notes = caveats(ce, inv);
  const indicatori = extractIndicators(findSheet(wb, /Indicatori finanziari/i), who);
  if (notes.some((n) => n.startsWith("Investment receipts"))) {
    const sf = indicatori.find((i) => i.key === "gradoAutofinanziamento");
    if (sf) Object.assign(sf, { rating: r("distorto (entrate d'investimento straordinarie)", "warning"), rank: null, betterThanPct: null });
  }
  return {
    year,
    source: `${SEL_BASE}/${file.split(/[\\/]/).pop()}`,
    units: { amounts: "CHF thousands", ratios: "fraction (0.26 = 26%)" },
    caveats: notes,
    valoriIndicativi: extractWide(findSheet(wb, /Alcuni valori indicativi/i), who),
    contoEconomico: ce,
    investimentiEFinanziamento: inv,
    bilancio: extractWide(findSheet(wb, /Bilancio patrimoniale, in/i), who),
    // tax revenue split: 3-digit codes 400–403 (persone fisiche, giuridiche, altre dirette, possesso/spesa)
    ricaviFiscali: extractWide(findSheet(wb, /Ricavi del conto economico per genere a tre cifre/i), who,
      (h) => /^40[0-3]\b/.test(h)),
    ripartizioneFunzionale: extractFunctional(findSheet(wb, /Ripartizione funzionale a una cifra/i), who),
    indicatori,
    water: water ?? "not in comune accounts (separate company)",
  };
}

/** One-offs that make a single year's indicators misleading. */
function caveats(ce: Record<string, number> | null, inv: Record<string, number> | null): string[] {
  const out: string[] = [];
  const pick = (o: Record<string, number> | null, re: RegExp) =>
    Object.entries(o ?? {}).find(([k]) => re.test(k))?.[1] ?? null;
  const gross = pick(inv, /Uscite per investimenti/i), receipts = pick(inv, /Entrate per investimenti/i);
  if (gross && receipts !== null && receipts / gross > 0.5)
    out.push(`Investment receipts were ${Math.round((receipts / gross) * 100)}% of outlays (one-off inflows): ` +
      `net investment is unusually small, so the self-financing ratio is inflated and not representative.`);
  const extra = pick(ce, /^Ricavi straordinari/i), total = pick(ce, /RISULTATO TOTALE/i);
  if (extra && total !== null && Math.abs(extra) > Math.abs(total) * 0.5)
    out.push(`Extraordinary revenue of ${Math.round(extra).toLocaleString("de-CH")}k CHF drives the total result ` +
      `(ordinary result: ${Math.round(pick(ce, /RISULTATO ORDINARIO/i) ?? 0).toLocaleString("de-CH")}k).`);
  return out;
}
