import assert from "node:assert/strict";

import { extractBlueGolfCourseSlug, parseScorecardCourseInfo } from "./bluegolf_import.js";

let nodeTest = null;
try {
  ({ default: nodeTest } = await import("node:test"));
} catch (_error) {
  nodeTest = null;
}

const fallbackTests = [];
function registerTest(name, fn) {
  if (nodeTest) {
    nodeTest(name, fn);
    return;
  }
  fallbackTests.push({ name, fn });
}

function scoreRow(label, values) {
  return `<tr><td>${label}</td>${values.map((value) => `<td>${value}</td>`).join("")}</tr>`;
}

const PARS = [4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5];
const HCP = [10, 4, 16, 2, 8, 14, 18, 6, 12, 11, 5, 17, 1, 7, 13, 15, 3, 9];
const BLACK_YARDS = [410, 420, 180, 430, 540, 425, 190, 410, 545, 415, 435, 205, 425, 560, 430, 195, 440, 556];
const BLUE_YARDS = [390, 401, 168, 402, 510, 398, 171, 389, 520, 401, 418, 188, 401, 533, 407, 180, 420, 545];

const SCORECARD_HTML = `
<!doctype html>
<html>
  <head>
    <title>Sherrill Park Course 1 - Detailed Scorecard | Course Database</title>
  </head>
  <body>
    <li class="nav-item pl-0 ml-0">Richardson, TX</li>
    <ul class="dropdown-menu">
      <li>
        <a href="#dropdown-tee-black">
          <span class="ddm-first ddm-mid ddm-center">Black</span>
          <span class="stat">(M - 74.3 / 130)</span>
        </a>
      </li>
      <li>
        <a href="#dropdown-tee-blue">
          <span class="ddm-first ddm-mid ddm-center">Blue</span>
          <span class="stat">(M - 71.2 / 128)</span>
        </a>
      </li>
    </ul>

    <div class="text-uppercase tab-pane tee-tab active in" id="dropdown-tee-black">
      <span class="ddm-cell ddm-word text-uppercase">Black</span>
      <ul class="scorecard d-table-cell w-100">
        <li><span>7016</span><p>Yards</p></li>
        <li><span>72</span><p>Par</p></li>
        <li><span>74.3</span><p>Rating</p></li>
        <li><span>130</span><p>Slope</p></li>
      </ul>
      <table>
        ${scoreRow("Par", PARS)}
        ${scoreRow("Hcp", HCP)}
        ${scoreRow("Yds", BLACK_YARDS)}
      </table>
    </div>

    <div class="text-uppercase tab-pane tee-tab" id="dropdown-tee-blue">
      <span class="ddm-cell ddm-word text-uppercase">Blue</span>
      <ul class="scorecard d-table-cell w-100">
        <li><span>6642</span><p>Yards</p></li>
        <li><span>72</span><p>Par</p></li>
        <li><span>71.2</span><p>Rating</p></li>
        <li><span>128</span><p>Slope</p></li>
      </ul>
      <table>
        ${scoreRow("Par", PARS)}
        ${scoreRow("Hcp", HCP)}
        ${scoreRow("Yds", BLUE_YARDS)}
      </table>
    </div>
  </body>
</html>`;

registerTest("extractBlueGolfCourseSlug handles overview and scorecard URLs", () => {
  assert.equal(
    extractBlueGolfCourseSlug("https://course.bluegolf.com/bluegolf/course/course/sherrillpark1/overview.htm"),
    "sherrillpark1"
  );
  assert.equal(
    extractBlueGolfCourseSlug("https://course.bluegolf.com/bluegolf/course/course/sherrillpark1/detailedscorecard.htm"),
    "sherrillpark1"
  );
  assert.equal(
    extractBlueGolfCourseSlug("https://app.bluegolf.com/bluegolf/app/course/sherrillpark1/overview.json"),
    "sherrillpark1"
  );
});

registerTest("parseScorecardCourseInfo extracts pars, stroke index, and tee metadata", () => {
  const course = parseScorecardCourseInfo(SCORECARD_HTML);
  assert.equal(course.name, "Sherrill Park Course 1");
  assert.equal(course.location, "Richardson, TX");
  assert.deepEqual(course.pars, PARS);
  assert.deepEqual(course.strokeIndex, HCP);
  assert.equal(course.tees.length, 2);
  assert.equal(course.tees[0].teeName, "Black");
  assert.equal(course.tees[0].totalYards, 7016);
  assert.equal(course.tees[0].ratings[0].rating, 74.3);
  assert.equal(course.tees[0].ratings[0].slope, 130);
  assert.deepEqual(course.tees[0].holeYardages, BLACK_YARDS);
  assert.equal(course.longestTees.length, 2);
  assert.equal(course.longestTees[0].teeName, "Black");
  assert.equal(course.longestTees[0].ratings[0].rating, 74.3);
  assert.equal(course.longestTees[0].ratings[0].slope, 130);
});

if (!nodeTest) {
  let failures = 0;
  for (const { name, fn } of fallbackTests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failures > 0) process.exit(1);
}
