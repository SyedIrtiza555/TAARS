import { EventEmitter } from 'node:events';

export type BusMessage = {
  type: string;
  data: unknown;
  at: string;
};

class AppEventBus extends EventEmitter {
  publish(type: string, data: unknown): void {
    this.emit('event', { type, data, at: new Date().toISOString() } satisfies BusMessage);
  }
}

export const bus = new AppEventBus();
bus.setMaxListeners(50);
