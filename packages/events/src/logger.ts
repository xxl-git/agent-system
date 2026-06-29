// Local logger for events package (no-op stub — root project injects real logger)
const noop = (_msg: string, ..._args: any[]) => {};
export const logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};
