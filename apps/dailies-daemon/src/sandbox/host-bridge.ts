import {
  type AriaSnapshotNode,
  createPlaywright,
  DispatcherConnection,
  type DispatcherConnectionLike,
  PlaywrightDispatcher,
  type PlaywrightDispatcherLike,
  RootDispatcher,
  type RootDispatcherLike,
  type WireMessage,
} from "./playwright-internals.js";
import { SnapshotTracker } from "./snapshot-tracking.js";

// A capture-enabled session context emits a `video` event (on BrowserContext /
// Page) that the vendored sandbox client has no event validator for. We withhold
// just that event. Everything else — including Artifact/Stream __create__ and the
// `download` event — is forwarded verbatim so downloads keep working; the daemon
// records video on its own real context regardless of what the sandbox sees.
const WITHHELD_EVENTS = new Set(["video"]);
const snapshotTracker = new SnapshotTracker();

interface BridgeMessage {
  method?: string;
}

export interface HostBridgeOptions {
  denyLaunch?: boolean;
  preLaunchedBrowser?: unknown;
  sdkLanguage?: string;
  sendToSandbox: (json: string) => void;
  sharedBrowser?: boolean;
}

export class HostBridge {
  private readonly dispatcherConnection: DispatcherConnectionLike;
  private readonly rootDispatcher: RootDispatcherLike;
  private readonly playwright: unknown;
  private readonly sendToSandbox: (json: string) => void;
  private readonly options: Omit<HostBridgeOptions, "sendToSandbox">;

  private playwrightDispatcher?: PlaywrightDispatcherLike;
  private disposed = false;
  private readonly trackedSnapshots = new Map<
    number,
    { document: object; key: string }
  >();

  constructor(options: HostBridgeOptions) {
    this.sendToSandbox = options.sendToSandbox;
    this.options = {
      preLaunchedBrowser: options.preLaunchedBrowser,
      sharedBrowser: options.sharedBrowser,
      denyLaunch: options.denyLaunch,
      sdkLanguage: options.sdkLanguage ?? "javascript",
    };
    this.playwright = createPlaywright({
      sdkLanguage: this.options.sdkLanguage ?? "javascript",
    });
    this.dispatcherConnection = new DispatcherConnection(false);
    this.dispatcherConnection.onmessage = (message) => {
      if (this.shouldWithhold(message as BridgeMessage)) {
        return;
      }
      this.sendToSandbox(JSON.stringify(this.finishTrackedSnapshot(message)));
    };
    this.rootDispatcher = new RootDispatcher(
      this.dispatcherConnection,
      async (rootScope) => {
        this.playwrightDispatcher = new PlaywrightDispatcher(
          rootScope,
          this.playwright,
          {
            preLaunchedBrowser: this.options.preLaunchedBrowser,
            sharedBrowser: this.options.sharedBrowser,
            denyLaunch: this.options.denyLaunch,
          }
        );
        return this.playwrightDispatcher;
      }
    );
  }

  // True when a host→sandbox protocol message must be withheld because the
  // vendored sandbox client has no validator for it. Only the `video` event
  // qualifies; the daemon still records video on its own real context.
  private shouldWithhold(message: BridgeMessage): boolean {
    return message.method ? WITHHELD_EVENTS.has(message.method) : false;
  }

  async receiveFromSandbox(json: string): Promise<void> {
    const message = JSON.parse(json) as WireMessage;
    await this.dispatcherConnection.dispatch(
      this.prepareTrackedSnapshot(message)
    );
  }

  private prepareTrackedSnapshot(message: WireMessage): WireMessage {
    if (
      message.method !== "ariaSnapshot" ||
      typeof message.id !== "number" ||
      typeof message.guid !== "string"
    ) {
      return message;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (
      params?.mode !== "ai" ||
      typeof params.track !== "string" ||
      !params.track
    ) {
      return message;
    }
    const dispatcher = this.dispatcherConnection._dispatcherByGuid.get(
      message.guid
    );
    if (dispatcher?._type !== "Frame") {
      return message;
    }
    const document = Reflect.get(
      dispatcher._object,
      "_currentDocument"
    ) as object;
    this.trackedSnapshots.set(message.id, { document, key: params.track });
    const { track: _track, ...snapshotParams } = params;
    return { ...message, method: "ariaSnapshotJSON", params: snapshotParams };
  }

  private finishTrackedSnapshot(message: WireMessage): WireMessage {
    if (typeof message.id !== "number") {
      return message;
    }
    const tracked = this.trackedSnapshots.get(message.id);
    if (!tracked) {
      return message;
    }
    this.trackedSnapshots.delete(message.id);
    const result = message.result as { snapshot?: unknown } | undefined;
    if (!Array.isArray(result?.snapshot)) {
      return message;
    }
    return {
      ...message,
      result: {
        ...result,
        snapshot: snapshotTracker.render(
          tracked.document,
          tracked.key,
          result.snapshot as AriaSnapshotNode[]
        ),
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.trackedSnapshots.clear();
    this.dispatcherConnection.onmessage = () => {};

    try {
      await this.playwrightDispatcher?.cleanup();
    } finally {
      this.rootDispatcher._dispose();
    }
  }
}
