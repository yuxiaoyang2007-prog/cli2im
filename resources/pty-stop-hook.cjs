#!/usr/bin/env node
const fs = require("node:fs");

const outFile = process.argv[2];
const fallbackSessionId = process.argv[3] || undefined;
let stdin = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (!outFile) process.exit(0);
  let payload = {};
  try {
    payload = stdin.trim() ? JSON.parse(stdin) : {};
  } catch {
    payload = {};
  }

  const marker = {
    hook_event_name: payload.hook_event_name || "Stop",
    session_id: payload.session_id || fallbackSessionId,
    transcript_path: payload.transcript_path,
    turnSeq: Number(payload.turnSeq || payload.turn_seq || Date.now()),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(outFile, `${JSON.stringify(marker)}\n`);
});
