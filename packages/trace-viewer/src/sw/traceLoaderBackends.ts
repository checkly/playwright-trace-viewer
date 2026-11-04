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

  constructor(traceUri: string, progress: Progress) {
    zipjs.configure({ baseURL: self.location.href } as any);

    const { url, range } = splitByteRange(traceUri);
    const resolvedUrl = this._resolveTraceURI(url);
    const reader = range
      ? new ByteRangeReader(resolvedUrl, range.start, range.end)
      : new zipjs.HttpReader(resolvedUrl, { mode: 'cors', preventHeadRequest: true } as any);
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

// Small reads (the end of central directory, local file headers, small resources) are
// rounded up to this, so a header and its entry usually come back in one request.
const byteRangeReadAhead = 64 * 1024;

// Reads the zip stored at bytes `start`-`end` (inclusive) of a larger object, fetching
// only the parts zip.js asks for. Showing the actions needs the central directory and the
// trace entries, not the resources, which are most of a trace's bytes.
class ByteRangeReader extends zipjs.Reader<string> {
  private _url: string;
  private _start: number;
  private _buffer: { offset: number, data: Uint8Array } | undefined;

  constructor(url: string, start: number, end: number) {
    super(url);
    this._url = url;
    this._start = start;
    this.size = end - start + 1;
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    length = Math.min(length, this.size - index);
    // zip.js may transfer the arrays it gets, so the read-ahead buffer only hands out copies.
    const buffer = this._buffer;
    if (buffer && index >= buffer.offset && index + length <= buffer.offset + buffer.data.length)
      return buffer.data.slice(index - buffer.offset, index - buffer.offset + length);
    const fetchLength = Math.min(Math.max(length, byteRangeReadAhead), this.size - index);
    const data = await this._fetch(index, fetchLength);
    if (fetchLength === length)
      return data;
    this._buffer = { offset: index, data };
    return data.slice(0, length);
  }

  private async _fetch(index: number, length: number): Promise<Uint8Array> {
    const first = this._start + index;
    const response = await fetch(this._url, { mode: 'cors', headers: { Range: `bytes=${first}-${first + length - 1}` } });
    // A 200 would be the whole object, not the requested bytes.
    if (response.status !== 206)
      throw new Error(`Expected a partial response, got ${response.status} ${response.statusText}`);
    return new Uint8Array(await response.arrayBuffer());
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
