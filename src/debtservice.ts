// Bond debt service: the interest (coupons) and repayments the City pays on its bonds, year by year.
// Computed from the bond register (terms only: volume, coupon, maturity, first trading day); no market data.
//   - one coupon a year, on the anniversary of the maturity day; the first one about a year after issue
//     (an anniversary within 30 days of issue is not a coupon date), the last one at maturity with the repayment;
//   - accrued interest per calendar year = volume × coupon × days outstanding / 365 (what the accounts book);
//   - schedule as contracted: no refinancing assumed.
// Check: 2024 accrued bond interest must not exceed interest expense (account 340) in the canton's 2024 annex.
//
//   npm run debtservice   → out/debt-service.json

import * as XLSX from "xlsx";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BONDS, type Bond } from "./bonds";

const FIRST_YEAR = 2024; // the register is complete from end-2023 on (matured bonds kept from 2024)
const DAY = 86_400_000;
const d = (s: string) => new Date(s + "T00:00:00Z");
const iso = (t: Date) => t.toISOString().slice(0, 10);

export interface Payment { date: string; interestM: number; redemptionM: number }

/** Coupon dates and amounts of one bond from FIRST_YEAR on. */
export function schedule(b: Bond): Payment[] {
  if (b.volumeMCHF === null) return [];
  const mat = d(b.maturity), [, mm, dd] = b.maturity.split("-");
  const issue = b.listed ? d(b.listed) : null;
  // no first trading day recorded: issued before FIRST_YEAR (private placements and the matured issues)
  const out: Payment[] = [];
  for (let y = FIRST_YEAR; y <= mat.getUTCFullYear(); y++) {
    const date = d(`${y}-${mm}-${dd}`);
    if (issue && date.getTime() - issue.getTime() <= 30 * DAY) continue; // before or right after issue: no coupon yet
    const last = date.getTime() === mat.getTime();
    out.push({ date: iso(date), interestM: (b.volumeMCHF * b.coupon) / 100, redemptionM: last ? b.volumeMCHF : 0 });
  }
  return out;
}

/** Interest accrued in calendar year y (days outstanding / 365). */
export function accrued(b: Bond, y: number) {
  if (b.volumeMCHF === null) return 0;
  const from = Math.max(d(`${y}-01-01`).getTime(), b.listed ? d(b.listed).getTime() : -Infinity);
  const to = Math.min(d(`${y + 1}-01-01`).getTime(), d(b.maturity).getTime());
  return to > from ? (b.volumeMCHF * b.coupon) / 100 * ((to - from) / DAY) / 365 : 0;
}

function selfTest() {
  const by = (isin: string) => BONDS.find((b) => b.isin === isin)!;
  const years = (isin: string) => schedule(by(isin)).map((p) => p.date);
  const expect = (ok: boolean, what: string) => { if (!ok) throw new Error(`SCHEDULE TEST FAILED: ${what}`); };
  // issued 15.7.2026, coupon day 16.7: first coupon 16.7.2027, none in 2026
  expect(years("CH1562934682")[0] === "2027-07-16", "2036 bond: first coupon 2027-07-16");
  // issued 7.3.2024 with coupon day 7.3: first coupon 2025
  expect(years("CH1319968462")[0] === "2025-03-07", "2034 bond: first coupon 2025-03-07");
  // issued 12.6.2025, coupon day 16.6: first coupon 16.6.2026
  expect(years("CH1433241267")[0] === "2026-06-16", "2032 bond: first coupon 2026-06-16");
  // matured 9.12.2024: one coupon in 2024 with the repayment
  const m = schedule(by("CH0261541863"));
  expect(m.length === 1 && m[0].redemptionM === 100, "2024 bond: last coupon and repayment on 2024-12-09");
  // 2070 bond pays every year to 2070
  expect(years("CH0579132918").length === 2070 - FIRST_YEAR + 1, "2070 bond: one coupon a year");
}

/** Interest expense (account 340) for Lugano in the canton's 2024 annex, CHF thousands. */
function interestExpense2024() {
  const wb = XLSX.read(readFileSync("data/raw/2024-allegato.xlsx"));
  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets["tab9c"], { header: 1, blankrows: false });
  const head = rows.find((r) => r.some((c) => String(c).startsWith("340")));
  const i = head?.findIndex((c) => /^340\s*\n?\s*spese per interessi/.test(String(c))) ?? -1;
  const row = rows.find((r) => String(r[0]).trim() === "Lugano");
  if (i < 0 || !row || typeof row[i] !== "number") throw new Error("2024 annex: account 340 for Lugano not found");
  return row[i] as number;
}

function main() {
  selfTest();
  const today = new Date().toISOString().slice(0, 10);
  const bonds = BONDS.map((b) => ({ isin: b.isin, coupon: b.coupon, volumeM: b.volumeMCHF, maturity: b.maturity, listed: b.listed, kind: b.kind ?? "public", payments: schedule(b) }));
  const lastYear = Math.max(...BONDS.map((b) => d(b.maturity).getUTCFullYear()));
  const byYear = [];
  for (let y = FIRST_YEAR; y <= lastYear; y++) {
    const pays = bonds.flatMap((b) => b.payments.filter((p) => p.date.startsWith(String(y))));
    const outstandingEnd = BONDS.filter((b) => b.volumeMCHF && b.maturity > `${y}-12-31` && (!b.listed || b.listed <= `${y}-12-31`)).reduce((s, b) => s + b.volumeMCHF!, 0);
    byYear.push({ year: y, interestPaidM: round(pays.reduce((s, p) => s + p.interestM, 0)), interestAccruedM: round(BONDS.reduce((s, b) => s + accrued(b, y), 0)),
      redemptionM: pays.reduce((s, p) => s + p.redemptionM, 0), outstandingEndM: outstandingEnd });
  }
  const live = BONDS.filter((b) => b.volumeMCHF && b.maturity > today && (!b.listed || b.listed <= today));
  const vol = live.reduce((s, b) => s + b.volumeMCHF!, 0), run = live.reduce((s, b) => s + (b.volumeMCHF! * b.coupon) / 100, 0);
  const unknown = BONDS.filter((b) => b.volumeMCHF === null).map((b) => b.isin);

  const expense = interestExpense2024() / 1000, bond24 = byYear[0].interestAccruedM;
  const checks = { bondInterestWithinAccounts2024: bond24 <= expense };
  if (!checks.bondInterestWithinAccounts2024) throw new Error(`CHECK FAILED: 2024 bond interest ${bond24} > interest expense ${expense}`);

  mkdirSync("out", { recursive: true });
  writeFileSync("out/debt-service.json", JSON.stringify({
    generatedAt: new Date().toISOString(), asOf: today,
    method: "Computed from the bond register (terms only). One coupon a year on the maturity anniversary, the first about a year after issue; accrued interest by days outstanding / 365. Contracted schedule, no refinancing assumed. Volumes are issue volumes.",
    today: { bondCount: live.length, outstandingM: vol, annualInterestM: round(run), averageCouponPct: round((run / vol) * 100, 4) },
    accounts2024: { interestExpenseM: round(expense), bondInterestAccruedM: bond24, bondSharePct: round((bond24 / expense) * 100, 1),
      source: "2024-allegato.xlsx, sheet tab9c, column 340 'spese per interessi', row 'Lugano' (CHF thousands)" },
    checks, unknownVolume: unknown, byYear, bonds,
  }, null, 2) + "\n");

  console.log(`today (${today}): ${live.length} bonds, ${vol}M outstanding, ${round(run)}M interest a year (average ${round((run / vol) * 100, 3)}%)`);
  console.log(`2024: bond interest accrued ${bond24}M of ${round(expense)}M interest expense (account 340) ✓`);
  console.log("year  paid   accrued  repaid  outstanding");
  for (const r of byYear.filter((r) => r.year <= 2036 || r.redemptionM)) console.log(`${r.year}  ${r.interestPaidM.toFixed(2).padStart(5)}  ${r.interestAccruedM.toFixed(2).padStart(6)}  ${String(r.redemptionM).padStart(6)}  ${String(r.outstandingEndM).padStart(6)}`);
  if (unknown.length) console.log(`volume unknown, left out: ${unknown.join(", ")}`);
}

const round = (v: number, dp = 3) => Number(v.toFixed(dp));

if (require.main === module) main();
