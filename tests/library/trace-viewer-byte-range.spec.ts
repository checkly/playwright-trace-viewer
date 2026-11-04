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
const noteBody = 'response body read from memory';
let container: Buffer;
let bigBodySha1: string;
let bigBodyMiddle: number;
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
  server.setRoute('/note.txt', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end(noteBody);
  });
  await page.evaluate(() => Promise.all([fetch('/big.bin').then(r => r.arrayBuffer()), fetch('/note.txt').then(r => r.text())]));
  await page.getByText('Click').click();
  const traceFile = workerInfo.project.outputDir + `/byte-range-trace-${workerInfo.workerIndex}.zip`;
  await context.tracing.stop({ path: traceFile });
  await context.close();

  const trace = await fs.promises.readFile(traceFile);
  container = Buffer.concat([prefix, trace, suffix]);
  bigBodySha1 = crypto.createHash('sha1').update(bigBody).digest('hex');
  bigBodyMiddle = container.indexOf(bigBody.subarray(bigBodySize / 2, bigBodySize / 2 + 32));
  traceStart = prefix.length;
  traceEnd = prefix.length + trace.length - 1;
});

type ServedRange = { start: number, end: number };
type Server = { setRoute: (path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) => void };

// Serves the container by range, like S3. A response that would take the total past `budget`
// bytes waits for release(). The first request covering `failOnceAt` gets a 503.
// After expire(), every request gets a 403, like an expired signed url.
function serveContainer(server: Server, { budget = Infinity, failOnceAt }: { budget?: number, failOnceAt?: number } = {}) {
  const served: ServedRange[] = [];
  const held: (() => void)[] = [];
  let released = false;
  let expired = false;
  let rejected = 0;
  let failed = 0;
  server.setRoute('/assets.zip', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (expired) {
      rejected++;
      res.writeHead(403);
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
    if (failOnceAt !== undefined && !failed && start <= failOnceAt && failOnceAt <= end) {
      failed++;
      res.writeHead(503);
      res.end();
      return;
    }
    const respond = () => {
      served.push({ start, end });
      res.setHeader('Content-Range', `bytes ${start}-${end}/${container.length}`);
      res.setHeader('Content-Length', end - start + 1);
      res.writeHead(206);
      res.end(container.subarray(start, end + 1));
    };
    if (released || servedBytes(served) + end - start + 1 <= budget)
      respond();
    else
      held.push(respond);
  });
  return {
    served,
    release: () => {
      released = true;
      held.splice(0).forEach(respond => respond());
    },
    expire: () => expired = true,
    rejected: () => rejected,
    failed: () => failed,
  };
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
  const { served } = serveContainer(server);
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

test('should show actions while most of the byte range is still unread', async ({ showTraceViewer, server }) => {
  // The 4MB response body is a resource the action list does not read.
  const { release } = serveContainer(server, { budget: bigBodySize / 4 });
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');

  await expect(traceViewer.actionTitles).toContainText([/Navigate/, /Set content/, /Evaluate/, /Click/]);
  release();
});

test('should open resources after the trace url stops working', async ({ showTraceViewer, server }) => {
  const { served, expire, rejected } = serveContainer(server);
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');
  await expect(traceViewer.actionTitles).toContainText([/Evaluate/]);

  // The rest of the trace is read in the background, each byte once.
  await expect.poll(() => servedBytes(served)).toBe(traceEnd - traceStart + 1);
  const sorted = [...served].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++)
    expect(sorted[i].start).toBe(sorted[i - 1].end + 1);

  expire();
  await traceViewer.selectAction('Evaluate');
  await traceViewer.showNetworkTab();
  await traceViewer.networkRequests.getByText('note.txt').click();
  await traceViewer.networkTab.getByRole('tab', { name: 'Response' }).click();
  await expect(traceViewer.networkTab).toContainText(noteBody);
  expect(rejected()).toBe(0);
});

test('should fetch a failed block again and serve resources across blocks', async ({ showTraceViewer, server }) => {
  expect(bigBodyMiddle).toBeGreaterThan(traceStart);
  const { served, expire, failed } = serveContainer(server, { failOnceAt: bigBodyMiddle });
  const traceViewer = await openRangedTrace(showTraceViewer, server.PREFIX + '/assets.zip');
  await expect(traceViewer.actionTitles).toContainText([/Evaluate/]);

  // The block the 503 hit is in the middle of the response body, which only the background read needs.
  await expect.poll(() => servedBytes(served)).toBe(traceEnd - traceStart + 1);
  expect(failed()).toBe(1);

  expire();
  const sha1 = await traceViewer.page.evaluate(async ({ file, start, end }) => {
    const trace = new URL(location.href).searchParams.get('trace');
    const response = await fetch(`file/${file}?trace=${encodeURIComponent(`${trace}#bytes=${start}-${end}`)}`);
    const digest = await window.crypto.subtle.digest('SHA-1', await response.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }, { file: `resources/${bigBodySha1}.bin`, start: traceStart, end: traceEnd });
  expect(sha1).toBe(bigBodySha1);
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
