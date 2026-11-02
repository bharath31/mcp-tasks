export class Clock {
  constructor(public t = Math.floor(Date.now() / 1000) * 1000) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
  get seconds() {
    return Math.floor(this.t / 1000);
  }
}

/** Wall-clock time plus a controllable offset, for tests spanning real processes. */
export class LiveClock extends Clock {
  private offset = 0;
  override now = () => Date.now() + this.offset;
  override advance(ms: number) {
    this.offset += ms;
  }
  override get seconds() {
    return Math.floor(this.now() / 1000);
  }
}
