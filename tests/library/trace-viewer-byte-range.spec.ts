/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import fs from 'fs';
import type http from 'http';
import type { TraceViewerFixtures } from '../config/traceViewerFixtures';
import { traceViewerFixtures } from '../config/traceViewerFixtures';
import { expect, playwrightTest } from '../config/browserTest';

const test = playwrightTest.extend<TraceViewerFixtures>(traceViewerFixtures);

test.skip(({ trace }) => trace === 'on');
test.slow();

// Checkly stores a run's trace inside a larger object and opens it with
// ?trace=<object url>&rangeStart=<start>&rangeEnd=<end>.
const prefix = crypto.randomBytes(1000);
const suffix = crypto.randomBytes(500);
const bigBodySize = 4 * 1024 * 1024;
let container: Buffer;
let traceStart: number;
let traceEnd: number;

test.beforeAll(async function recordTrace({ browser, server }, workerInfo) {
  const context = await browser.newContext();
  await context.tracing.start({ snapshots: true, screenshots: true });
  const page = await context.newPage();
  // Incompressible, so the trace is dominated by a resource the action list does not need.
  // Served by the server rather than page.route(), which would record the body in the action.
  const bigBody = crypto.randomBytes(bigBodySize);
  server.setRoute('/big.bin', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(bigBody);
  });
  await page.goto(server.EMPTY_PAGE);
  await page.setContent('<button>Click</button>');
  await page.evaluate(() => fetch('/big.bin').then(r => r.arrayBuffer()));
  await page.getByText('Click').click();
  const traceFile = workerInfo.project.outputDir + `/byte-range-trace-${workerInfo.workerIndex}.zip`;
  await context.tracing.stop({ path: traceFile });
  await context.close();

  const trace = await fs.promises.readFile(traceFile);
  container = Buffer.concat([prefix, trace, suffix]);
  traceStart = prefix.length;
  traceEnd = prefix.length + trace.length - 1;
});

type ServedRange = { start: number, end: number };

function serveContainer(server: { setRoute: (path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void }) {
  const served: ServedRange[] = [];
  server.setRoute('/assets.zip', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!match) {
      // The object is only ever read by range, like a ranged S3 object.
      res.writeHead(416);
      res.end();
      return;
    }
    const start = +match[1];
    const end = Math.min(+match[2], container.length - 1);
    served.push({ start, end });
    res.setHeader('Content-Range', `bytes ${start}-${end}/${container.length}`);
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(206);
    res.end(container.subarray(start, end + 1));
  });
  return served;
}

async function openRangedTrace(showTraceViewer: TraceViewerFixtures['showTraceViewer'], traceUrl: string) {
  const traceViewer = await showTraceViewer(undefined);
  const url = new URL(traceViewer.page.url());
  url.search = new URLSearchParams({ trace: traceUrl, rangeStart: String(traceStart), rangeEnd: String(traceEnd) }).toString();
  await traceViewer.page.goto(url.toString());
  return traceViewer;
}

const servedBytes = (served: ServedRange[]) => served.reduce((total, r) => total + r.end - r.start + 1, 0);

test('should load a trace from a byte range of a larger object', async ({ showTraceViewer, server }) => {
  const served = serveContainer(server);
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');

  await expect(traceViewer.actionTitles).toContainText([/Navigate/, /Set content/, /Evaluate/, /Click/]);
  const frame = await traceViewer.snapshotFrame('Set content');
  await expect(frame.locator('button')).toHaveText('Click');

  // Every read stays inside the trace's range of the object.
  expect(served.length).toBeGreaterThan(0);
  for (const range of served) {
    expect(range.start).toBeGreaterThanOrEqual(traceStart);
    expect(range.end).toBeLessThanOrEqual(traceEnd);
  }
});

test('should show actions without downloading the whole byte range', async ({ showTraceViewer, server }) => {
  const served = serveContainer(server);
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');

  await expect(traceViewer.actionTitles).toContainText([/Navigate/, /Set content/, /Evaluate/, /Click/]);
  // The 4MB response body is a resource the action list does not read.
  expect(servedBytes(served)).toBeLessThan(bigBodySize / 4);
});

test('should read a resource of a ranged trace when it is opened', async ({ showTraceViewer, server }) => {
  const served = serveContainer(server);
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');
  await expect(traceViewer.actionTitles).toContainText([/Evaluate/]);
  const beforeOpen = servedBytes(served);

  await traceViewer.selectAction('Evaluate');
  await traceViewer.showNetworkTab();
  await traceViewer.networkRequests.getByText('big.bin').click();
  await traceViewer.networkTab.getByRole('tab', { name: 'Response' }).click();
  await expect.poll(() => servedBytes(served) - beforeOpen).toBeGreaterThanOrEqual(bigBodySize);
});

test('should show an error when the trace cannot be read', async ({ showTraceViewer, server }) => {
  server.setRoute('/assets.zip', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.writeHead(req.method === 'OPTIONS' ? 204 : 403);
    res.end();
  });
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');
  await expect(traceViewer.page.getByText(/Could not load trace from/)).toBeVisible();
});
