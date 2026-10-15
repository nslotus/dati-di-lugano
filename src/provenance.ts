// Provenance pack: archives the exact source files used and traces every extracted figure to its page.
//   - copies data/raw/* to sources/ and writes sources/MANIFEST.json (+ README) with original URL,
//     retrieval time and SHA-256, so anyone can prove which version of a document was used
//   - writes TRACE.md: every figure in out/city-figures.json with document, page, printed text,
//     extraction confidence and checks
//
//   npm run provenance        (run after npm run figures)

import pdf from "pdf-parse/lib/pdf-parse.js";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { SEL_BASE } from "./sources";

const RAW = "data/raw", OUT = "sources";
const CITY = "https://www.lugano.ch";

const ORIGIN: Record<string, { url: string; publisher: string; usedFor: string }> = {
  "2023-allegato.xlsx": { url: `${SEL_BASE}/2023-allegato.xlsx`, publisher: "Canton of Ticino, Sezione degli enti locali",
    usedFor: "2023 accounts and indicators for every municipality (indicators table, 2023 column; 2023 caveats)" },
  "2024-allegato.xlsx": { url: `${SEL_BASE}/2024-allegato.xlsx`, publisher: "Canton of Ticino, Sezione degli enti locali",
    usedFor: "2024 accounts and indicators for every municipality (indicators table, ranks, medians; ground truth for the 2024 city figures)" },
  "2024-rapporto.pdf": { url: `${SEL_BASE}/2024-rapporto.pdf`, publisher: "Canton of Ticino, Sezione degli enti locali",
    usedFor: "Indicator definitions and the official rating scales" },
  "city-consuntivo-2024-slides.pdf": { url: `${CITY}/dam/jcr:66e7b5df-519e-4fcb-83aa-a9db062b7081/20250404-cs-consuntivo-2024-presentazione.pdf`,
    publisher: "City of Lugano", usedFor: "2024 figures (validation set for the extraction)" },
  "city-consuntivo-2025-slides.pdf": { url: `${CITY}/dam/jcr:8e5c3ada-87b4-4397-a3c7-e55dd4a9199a/20260423-consuntivo-2025-presentazione.pdf`,
    publisher: "City of Lugano", usedFor: "2025 results, end-2024 and end-2025 debt, Q1-2026 debt" },
  "city-preventivo-2026-comunicato.pdf": { url: `${CITY}/dam/jcr:0a793cce-fba0-4c83-b596-e65560732832/20251023-cs-preventivo-2026-piano-finanziario-2026-2033.pdf`,
    publisher: "City of Lugano", usedFor: "Budget 2026 and the financial plan's debt path to 2033" },
  "ustat-142lugano.pdf": { url: "https://www3.ti.ch/DFE/DR/USTAT/allegati/comune/142lugano.pdf", publisher: "Canton of Ticino, Ufficio di statistica (USTAT)",
    usedFor: "Checked only: confirmed the municipal profile is dated February 2017" },
  "20261013-entita-partecipate.pdf": { url: `${CITY}/dam/jcr:b7d47130-a778-455e-a5d8-d7ee9a9c66a9/20261013-cs-entita-partecipate-citta-lugano.pdf`,
    publisher: "City of Lugano", usedFor: "News check of 15 October 2026 (governance, no figures)" },
  "20251027-moodys-rating.pdf": { url: `${CITY}/dam/jcr:f659385e-ceef-4a3b-b14f-c776dcbf239d/20251027-cs-conferma-rating-moodys.pdf`,
    publisher: "City of Lugano", usedFor: "Moody's Aa3 stable rating, 27 October 2025 (key figures). Contains no debt ratios" },
  "20260626-bond-decennale.pdf": { url: `${CITY}/dam/jcr:3f46ba81-6312-4886-b279-8741b5eecbb1/20260626-emissione-bond-digitale-investimenti.pdf`,
    publisher: "City of Lugano", usedFor: "CHF 100M 10-year bond of July 2026 (bond register; borrowing note)" },
  "evoluzione.html": { url: `${CITY}/la-mia-citta/amministrazione/evoluzione-finanziaria/`, publisher: "City of Lugano",
    usedFor: "Snapshot of the finance-documents page (document list; watcher baseline)" },
  "press.html": { url: `${CITY}/area-stampa/cartella-stampa/`, publisher: "City of Lugano",
    usedFor: "Snapshot of the press-release list (news check; watcher baseline)" },
  "news.html": { url: `${CITY}/news/`, publisher: "City of Lugano", usedFor: "Snapshot of the news page (news check)" },
};

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Google API keys (AIza…) and generic key=/token= query values in archived web pages. */
function redact(text: string) {
  let count = 0;
  const out = text
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, () => (count++, "REDACTED"))
    .replace(/([?&](?:api_?key|access_token|token)=)([A-Za-z0-9._-]{16,})/gi, (_m, k) => (count++, `${k}REDACTED`));
  return { text: out, count };
}
const squash = (s: string) => s.replace(/\s+/g, "");

async function pageTexts(file: string): Promise<string[]> {
  const pages: string[] = [];
  await pdf(readFileSync(file), { pagerender: async (p: any) => {
    const t = await p.getTextContent();
    const s = t.items.map((i: { str: string }) => i.str).join(" ");
    pages[p.pageIndex] = s;
    return s;
  } });
  return pages;
}

/** Page (1-based) that contains the printed value; when several do, the one that also contains its line. */
function findPage(pages: string[], raw: string, line: string): number | null {
  const v = squash(raw), l = squash(line).slice(0, 30);
  const hits = pages.map((p, i) => [squash(p), i] as const).filter(([p]) => p.includes(v));
  if (!hits.length) return null;
  return (hits.find(([p]) => p.includes(l)) ?? hits[0])[1] + 1;
}

const LABEL: Record<string, string> = {
  risultatoTotaleEsercizio: "Total operating result", risultatoEsercizio: "Operating result (budget)",
  risultatoGlobale: "Overall financing result", autofinanziamento: "Self-financing",
  usciteInvestimenti: "Gross investment spending", onereNettoInvestimenti: "Net investment", investimentiNetti: "Net investment (budget)",
  debitoLordoFineAnno: "Gross debt, year end", liquiditaFineAnno: "Cash and deposits, year end", debitoNettoFineAnno: "Net debt, year end",
  debitoLordoAnnoPrecedente: "Gross debt, previous year end", liquiditaAnnoPrecedente: "Cash and deposits, previous year end",
  debitoNettoAnnoPrecedente: "Net debt, previous year end", debitoLordoTrimestreSuccessivo: "Gross debt, following quarter",
  debitoNettoTrimestreSuccessivo: "Net debt, following quarter", disinvestimentiPiano: "Planned asset sales/revaluations (whole plan)",
  debitoDopoInvestimenti: "Debt after the budget-year investments", debitoPiccoPiano: "Plan peak debt", debitoFinePiano: "Debt at end of plan",
};

async function main() {
  // 1. archive + manifest
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(RAW).filter((f) => ORIGIN[f]).sort();
  const unknown = readdirSync(RAW).filter((f) => !ORIGIN[f]);
  if (unknown.length) console.warn(`not archived (no recorded origin): ${unknown.join(", ")}`);
  const manifest = files.map((f) => {
    const original = readFileSync(`${RAW}/${f}`);
    // Page snapshots embed the site's own third-party keys (lugano.ch loads Google Maps with a browser key).
    // Never republish them: blank any credential-looking value before archiving, and record both hashes.
    const redacted = f.endsWith(".html") ? redact(original.toString("utf8")) : null;
    const buf = redacted && redacted.count ? Buffer.from(redacted.text, "utf8") : original;
    if (buf === original) copyFileSync(`${RAW}/${f}`, `${OUT}/${f}`); else writeFileSync(`${OUT}/${f}`, buf);
    return { file: `sources/${f}`, ...ORIGIN[f], retrieved: statSync(`${RAW}/${f}`).mtime.toISOString(), bytes: buf.length, sha256: sha256(buf),
      ...(buf !== original ? { redacted: `${redacted!.count} third-party API key value(s) replaced with REDACTED`, originalSha256: sha256(original) } : {}) };
  });
  const leftovers = manifest.filter((m) => /AIza[0-9A-Za-z_-]{30}/.test(readFileSync(m.file).toString("latin1")));
  if (leftovers.length) throw new Error(`credential pattern still present in: ${leftovers.map((m) => m.file).join(", ")}`);
  writeFileSync(`${OUT}/MANIFEST.json`, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(`${OUT}/README.md`, [
    "# Source archive",
    "",
    "The exact files this project's figures were taken from, as downloaded. `MANIFEST.json` has the same data in machine-readable form.",
    "To check that a file is unchanged, compare its SHA-256 (`sha256sum <file>` or `Get-FileHash <file>`) with the value below;",
    "to check whether the publisher has changed it since, download it again from the original URL and compare.",
    "",
    "These are public documents of Swiss authorities. Under Art. 5 of the Swiss Copyright Act, official reports and decisions",
    "of public authorities are generally not protected by copyright; they are archived here unchanged, for verification, with",
    "their publisher named. Press releases are the least clear-cut case; if a publisher objects, remove the file and keep its hash.",
    "",
    "| File | Publisher | Used for | Retrieved (UTC) | SHA-256 |",
    "|---|---|---|---|---|",
    ...manifest.map((m) => `| [${m.file.replace("sources/", "")}](${m.file.replace("sources/", "")}) ([original](${m.url})) | ${m.publisher} | ${m.usedFor} | ${m.retrieved.slice(0, 16).replace("T", " ")} | \`${m.sha256.slice(0, 16)}…\` |`),
    "",
  ].join("\n"));

  // 2. figure trace
  if (!existsSync("out/city-figures.json")) throw new Error("run `npm run figures` first");
  const city = JSON.parse(readFileSync("out/city-figures.json", "utf8"));
  const byUrl = Object.fromEntries(manifest.map((m) => [m.url, m]));
  const lines: string[] = [
    "# Figure trace",
    "",
    "Every figure extracted from the City of Lugano's PDFs, with where it is printed. Generated by `npm run provenance` from",
    "`out/city-figures.json` and the archived files in `sources/`. See `METHODOLOGY.md` for how extraction and checks work.",
    "",
    "Status: **accepted** = pooled probability ≥ 0.8; **review** = below 0.8, checked by hand (see METHODOLOGY.md); **none** = the document does not give this figure.",
    "",
  ];
  for (const r of city.results) {
    const src = byUrl[r.source];
    const pages = src ? await pageTexts(src.file) : [];
    lines.push(`## ${r.kind === "consuntivo" ? "Final accounts" : "Budget"} ${r.year}`, "",
      `Source: [${src ? src.file : "original"}](${src ? src.file : r.source}) · [original](${r.source})` +
      `${src ? ` · SHA-256 \`${src.sha256.slice(0, 16)}…\`` : ""} · ${r.candidates} candidate amounts · model ${r.model}`, "");
    if (r.consistency) lines.push(`Consistency check (self-financing − net investment = overall result): ${r.consistency.ok ? "passed" : "FAILED"}` +
      ` (${(r.consistency.expectedCHF / 1e6).toFixed(1)}M vs ${(r.consistency.reportedCHF / 1e6).toFixed(1)}M).`, "");
    lines.push("| Figure | Value (CHF M) | Printed as | Page | Printed line | p(value) | Status | Check |", "|---|---|---|---|---|---|---|---|");
    for (const [k, f] of Object.entries<any>(r.figures)) {
      const page = f.raw && f.line ? findPage(pages, f.raw, f.line) : null;
      const check = f.check ? (f.check.match ? `✓ canton ${(f.check.annexCHF / 1e6).toFixed(2)}M` : `✗ canton ${(f.check.annexCHF / 1e6).toFixed(2)}M`) : "";
      const line = (f.line ?? "").replace(/\|/g, "\\|").slice(0, 90);
      lines.push(`| ${LABEL[k] ?? k} | ${f.valueCHF === null ? "—" : (f.valueCHF / 1e6).toFixed(2)} | ${f.raw ? `\`${f.raw}\`${f.unit === "CHF million" ? " M" : ""}` : "—"} | ${page ?? "—"} | ${line || "—"} | ${f.valueProbability.toFixed(2)} | ${f.status} | ${check} |`);
    }
    for (const [k, y] of Object.entries<any>(r.years ?? {}))
      lines.push(`| ${k === "annoPiccoDebito" ? "Year of plan peak" : "Last year of plan"} | ${y.year ?? "—"} | — | — | — | conf ${y.confidence.toFixed(2)} | ${y.status} | |`);
    lines.push("");
  }
  writeFileSync("TRACE.md", lines.join("\n"));
  console.log(`archived ${manifest.length} files to ${OUT}/ (${(manifest.reduce((s, m) => s + m.bytes, 0) / 1e6).toFixed(1)} MB); wrote TRACE.md`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
