/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// @ts-ignore
import * as zipImport from '@zip.js/zip.js/lib/zip-no-worker-inflate.js';
import { splitByteRange } from '@isomorphic/trace/traceByteRange';

import type * as zip from '@zip.js/zip.js';
import type { TraceLoaderBackend } from '@isomorphic/trace/traceLoader';

const zipjs = zipImport as typeof zip;

type Progress = (done: number, total: number) => undefined;

export class ZipTraceLoaderBackend implements TraceLoaderBackend {
  private _zipReader: zip.ZipReader<unknown>;
  private _entriesPromise: Promise<Map<string, zip.Entry>>;
  private _blockReader: BlockRangeReader | undefined;

  constructor(traceUri: string, progress: Progress) {
    zipjs.configure({ baseURL: self.location.href } as any);

    const { url, range } = splitByteRange(traceUri);
    const resolvedUrl = this._resolveTraceURI(url);
    this._blockReader = range ? new BlockRangeReader(resolvedUrl, range.start, range.end) : undefined;
    const reader = this._blockReader ?? new zipjs.HttpReader(resolvedUrl, { mode: 'cors', preventHeadRequest: true } as any);
    this._zipReader = new zipjs.ZipReader(reader, { useWebWorkers: false });
    this._entriesPromise = this._zipReader.getEntries({ onprogress: progress }).then(entries => {
      const map = new Map<string, zip.Entry>();
      for (const entry of entries)
        map.set(entry.filename, entry);
      return map;
    });
  }

  private _resolveTraceURI(traceUri: string): string {
    if (traceUri.startsWith('https://www.dropbox.com/'))
      return 'https://dl.dropboxusercontent.com/' + traceUri.substring('https://www.dropbox.com/'.length);
    return traceUri;
  }

  isLive() {
    return false;
  }

  // Called once the actions are shown. Reads the rest of a ranged trace in the background,
  // so resources open from memory later, including after the signed trace url expires.
  prefetch() {
    this._blockReader?.fill();
  }

  async entryNames(): Promise<string[]> {
    const entries = await this._entriesPromise;
    return [...entries.keys()];
  }

  async hasEntry(entryName: string): Promise<boolean> {
    const entries = await this._entriesPromise;
    return entries.has(entryName);
  }

  async readText(entryName: string): Promise<string | undefined> {
    const entries = await this._entriesPromise;
    const entry = entries.get(entryName);
    if (!entry)
      return;
    const writer = new zipjs.TextWriter();
    await entry.getData?.(writer);
    return writer.getData();
  }

  async readBlob(entryName: string): Promise<Blob | undefined> {
    const entries = await this._entriesPromise;
    const entry = entries.get(entryName);
    if (!entry)
      return;
    const writer = new zipjs.BlobWriter() as zip.BlobWriter;
    await entry.getData!(writer);
    return writer.getData();
  }
}

// Reads are served from blocks of this size, each fetched once.
const blockSize = 256 * 1024;
// Concurrent fetches while filling in the rest of the trace in the background.
const fillConnections = 4;

// Reads the zip stored at bytes `start`-`end` (inclusive) of a larger object, fetching
// only the blocks zip.js asks for. Showing the actions needs the central directory and
// the trace entries, not the resources, which are most of a trace's bytes.
class BlockRangeReader extends zipjs.Reader<string> {
  private _url: string;
  private _start: number;
  private _blocks: (Promise<Uint8Array> | undefined)[] = [];

  constructor(url: string, start: number, end: number) {
    super(url);
    this._url = url;
    this._start = start;
    this.size = end - start + 1;
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    length = Math.min(length, this.size - index);
    const first = Math.floor(index / blockSize);
    const last = Math.floor((index + length - 1) / blockSize);
    const blocks = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => this._block(first + i)));
    // Always a fresh array, because zip.js may transfer the arrays it gets.
    const result = new Uint8Array(length);
    let written = 0;
    for (let i = 0; i < blocks.length; i++) {
      const blockStart = (first + i) * blockSize;
      const from = Math.max(index, blockStart) - blockStart;
      const to = Math.min(index + length, blockStart + blocks[i].length) - blockStart;
      result.set(blocks[i].subarray(from, to), written);
      written += to - from;
    }
    return result;
  }

  fill() {
    const count = Math.ceil(this.size / blockSize);
    const fetched = (index: number) => this._block(index).then(() => true, () => false);
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const index = next++;
        // One retry covers a dropped connection. Failing twice means the url no longer works,
        // so reads fetch what is missing and report the error.
        if (!await fetched(index) && !await fetched(index))
          return;
      }
    };
    for (let i = 0; i < fillConnections; i++)
      void worker();
  }

  private _block(index: number): Promise<Uint8Array> {
    const cached = this._blocks[index];
    if (cached)
      return cached;
    const offset = index * blockSize;
    const block = this._fetch(offset, Math.min(blockSize, this.size - offset));
    this._blocks[index] = block;
    // A failed block is fetched again by the next read that needs it.
    block.catch(() => {
      if (this._blocks[index] === block)
        this._blocks[index] = undefined;
    });
    return block;
  }

  private async _fetch(offset: number, length: number): Promise<Uint8Array> {
    const first = this._start + offset;
    const response = await fetch(this._url, { mode: 'cors', headers: { Range: `bytes=${first}-${first + length - 1}` } });
    // A 200 would be the whole object, not the requested bytes.
    if (response.status !== 206)
      throw new Error(`Expected a partial response, got ${response.status} ${response.statusText}`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length !== length)
      throw new Error(`Expected ${length} bytes, got ${data.length}`);
    return data;
  }
}

export class FetchTraceLoaderBackend implements TraceLoaderBackend {
  private _entriesPromise: Promise<Map<string, string>>;

  constructor(traceUri: string) {
    this._entriesPromise = this._readFile(traceUri).then(async response => {
      if (!response)
        throw new Error('File not found');
      const json = await response.json();
      const entries = new Map<string, string>();
      for (const entry of json.entries)
        entries.set(entry.name, entry.path);
      return entries;
    });
  }

  isLive() {
    return true;
  }

  async entryNames(): Promise<string[]> {
    const entries = await this._entriesPromise;
    return [...entries.keys()];
  }

  async hasEntry(entryName: string): Promise<boolean> {
    const entries = await this._entriesPromise;
    return entries.has(entryName);
  }

  async readText(entryName: string): Promise<string | undefined> {
    const response = await this._readEntry(entryName);
    return response?.text();
  }

  async readBlob(entryName: string): Promise<Blob | undefined> {
    const response = await this._readEntry(entryName);
    return response?.status === 200 ? await response?.blob() : undefined;
  }

  private async _readEntry(entryName: string): Promise<Response | undefined> {
    const entries = await this._entriesPromise;
    const fileUri = entries.get(entryName);
    if (!fileUri)
      return;
    return this._readFile(fileUri);
  }

  private async _readFile(uri: string): Promise<Response | undefined> {
    const response = await fetch(uri);
    if (response.status === 404)
      return;
    return response;
  }
}
