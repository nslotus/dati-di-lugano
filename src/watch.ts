// News watcher: flags new City of Lugano publications that matter for its financial health.
//   - finance page (evoluzione finanziaria): any new document title is an alert, decided in code
//   - press releases (cartella stampa): new items are classified by Jev, one Choice per item in one request,
//     with the first part of each release's PDF as evidence; code applies the alert policy
// State lives in data/cache/watch-state.json, so each run only looks at what is new.
//
//   TYPESAFE_API_KEY=... npm run watch            (first run classifies the current page as a baseline)

import pdf from "pdf-parse/lib/pdf-parse.js";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.14.0";
const BASE = "https://www.lugano.ch";
const PRESS = `${BASE}/area-stampa/cartella-stampa/`;
const FINANCE = `${BASE}/la-mia-citta/amministrazione/evoluzione-finanziaria/`;
const STATE = "data/cache/watch-state.json";
const ALERT_AT = 0.5; // P(core financial category); tune once you've seen a few weeks of items

const CATEGORIES = {
  budget: "The city's budget (preventivo), financial plan (piano finanziario) or tax multiplier (moltiplicatore).",
  accounts: "The city's own accounts: consuntivo, preconsuntivo, or interim financial results of the city administration.",
  rating: "A credit rating of the City of Lugano (e.g. Moody's).",
  borrowing: "The city borrowing or repaying money: bond issues, loans, debt levels or refinancing.",
  assets: "Selling, revaluing or buying city-owned property or stakes in companies, with financial consequences.",
  city_company: "A company or entity the city owns or controls (airport, AIL, LAC, etc.), including its governance or results, without direct effect on the city's accounts.",
  other_finance: "Some other money matter for the city: a project's cost, subsidies, fees or a tax for citizens.",
  not_financial: "Events, culture, sport, mobility, schools, services or anything without a financial dimension for the city.",
} as const;
type Category = keyof typeof CATEGORIES;
const CORE: Category[] = ["budget", "accounts", "rating", "borrowing", "assets"];

const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&agrave;/g, "à").replace(/&#39;|&rsquo;/g, "’").replace(/\s+/g, " ").trim();

async function get(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (luganocity watcher)" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

interface PressItem { url: string; title: string; date: string | null }

export function parsePress(html: string): PressItem[] {
  const out: PressItem[] = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]*\/dam\/[^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = strip(m[2]);
    const [, title, d, mon, y] = text.match(/^(.*?)\s+PDF \([^)]*\)\s*(\d{1,2})\s+(\w+)\s+(\d{4})/) ?? [];
    if (!title) continue;
    const mi = MONTHS.indexOf(mon.toLowerCase());
    const url = m[1].startsWith("http") ? m[1] : BASE + m[1];
    if (!out.some((o) => o.url === url))
      out.push({ url, title, date: mi < 0 ? null : `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}` });
  }
  return out;
}

export function parseFinanceDocs(html: string): string[] {
  return [...new Set([...html.matchAll(/title="([^"]+)"/g)].map((m) => strip(m[1]))
    .filter((t) => /preventivo|consuntivo|piano finanziario|rating|preconsuntivo/i.test(t)))];
}

async function excerpt(url: string): Promise<string> {
  try {
    const res = await get(url);
    const text = url.endsWith(".pdf") ? (await pdf(Buffer.from(await res.arrayBuffer()))).text : strip(await res.text());
    return text.replace(/\s+/g, " ").trim().slice(0, 1500); // the lead paragraph carries the substance
  } catch { return ""; }
}

// Labelled past releases: should the watcher alert? (`npm run watch -- --eval`)
const EVAL: (PressItem & { expectAlert: boolean })[] = [
  { expectAlert: true, date: "2026-06-26", title: "La Città di Lugano emette un bond decennale a supporto del piano di investimenti",
    url: `${BASE}/dam/jcr:3f46ba81-6312-4886-b279-8741b5eecbb1/20260626-emissione-bond-digitale-investimenti.pdf` },
  { expectAlert: true, date: "2026-04-23", title: "Consuntivo 2025: risultato d’esercizio positivo, ma resta la sfida del debito",
    url: `${BASE}/dam/jcr:57dbf19a-f850-47fe-8fa0-4d59fdc6da20/20260423-consuntivo-2025-comunicato.pdf` },
  { expectAlert: true, date: "2025-10-23", title: "Preventivo 2026 e Piano Finanziario 2026-2033: la Città investe nel futuro con attenzione alla sostenibilità dei conti",
    url: `${BASE}/dam/jcr:0a793cce-fba0-4c83-b596-e65560732832/20251023-cs-preventivo-2026-piano-finanziario-2026-2033.pdf` },
  { expectAlert: true, date: "2025-10-27", title: "Moody's conferma la valutazione della Città di Lugano",
    url: `${BASE}/en/news/20251027-cs-conferma-rating-moodys.html` },
  { expectAlert: true, date: "2025-07-09", title: "Lugano ha emesso un bond decennale a supporto del suo programma di investimenti",
    url: `${BASE}/dam/jcr%3Adc312d1e-0e6f-419a-b6fc-6d030fa620cc/20250709-cs-quinto-bond-digitale.pdf` },
  { expectAlert: false, date: "2026-10-13", title: "Entità partecipate della Città di Lugano: il tema al vaglio dell’Esecutivo cittadino",
    url: `${BASE}/dam/jcr:b7d47130-a778-455e-a5d8-d7ee9a9c66a9/20261013-cs-entita-partecipate-citta-lugano.pdf` },
  { expectAlert: false, date: "2026-09-17", title: "Lugano Airport: rinnovata per 30 anni la concessione d’esercizio",
    url: `${BASE}/dam/jcr:8aaab2b7-a2fd-42b8-bdc8-0bdc2714d040/20260917-cs-rinnovo-concessione-lugano-airport.pdf` },
  { expectAlert: false, date: "2026-08-31", title: "Lugano torna sui banchi: tutto è pronto per il suono della prima campanella",
    url: `${BASE}/dam/jcr:3a340d7f-0d96-4d7a-8af3-f512b72d1c9e/20260831-inizio-anno-scolastico-2026-27-comunicato.pdf` },
];

async function runEval() {
  if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY to run the eval.");
  const items = EVAL;
  const withText = await Promise.all(items.map(async (p) => ({ ...p, excerpt: await excerpt(p.url) })));
  const res = await classify(new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY }), withText);
  let ok = 0;
  res.forEach((r, i) => {
    const pass = r.alert === items[i].expectAlert; ok += +pass;
    console.log(`  ${pass ? "✓" : "✗"} ${r.alert ? "ALERT" : "     "} p=${r.pFinancial.toFixed(2)} [${r.category}]${r.excerpt ? "" : " (no excerpt)"}  ${r.title.slice(0, 70)}`);
  });
  console.log(`\neval: ${ok}/${res.length} correct at ALERT_AT=${ALERT_AT}`);
}

async function classify(client: TypeSafeClient, items: (PressItem & { excerpt: string })[]) {
  const state = {
    purpose: "Someone is tracking the financial health of the City of Lugano (Switzerland): its budget, accounts, debt, credit rating and assets.",
    items: items.map((it, i) => ({ id: i, date: it.date, title: it.title, excerpt: it.excerpt })),
  };
  const questions = Object.fromEntries(items.map((_, i) => [`item${i}`,
    choice(`What is press release \`items[${i}]\` mainly about, from the point of view of the city's finances?`, CATEGORIES)]));
  const res = await client.systemOne({ model: MODEL, state, questions });
  return items.map((it, i) => {
    const a = res.answers[`item${i}`] as { choice: Category; confidence: number; probabilities: Record<Category, number> };
    const pCore = CORE.reduce((s, c) => s + (a.probabilities[c] ?? 0), 0);
    return { ...it, category: a.choice, confidence: Number(a.confidence.toFixed(3)), pFinancial: Number(pCore.toFixed(3)), alert: pCore >= ALERT_AT };
  });
}

async function main() {
  const seen: { press: string[]; financeDocs: string[] } = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8")) : { press: [], financeDocs: [] };
  const firstRun = !existsSync(STATE);

  const [pressHtml, financeHtml] = await Promise.all([get(PRESS).then((r) => r.text()), get(FINANCE).then((r) => r.text())]);
  const press = parsePress(pressHtml);
  const docs = parseFinanceDocs(financeHtml);
  const newDocs = firstRun ? [] : docs.filter((d) => !seen.financeDocs.includes(d));
  const newPress = press.filter((p) => !seen.press.includes(p.url));
  if (!press.length) console.warn("No press items parsed — the page layout may have changed.");

  let classified: Awaited<ReturnType<typeof classify>> = [];
  if (newPress.length) {
    if (!process.env.TYPESAFE_API_KEY) throw new Error(`${newPress.length} new press items; set TYPESAFE_API_KEY to classify them.`);
    const withText = await Promise.all(newPress.map(async (p) => ({ ...p, excerpt: await excerpt(p.url) })));
    classified = await classify(new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY }), withText);
  }

  const run = {
    checkedAt: new Date().toISOString(), firstRun,
    newFinanceDocuments: newDocs,
    pressAlerts: classified.filter((c) => c.alert).map(({ excerpt, ...c }) => c),
    pressOther: classified.filter((c) => !c.alert).map(({ excerpt, ...c }) => c),
  };
  mkdirSync("out", { recursive: true });
  const log = existsSync("out/news-alerts.json") ? JSON.parse(readFileSync("out/news-alerts.json", "utf8")) : [];
  writeFileSync("out/news-alerts.json", JSON.stringify([run, ...log].slice(0, 100), null, 2));
  mkdirSync("data/cache", { recursive: true });
  writeFileSync(STATE, JSON.stringify({ press: [...new Set([...seen.press, ...press.map((p) => p.url)])],
    financeDocs: [...new Set([...seen.financeDocs, ...docs])] }, null, 2));

  console.log(`checked ${press.length} press items (${newPress.length} new) and ${docs.length} finance documents${firstRun ? " — baseline run" : ""}`);
  for (const d of newDocs) console.log(`  ★ NEW FINANCE DOCUMENT: ${d}  → add it to DOCS in src/figures.ts and run npm run figures`);
  for (const c of run.pressAlerts) console.log(`  ★ ${c.date}  [${c.category}, p=${c.pFinancial}]  ${c.title}\n      ${c.url}`);
  for (const c of run.pressOther) console.log(`    ${c.date}  [${c.category}, p=${c.pFinancial}]  ${c.title.slice(0, 80)}`);
  if (!newDocs.length && !run.pressAlerts.length) console.log("  no financial updates");
}

if (require.main === module) (process.argv.includes("--eval") ? runEval() : main()).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
