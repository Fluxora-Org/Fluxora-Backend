#!/usr/bin/env node
"use strict";

const fs = require("fs");

const reportPath = process.argv[2] || "live-db-vitest.json";
if (!process.env.DATABASE_URL) {
  console.error("Live database tests require DATABASE_URL in CI.");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error("Unable to read Vitest JSON report: " + error.message);
  process.exit(1);
}

const assertions = (report.testResults || []).flatMap(function (file) {
  return file.assertionResults || [];
});
const liveAssertions = assertions.filter(function (test) {
  return (test.ancestorTitles || []).some(function (title) {
    return title.includes("live DB");
  });
});
const skipped = liveAssertions.filter(function (test) {
  return test.status === "pending" || test.status === "skipped" || test.status === "todo";
});
const passed = liveAssertions.filter(function (test) {
  return test.status === "passed";
});

console.log("Live database tests executed: " + passed.length);
if (liveAssertions.length === 0) {
  console.error("No live database tests were reported; the suite may have been skipped.");
  process.exit(1);
}
if (skipped.length > 0 || passed.length !== liveAssertions.length) {
  console.error("Live database tests must all execute; found " + skipped.length + " skipped test(s).");
  process.exit(1);
}
