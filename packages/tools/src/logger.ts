// Local logger for tools package
const log = (level: string, msg: string, ...args: any[]) => {
  const prefix = `[tools:${level}]`;
  const formatted = args.length ? `${msg} ${JSON.stringify(args)}` : msg;
  if (typeof console !== 'undefined') {
    (console as any)[level === 'debug' ? 'log' : level]?.(`${prefix} ${formatted}`);
  }
};
export const logger = {
  debug: (msg: string, ...a: any[]) => log('debug', msg, ...a),
  info:  (msg: string, ...a: any[]) => log('info', msg, ...a),
  warn:  (msg: string, ...a: any[]) => log('warn', msg, ...a),
  error: (msg: string, ...a: any[]) => log('error', msg, ...a),
};
