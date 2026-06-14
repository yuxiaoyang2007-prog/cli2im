#!/usr/bin/env node
const fs = require("node:fs");

const outFile = process.argv[2];
let stdin = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (!outFile) process.exit(0);
  try {
    const parsed = stdin.trim() ? JSON.parse(stdin) : {};
    fs.writeFileSync(outFile, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (error) {
    fs.writeFileSync(outFile, `${JSON.stringify({ parse_error: String(error), raw: stdin })}\n`);
  }
});
