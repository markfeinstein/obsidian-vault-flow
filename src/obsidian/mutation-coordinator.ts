export class MutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
