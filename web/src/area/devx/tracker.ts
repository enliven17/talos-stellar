export interface ResourceSample {
  memoryMb: number;
  cpuPercent: number;
  timestamp: number;
}

export class ResourceTracker {
  private samples: ResourceSample[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;

  constructor(intervalMs = 100) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.samples = [];
    this.sample();
    this.interval = setInterval(() => this.sample(), this.intervalMs);
  }

  stop(): ResourceSample[] {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.sample();
    return this.samples;
  }

  private sample(): void {
    const usage = process.memoryUsage();
    const memoryMb = Math.round((usage.heapUsed / 1024 / 1024) * 100) / 100;
    const cpuPercent = this.estimateCpu();
    this.samples.push({ memoryMb, cpuPercent, timestamp: Date.now() });
  }

  private estimateCpu(): number {
    const usage = process.cpuUsage();
    const total = (usage.user + usage.system) / 1_000_000;
    return Math.min(100, Math.round((total / Math.max(1, this.intervalMs / 1000)) * 100));
  }

  getPeakMemory(): number {
    if (this.samples.length === 0) return 0;
    return Math.max(...this.samples.map((s) => s.memoryMb));
  }

  getMeanMemory(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((a, s) => a + s.memoryMb, 0) / this.samples.length;
  }

  getPeakCpu(): number {
    if (this.samples.length === 0) return 0;
    return Math.max(...this.samples.map((s) => s.cpuPercent));
  }

  getMeanCpu(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((a, s) => a + s.cpuPercent, 0) / this.samples.length;
  }
}