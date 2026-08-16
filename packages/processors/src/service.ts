import type {
  MemoryRecord,
  ProcessedCaptureResult,
  RedactedSessionCapture,
} from '@reporecall/core';
import {
  createMemoryProcessor,
  type MemoryProcessorOptions,
} from './processor.js';

export type MemoryProcessingServiceOptions = Omit<MemoryProcessorOptions, 'allowAutomatic'> & {
  afterDurable?: (record: MemoryRecord) => Promise<void>;
};

export type ProcessCaptureOptions = {
  allowAutomatic?: boolean;
};

export interface MemoryProcessingService {
  process(
    capture: RedactedSessionCapture,
    options?: ProcessCaptureOptions,
  ): Promise<ProcessedCaptureResult>;
}

class DefaultMemoryProcessingService implements MemoryProcessingService {
  private readonly options: MemoryProcessingServiceOptions;
  private readonly providerKind: MemoryProcessorOptions['providerKind'];
  private readonly mode: NonNullable<MemoryProcessorOptions['mode']>;

  constructor(options: MemoryProcessingServiceOptions) {
    this.options = options;
    this.providerKind = options.providerKind ?? 'disabled';
    this.mode = options.mode ?? 'conservative';
  }

  async process(
    capture: RedactedSessionCapture,
    options: ProcessCaptureOptions = {},
  ): Promise<ProcessedCaptureResult> {
    const processor = createMemoryProcessor({
      ...this.options,
      allowAutomatic: options.allowAutomatic === true,
    });
    const result = await processor.process(capture);
    for (const record of result.durable) {
      await this.options.afterDurable?.(record);
    }
    return {
      ...result,
      provider: this.providerKind ?? 'disabled',
      mode: this.mode,
    };
  }
}

export function createMemoryProcessingService(
  options: MemoryProcessingServiceOptions,
): MemoryProcessingService {
  return new DefaultMemoryProcessingService(options);
}
