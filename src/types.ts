export interface VaultSource {
  listNotes(): Promise<string[]>;
  readNote(path: string): Promise<string>;
  resolveLink(link: string, source: string): string | undefined;
  readBinary(path: string): Promise<Uint8Array>;
}
export interface Settings {
  blogDir: string;
  siteUrl: string;
  nodePath: string;
  gitPath: string;
  previewPort: number;
}
export const DEFAULT_SETTINGS: Settings = {
  blogDir: 'D:\\Myblog', siteUrl: '', nodePath: 'node', gitPath: 'git', previewPort: 4000
};
export interface Asset { path: string; data: Uint8Array; hash: string }
export interface NotePlan {
  id: string; source: string; slug: string; title: string; date: string;
  fingerprint: string; markdown: string; assets: Asset[];
  linkTargets: string[]; warnings: string[];
}
export interface ExportedNote {
  source: string; slug: string; title: string; date: string;
  fingerprint: string; updated: string; assets: string[]; linkTargets: string[];
}
export interface Manifest {
  version: 1;
  notes: Record<string, ExportedNote>;
  published: Record<string, { fingerprint: string; slug: string }>;
  buildSignature?: string;
  lastCommit?: string;
}
export interface ExportResult {
  manifest: Manifest;
  plans: NotePlan[];
  changed: number;
  skipped: number;
  pending: boolean;
}
export type Log = (message: string) => void;
export const emptyManifest = (): Manifest => ({ version: 1, notes: {}, published: {} });
