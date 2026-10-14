// Entry point: builds the Lugano financial-health data map.
//   npm run map            → out/sources.json, out/lugano-indicators.json + .csv, out/bonds.json
//   bond register is static (terms only; prices are on SIX, linked per bond)

import { mkdirSync, writeFileSync } from "node:fs";
import { sources } from "./sources";
import { parseAnnex, type AnnexYear } from "./annex";
import { bondRegister } from "./bonds";

const OUT = "out";
const YEARS = [2023, 2024]; // MCA2-comparable years available as xlsx; earlier years use MCA1 (not comparable)

async function checkSources() {
  return Promise.all(
    sources.map(async (s) => {
      try {
        const res = await fetch(s.url, { method: "GET", redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
        res.body?.cancel();
        return { ...s, httpStatus: res.status };
      } catch (e) {
        // statistica.lugano.ch serves an incomplete TLS chain: browsers/curl accept it, Node's fetch does not
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        return { ...s, httpStatus: null, error: cause ? `${cause} (opens fine in a browser)` : String(e) };
      }
    }),
  );
}

function toCsv(years: AnnexYear[]): string {
  const rows: (string | number)[][] = [["year", "section", "field", "value", "unit", "rating", "rank", "of", "canton_mean", "canton_median"]];
  for (const y of years) {
    for (const c of y.caveats) rows.push([y.year, "caveat", c, "", "", "", "", "", "", ""]);
    for (const i of y.indicatori)
      rows.push([y.year, "indicatori", i.label, i.value ?? "", i.unit, i.rating?.label ?? "", i.rank ?? "", i.of,
        i.cantonMean ?? "", i.cantonMedian ?? ""]);
    const sections = { valoriIndicativi: y.valoriIndicativi, contoEconomico: y.contoEconomico,
      investimentiEFinanziamento: y.investimentiEFinanziamento, bilancio: y.bilancio, ricaviFiscali: y.ricaviFiscali };
    for (const [sec, obj] of Object.entries(sections))
      for (const [k, v] of Object.entries(obj ?? {}))
        rows.push([y.year, sec, k, v, sec === "valoriIndicativi" ? "" : "CHF thousands", "", "", "", "", ""]);
    for (const [kind, obj] of Object.entries(y.ripartizioneFunzionale ?? {}))
      for (const [k, v] of Object.entries(obj)) rows.push([y.year, `funzionale:${kind}`, k, v, "CHF thousands", "", "", "", "", ""]);
  }
  return rows.map((r) => r.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const register = bondRegister(today);
  writeFileSync(`${OUT}/bonds.json`, JSON.stringify({ generatedAt: new Date().toISOString(),
    note: "Bond terms only. For market prices follow each bond's SIX link (SIX market data is licensed).", bonds: register }, null, 2));
  const live = register.filter((b) => b.maturity > today);
  console.log(`bonds: ${live.length} outstanding, ~${live.reduce((s, b) => s + (b.volumeMCHF ?? 0), 0)} M CHF (terms only)`);
  for (const b of live)
    console.log(`  ${b.isin}  ${b.coupon.toFixed(4).padStart(7)}%  ${b.maturity}  ${String(b.volumeMCHF ?? "?").padStart(4)}M  ${b.kind === "private" ? "private" : "public "}`);

  const checked = await checkSources();
  writeFileSync(`${OUT}/sources.json`, JSON.stringify({ generatedAt: new Date().toISOString(), sources: checked }, null, 2));
  console.log(`\nsources: ${checked.length} mapped, ${checked.filter((s) => s.httpStatus === 200).length} reachable`);
  for (const s of checked.filter((s) => s.httpStatus !== 200)) console.log(`  ! ${s.id}: ${s.httpStatus ?? s.error}`);

  const years = await Promise.all(YEARS.map((y) => parseAnnex(y)));
  writeFileSync(`${OUT}/lugano-indicators.json`, JSON.stringify({
    comune: "Lugano",
    note: "Canton SEL annex. Amounts in CHF thousands. 'debitoNetto' is the canton's net public debt I " +
      "(gross debt minus financial assets), not the city's gross financial debt nor Moody's ratio.",
    years,
  }, null, 2));
  writeFileSync(`${OUT}/lugano-indicators.csv`, toCsv(years));

  for (const y of years) {
    console.log(`\nLugano ${y.year} — official indicators (rank among ${Math.max(...y.indicatori.map((i) => i.of))} comuni, 1 = best)`);
    for (const c of y.caveats) console.log(`  ⚠ ${c}`);
    for (const i of y.indicatori) {
      const med = i.cantonMedian === null ? "" : ` | median ${i.unit === "ratio" ? (i.cantonMedian * 100).toFixed(1) + "%" : Math.round(i.cantonMedian).toLocaleString("de-CH")}`;
      console.log(`  ${i.label.padEnd(50)} ${i.display.padStart(10)}  ${(i.rating?.label ?? "").padEnd(16)} ` +
        `${i.rank ? `#${i.rank}/${i.of}` : ""}${med}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
