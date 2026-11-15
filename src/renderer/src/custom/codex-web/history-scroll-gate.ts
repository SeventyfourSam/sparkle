export class HistoryScrollGate {
  loading = false
  private consumed = false
  private lastWheel = Number.NEGATIVE_INFINITY
  wheel(now: number): boolean {
    if (!this.loading && now - this.lastWheel > 180) this.consumed = false
    this.lastWheel = now
    return !this.loading && !this.consumed
  }
  touchStart(): boolean {
    if (!this.loading) this.consumed = false
    return !this.loading && !this.consumed
  }
  get allowed(): boolean {
    return !this.loading && !this.consumed
  }
  begin(force = false): boolean {
    if (this.loading || (!force && this.consumed)) return false
    this.loading = true
    this.consumed = true
    return true
  }
  complete(): void {
    this.loading = false
  }
  reset(): void {
    this.loading = false
    this.consumed = false
    this.lastWheel = Number.NEGATIVE_INFINITY
  }
}
