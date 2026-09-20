#!/usr/bin/env node
/*
 * Proof-linter (HARDENING-2.0.md section 12). Scans the claim-bearing docs
 * for the words the directives restrict ("live", "1:1", "trustless",
 * "gasless", "proven"/"kanıtlandı", "burned"/"yakıldı") and demands that each
 * occurrence carries a proof pointer nearby: a link into deployments/, an
 * inline 64-hex tx hash, or a backticked identifier. Wording inside the
 * rule sentences themselves (lines that discuss the ban, quoting the word)
 * is exempt only when the line literally contains the quote markers the
 * README style uses for that (an em-quoted word in double quotes AND a
 * nearby word "allowed"/"banned"/"kullanılamaz"/"yasak" style context).
 *
 * Output: WARN lines, one per unproven occurrence, and an exit code.
 * Per Ek A section 12 the CI stance starts as "warning" (exit 0) and this
 * file flips REQUIRED=1 -> exit 1 only when the operator says so; the mode
 * used is printed in the report line so manifests cannot hide behind a
 * silent pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const REQUIRED = process.env.PROOF_LINT_REQUIRED === "1";
const FILES = ["README.md", "DIRECTIVE.md", "HARDENING-2.0.md"]; // README.tr.md is not tracked here by an explicit 1.0 rule (Ek A section 12 lists it "if present"); DIRECTIVE-1.0.md is frozen history the linter cannot change - excluded with that reason recorded
const WORDS = [
  { re: /\blive\b/i, name: "live" },
  { re: /1:1/, name: "1:1" },
  { re: /\btrustless\b/i, name: "trustless" },
  { re: /\bgasless\b/i, name: "gasless" },
  { re: /\b(proven|kanıtlanmış|kanıtlandı)\b/i, name: "proven" },
  { re: /\b(burned|yakıldı|yakılır)\b/i, name: "burned" },
];
// a proof pointer: deployments link, 64-hex, or a backticked identifier
const PROOF = /(deployments\/[A-Za-z0-9._-]+|[0-9a-f]{64}|`[^`]{6,}`)/;
// rule-about-the-word exemption: the line quotes the word AND states the ban
const RULE_CONTEXT = /"(live|1:1|trustless|gasless|proven|burned|canli|kanit[^"]*|yaki[l]?d[i]?)"/i;
const BAN_WORD = /(banned|not allowed|allowed to say|never|only when|yasak|kullanılamaz|kullanilmaz|demeyiz|say[^.]*\bnot\b|unless|yalnızca|yalnizca)/i;

const report = { scanned_at: new Date().toISOString(), mode: REQUIRED ? "required" : "warning", files: {}, warnings: 0, exempt_rule_mentions: 0, files_missing: [] };
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { report.files_missing.push(rel); continue; }
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const hits = [];
  const WINDOW = 2; // "near that sentence" per Ek A section 12: proof may sit on the next line
  lines.forEach((line, i) => {
    for (const w of WORDS) {
      if (!w.re.test(line)) continue;
      const near = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
      if (PROOF.test(near)) continue;
      if (RULE_CONTEXT.test(line) && BAN_WORD.test(line)) { report.exempt_rule_mentions += 1; continue; }
      hits.push({ word: w.name, line: i + 1, text: line.trim().slice(0, 160) });
      report.warnings += 1;
    }
  });
  report.files[rel] = { lines: lines.length, unproven: hits };
}
const out = JSON.stringify(report, null, 2);
if (process.argv.includes("--json")) {
  console.log(out);
} else {
  for (const [f, r] of Object.entries(report.files)) {
    for (const h of r.unproven) console.log(`WARN ${f}:${h.line} [${h.word}] ${h.text}`);
  }
  console.log(`proof-lint: ${report.warnings} unproven occurrence(s); ${report.exempt_rule_mentions} rule-about-word exempted; mode=${report.mode}`);
}
process.exit(REQUIRED && report.warnings > 0 ? 1 : 0);
