// Logger stub — root project injects the real logger at runtime
const noop = (_msg: string, ..._a: any[]) => {};
export const logger = {
  debug: noop, info: noop, warn: noop, error: noop,
};
