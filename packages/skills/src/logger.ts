// Logger stub for skills package
const noop = (_msg: string, ..._a: any[]) => {};
export const logger = {
  debug: noop, info: noop, warn: noop, error: noop,
};
