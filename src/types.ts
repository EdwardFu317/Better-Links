import { LinkCache } from "obsidian";

export type LinkReference = Pick<LinkCache, "link" | "original" | "position">;
export type BacklinksBySource = Map<string, LinkReference[]>;

export interface PathsWithLinks {
  [path: string]: LinkReference[];
}

export interface HeadingSnapshot {
  heading: string;
  path: string;
  line: number;
  level: number;
}

export interface LinkDestination {
  path: string;
  subpath?: string;
}

export interface IndexedHeadingLink {
  sourcePath: string;
  targetPath: string;
  subpath: string;
  link: LinkReference;
}

export interface LinkWithDestination {
  link: LinkReference;
  newPath: string;
  newSubpath?: string;
}

export interface BrokenLinkResult {
  fixable: LinkWithDestination[];
  broken: LinkReference[];
}

export interface PluginState {
  headingRedirects: Record<string, LinkDestination>;
}

export type SerializedHeadingRedirects = Record<
  string,
  Record<string, [string, string]>
>;

export interface PersistentLinksData {
  redirects?: SerializedHeadingRedirects;
  headingRedirects?: Record<string, LinkDestination>;
}
