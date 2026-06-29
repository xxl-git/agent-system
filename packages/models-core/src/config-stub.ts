// Config stub — decoupled from root config system
// Returns minimal config so model-profile compiles standalone.
export interface ProfilesConfig {
  dataDir?: string;
}
export interface Config {
  profiles?: ProfilesConfig;
  [key: string]: any;
}
let _cfg: Config = {};
export function setConfig(cfg: Config) { _cfg = cfg; }
export function getConfigSection(section: string): any {
  return _cfg[section] ?? null;
}
