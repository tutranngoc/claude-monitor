import "server-only";

// AsyncQueue feeds the Agent SDK's prompt parameter, which expects an
// AsyncIterable that yields user messages over time. Push when the user
// sends a message; the SDK awaits the next yield to start its next turn.
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("queue is closed");
    const r = this.resolvers.shift();
    if (r) r({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length) {
      this.resolvers.shift()!({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
