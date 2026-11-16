// Driver for the make.fun markdown-render-speed-02 entry.
//
// Reads every case from the input directory (cases.json: an array of
// {id, markdown}), renders each one alone with parse() from parse.js, and
// writes the HTML strings to the output directory as html.json, one per
// case and in the cases' order.
//
// In the grading container the input and output directories are /input and
// /output. Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

function main(): void {
  const cases = JSON.parse(
    readFileSync(join(inputDir, 'cases.json'), 'utf8'),
  ) as Case[];
  const html: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    html[k] = parse(cases[k].markdown);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
