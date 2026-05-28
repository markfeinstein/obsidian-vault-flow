export class WriteSafetyError extends Error {}

/** Device/session-local controls; never synced into another device's pause state. */
export class WriteSafety {
  private pausedReason: string | null = null;
  private starts: number[] = [];

  public constructor(private readonly onPause: (reason: string | null) => void = () => {}, private readonly now: () => number = Date.now) {}

  public get paused(): boolean { return this.pausedReason !== null; }
  public get reason(): string | null { return this.pausedReason; }

  public setPaused(paused: boolean): void {
    this.pausedReason = paused ? "Paused by the user" : null;
    // Explicit resume acknowledges a tripped circuit and starts a fresh budget.
    if (!paused) this.starts = [];
    this.onPause(this.pausedReason);
  }

  public assertCanWrite(): void {
    if (this.paused) throw new WriteSafetyError(`Vault Flow writes are paused: ${this.pausedReason}. Resume explicitly before writing.`);
  }

  /** Call exactly once at the first mutation, inside the mutation coordinator. */
  public consume(limit: number): void {
    this.assertCanWrite();
    const now = this.now();
    this.starts = this.starts.filter((timestamp) => timestamp > now - 60_000);
    if (this.starts.length >= limit) {
      this.pausedReason = `Write limit reached (${limit} transactions per minute)`;
      this.onPause(this.pausedReason);
      throw new WriteSafetyError(`${this.pausedReason}. Review diagnostics and resume explicitly.`);
    }
    this.starts.push(now);
  }
}
