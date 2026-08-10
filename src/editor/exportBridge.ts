let handler: (() => void) | null = null;

export function setExportPngHandler(fn: (() => void) | null): void {
  handler = fn;
}

export function runExportPng(): void {
  handler?.();
}
