/** Requests that stay open for as long as the page does, so the network is quiet without them. */
const STREAMS = new Set(["eventsource", "websocket"]);

/** The requests a page has started and not yet ended, and when one last started or ended. */
export class NetworkLog<Request> {
  private readonly pending = new Map<Request, string>();
  private last = Date.now();

  /** Records a request the page started, unless its resource type is a stream. */
  start(request: Request, url: string, resourceType: string): void {
    if (STREAMS.has(resourceType)) return;
    this.pending.set(request, url);
    this.last = Date.now();
  }

  /** Records that a request finished or failed. */
  end(request: Request): void {
    if (!this.pending.delete(request)) return;
    this.last = Date.now();
  }

  /** The URLs of the requests started and not yet ended. */
  pendingRequests(): string[] {
    return [...this.pending.values()];
  }

  /** When a request last started or ended, as a `Date.now()` instant. */
  lastRequestAt(): number {
    return this.last;
  }
}
