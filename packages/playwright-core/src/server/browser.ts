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

import { Artifact } from './artifact';
import { BrowserContext, validateBrowserContextOptions } from './browserContext';
import { Download } from './download';
import { SdkObject } from './instrumentation';
import { Page } from './page';
import { ClientCertificatesProxy } from './socksClientCertificatesInterceptor';

import type * as types from './types';
import type { ProxySettings } from './types';
import type { RecentLogsCollector } from './utils/debugLogger';
import type * as channels from '@protocol/channels';
import type { ChildProcess } from 'child_process';
import type { Language } from '../utils';
import type { Progress } from './progress';


export interface BrowserProcess {
  onclose?: ((exitCode: number | null, signal: string | null) => void);
  process?: ChildProcess;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export type BrowserOptions = {
  name: string,
  isChromium: boolean,
  channel?: string,
  artifactsDir: string;
  downloadsPath: string,
  tracesDir: string,
  headful?: boolean,
  persistent?: types.BrowserContextOptions,  // Undefined means no persistent context.
  browserProcess: BrowserProcess,
  customExecutablePath?: string;
  proxy?: ProxySettings,
  protocolLogger: types.ProtocolLogger,
  browserLogsCollector: RecentLogsCollector,
  slowMo?: number;
  wsEndpoint?: string;  // Only there when connected over web socket.
  sdkLanguage?: Language;
  originalLaunchOptions: types.LaunchOptions;
};

export abstract class Browser extends SdkObject {

  static Events = {
    Context: 'context',
    Disconnected: 'disconnected',
  };

  readonly options: BrowserOptions;
  private _downloads = new Map<string, Download>();
  _defaultContext: BrowserContext | null = null;
  private _startedClosing = false;
  readonly _idToVideo = new Map<string, { context: BrowserContext, artifact: Artifact }>();
  private _contextForReuse: { context: BrowserContext, hash: string } | undefined;
  _closeReason: string | undefined;
  _isCollocatedWithServer: boolean = true;

  constructor(parent: SdkObject, options: BrowserOptions) {
    super(parent, 'browser');
    this.attribution.browser = this;
    this.options = options;
    this.instrumentation.onBrowserOpen(this);
  }

  abstract doCreateNewContext(options: types.BrowserContextOptions): Promise<BrowserContext>;
  abstract contexts(): BrowserContext[];
  abstract isConnected(): boolean;
  abstract version(): string;
  abstract userAgent(): string;

  sdkLanguage() {
    return this.options.sdkLanguage || this.attribution.playwright.options.sdkLanguage;
  }

  async newContext(progress: Progress, options: types.BrowserContextOptions): Promise<BrowserContext> {
    validateBrowserContextOptions(options, this.options);
    let clientCertificatesProxy: ClientCertificatesProxy | undefined;
    let context: BrowserContext | undefined;
    try {
      if (options.clientCertificates?.length) {
        clientCertificatesProxy = await ClientCertificatesProxy.create(progress, options);
        options = { ...options };
        options.proxyOverride = clientCertificatesProxy.proxySettings();
        options.internalIgnoreHTTPSErrors = true;
      }
      context = await progress.race(this.doCreateNewContext(options));
      context._clientCertificatesProxy = clientCertificatesProxy;
      if ((options as any).__testHookBeforeSetStorageState)
        await progress.race((options as any).__testHookBeforeSetStorageState());
      await context.setStorageState(progress, options.storageState, 'initial');
      this.emit(Browser.Events.Context, context);
      return context;
    } catch (error) {
      await context?.close({ reason: 'Failed to create context' }).catch(() => {});
      await clientCertificatesProxy?.close().catch(() => {});
      throw error;
    }
  }

  async newContextForReuse(progress: Progress, params: channels.BrowserNewContextForReuseParams): Promise<BrowserContext> {
    const hash = BrowserContext.reusableContextHash(params);
    if (!this._contextForReuse || hash !== this._contextForReuse.hash || !this._contextForReuse.context.canResetForReuse()) {
      if (this._contextForReuse)
        await this._contextForReuse.context.close({ reason: 'Context reused' });
      this._contextForReuse = { context: await this.newContext(progress, params), hash };
      return this._contextForReuse.context;
    }
    await this._contextForReuse.context.resetForReuse(progress, params);
    return this._contextForReuse.context;
  }

  contextForReuse() {
    return this._contextForReuse?.context;
  }

  _downloadCreated(page: Page, uuid: string, url: string, suggestedFilename?: string) {
    const download = new Download(page, this.options.downloadsPath || '', uuid, url, suggestedFilename);
    this._downloads.set(uuid, download);
  }

  _downloadFilenameSuggested(uuid: string, suggestedFilename: string) {
    const download = this._downloads.get(uuid);
    if (!download)
      return;
    download._filenameSuggested(suggestedFilename);
  }

  _downloadFinished(uuid: string, error?: string) {
    const download = this._downloads.get(uuid);
    if (!download)
      return;
    download.artifact.reportFinished(error ? new Error(error) : undefined);
    this._downloads.delete(uuid);
  }

  _videoStarted(context: BrowserContext, videoId: string, path: string, pageOrError: Promise<Page | Error>) {
    const artifact = new Artifact(context, path);
    this._idToVideo.set(videoId, { context, artifact });
    pageOrError.then(page => {
      if (page instanceof Page) {
        page.video = artifact;
        page.emitOnContext(BrowserContext.Events.VideoStarted, artifact);
        page.emit(Page.Events.Video, artifact);
      }
    });
  }

  _takeVideo(videoId: string): Artifact | undefined {
    const video = this._idToVideo.get(videoId);
    this._idToVideo.delete(videoId);
    return video?.artifact;
  }

  _didClose() {
    for (const context of this.contexts())
      context._browserClosed();
    if (this._defaultContext)
      this._defaultContext._browserClosed();
    this.emit(Browser.Events.Disconnected);
    this.instrumentation.onBrowserClose(this);
  }

  async close(options: { reason?: string }) {
    if (!this._startedClosing) {
      if (options.reason)
        this._closeReason = options.reason;
      this._startedClosing = true;
      await this.options.browserProcess.close();
    }
    if (this.isConnected())
      await new Promise(x => this.once(Browser.Events.Disconnected, x));
  }

  async killForTests() {
    await this.options.browserProcess.kill();
  }
}
