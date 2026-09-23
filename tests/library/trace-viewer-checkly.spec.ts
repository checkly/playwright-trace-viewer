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

import fs from 'fs';

import type { Page } from '@playwright/test';
import type { TraceViewerFixtures } from '../config/traceViewerFixtures';
import { traceViewerFixtures } from '../config/traceViewerFixtures';
import { expect, playwrightTest } from '../config/browserTest';

const test = playwrightTest.extend<TraceViewerFixtures>(traceViewerFixtures);

test.skip(({ trace }) => trace === 'on');
test.skip(process.env.PW_CLOCK === 'frozen');

test('should load different byte ranges from the same HTTP aggregate', async ({ asset, showTraceViewer, server }) => {
  const traces = await Promise.all([
    fs.promises.readFile(asset('trace-1.31.zip')),
    fs.promises.readFile(asset('trace-1.37.zip')),
  ]);
  const prefix = Buffer.from('aggregate-prefix');
  const separator = Buffer.from('aggregate-separator');
  const aggregate = Buffer.concat([prefix, traces[0], separator, traces[1], Buffer.alloc(66 * 1024)]);
  const ranges = [
    { start: prefix.byteLength, end: prefix.byteLength + traces[0].byteLength - 1 },
    { start: prefix.byteLength + traces[0].byteLength + separator.byteLength, end: prefix.byteLength + traces[0].byteLength + separator.byteLength + traces[1].byteLength - 1 },
  ];
  const receivedRanges: string[] = [];
  const aggregatePath = '/aggregate.bin?signature=a%2Fb';

  server.setRoute(aggregatePath, (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      response.end();
      return;
    }

    const rangeHeader = request.headers.range;
    const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? '');
    if (!match) {
      response.writeHead(400);
      response.end();
      return;
    }

    receivedRanges.push(rangeHeader!);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const body = aggregate.subarray(start, end + 1);
    response.writeHead(206, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${aggregate.byteLength}`,
      'Content-Length': body.byteLength,
      'Content-Type': 'application/octet-stream',
    });
    response.end(body);
  });

  const traceViewer = await showTraceViewer(undefined, { host: 'localhost' });
  const viewerUrl = new URL(traceViewer.page.url());
  const traceUrl = `${server.PREFIX}${aggregatePath}`;
  const openRange = async (page: Page, range: typeof ranges[number], expectedAction: RegExp) => {
    const url = new URL(viewerUrl);
    url.searchParams.set('trace', traceUrl);
    url.searchParams.set('rangeStart', String(range.start));
    url.searchParams.set('rangeEnd', String(range.end));
    await page.goto(url.toString());
    await expect(page.locator('.action-title').filter({ hasText: expectedAction })).toBeVisible();
  };

  await openRange(traceViewer.page, ranges[0], /click/i);
  const snapshot = await traceViewer.snapshotFrame('Click');
  await expect(snapshot.locator('[__playwright_target__]')).toHaveText(['Submit']);

  await openRange(traceViewer.page, ranges[1], /page\.goto/);

  expect(receivedRanges).toEqual(ranges.map(range => `bytes=${range.start}-${range.end}`));
});

test('should reject an incomplete byte range before fetching the aggregate', async ({ showTraceViewer, server }) => {
  let requestCount = 0;
  server.setRoute('/aggregate.bin', (_request, response) => {
    ++requestCount;
    response.writeHead(500);
    response.end();
  });

  const traceViewer = await showTraceViewer(undefined, { host: 'localhost' });
  const url = new URL(traceViewer.page.url());
  url.searchParams.set('trace', `${server.PREFIX}/aggregate.bin`);
  url.searchParams.set('rangeStart', '0');
  await traceViewer.page.goto(url.toString());

  await expect(traceViewer.page.getByRole('alert')).toContainText('rangeStart and rangeEnd must each be provided exactly once');
  expect(requestCount).toBe(0);
});
