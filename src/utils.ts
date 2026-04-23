import {
  BLOCK_ID,
  FILE_PATH_IN_LINK,
  HEADING,
  NOT_LETTER_OR_NUMBER,
  WIKILINK,
} from "./patterns";
import {
  BacklinksBySource,
  HeadingSnapshot,
  LinkDestination,
  LinkReference,
  LinkWithDestination,
  PathsWithLinks,
} from "./types";
import * as obsidian from "obsidian";
import { CachedMetadata, Editor, HeadingCache } from "obsidian";

export function getBlockIds(text: string) {
  return [...text.matchAll(BLOCK_ID)].map((match) => match[1]);
}

export function getHeadings(text: string) {
  return [...text.matchAll(HEADING)].map((match) => match[0]);
}

export function stripHeadingMarker(heading: string) {
  return heading.replace(/^#+\s+/, "");
}

export function normalizeHeading(text: string) {
  return text.replace(NOT_LETTER_OR_NUMBER, "");
}

export function normalizeSubpath(text: string) {
  return text
    .split("#")
    .map((segment) => normalizeHeading(segment))
    .join("#");
}

export function getSubpathAliases(subpath: string) {
  const segments = subpath.split("#").filter(Boolean);

  if (segments.length <= 1) {
    return [];
  }

  return [segments.slice(1).join("#")];
}

export function createHeadingKey(path: string, subpath: string) {
  return `${path}::${normalizeSubpath(subpath)}`;
}

export function splitHeadingKey(key: string) {
  const separatorIndex = key.indexOf("::");

  return {
    path: key.slice(0, separatorIndex),
    subpath: key.slice(separatorIndex + 2),
  };
}

export function getNormalizedHeadingInLink(link: string) {
  const { subpath } = parseLinkText(link);

  if (subpath) {
    return normalizeSubpath(subpath);
  }

  return null;
}

export function parseLinkText(linkText: string) {
  const { path, subpath } = obsidian.parseLinktext(
    getRawLinkTarget(linkText)
  );
  return {
    path,
    subpath: subpath ? stripSubpathToken(subpath) : "",
  };
}

export function stripSubpathToken(subpath: string) {
  return subpath.replace(/^#\^?/, "");
}

export function replaceFilePathInLink(link: string, newPath: string) {
  return link.replace(FILE_PATH_IN_LINK, `$1${newPath}$2`);
}

export function replaceLinkDestination(
  link: string,
  destination: LinkDestination
) {
  const match = link.match(WIKILINK);

  if (!match) {
    return destination.subpath
      ? replaceFilePathInLink(link, `${destination.path}#${destination.subpath}`)
      : replaceFilePathInLink(link, destination.path);
  }

  const [, prefix, , , alias = "", suffix] = match;
  const subpath = destination.subpath ? `#${destination.subpath}` : "";

  return `${prefix}${destination.path}${subpath}${alias}${suffix}`;
}

function getRawLinkTarget(linkText: string) {
  const wikilinkMatch = linkText.match(WIKILINK);

  if (!wikilinkMatch) {
    return linkText;
  }

  const [, , path = "", subpath = ""] = wikilinkMatch;
  return `${path}${subpath}`;
}

export function isHeadingLink(linkText: string) {
  return linkText.includes("#") && !linkText.includes("#^");
}

export function isBlockLink(linkText: string) {
  return linkText.includes("#^");
}

export function filterLinksToItemsPresentInText(
  links: PathsWithLinks | BacklinksBySource,
  text: string
) {
  const blockIdsInText = getBlockIds(text);
  const headingsInText = new Set(
    getHeadingSnapshotsFromText(text).flatMap(({ heading, path }) => [
      normalizeHeading(heading),
      normalizeSubpath(path),
    ])
  );
  const entries =
    links instanceof Map ? links.entries() : Object.entries(links);

  return [...entries]
    .map(([filePath, links]) => ({
      filePath,
      links: links.filter(
        ({ link: linkText }: LinkReference) =>
          [...blockIdsInText].some((id) => linkText.includes(id)) ||
          headingsInText.has(getNormalizedHeadingInLink(linkText) ?? "")
      ),
    }))
    .filter(({ links }) => links.length > 0);
}

export function redirectLinksInTextToNewPaths(
  linksWithPaths: LinkWithDestination[],
  text: string
) {
  return linksWithPaths
    .slice()
    .sort((a, b) => compareLinkOffsets(a.link, b.link))
    .reverse()
    .reduce(
      (
        updatedText: string,
        { newPath, newSubpath, link: { position, original } }
      ) => {
        const start = position.start.offset;
        const end = Math.max(position.end.offset, start + original.length);

        const updatedLink = replaceLinkDestination(original, {
          path: newPath,
          subpath: newSubpath ?? parseLinkText(original).subpath,
        });

        return (
          updatedText.substring(0, start) +
          updatedLink +
          updatedText.substring(end)
        );
      },
      text
    );
}

export function createUpdateNotice(
  results: Array<{ filePath: string; links: LinkReference[] }>
) {
  const fileCount = results.length;
  const linkCount = results.flatMap((f) => f.links).length;

  return `Updated ${linkCount} links in ${fileCount} files`;
}

export function createRepairNotice(fixed: number, broken: number) {
  let result = "";
  if (fixed > 0) {
    result += `Repaired ${fixed} links`;
  }

  if (broken > 0) {
    result += `\n${broken} links could not be repaired`;
  }
  return result;
}

export function compareLinkOffsets(left: LinkReference, right: LinkReference) {
  return left.position.start.offset - right.position.start.offset;
}

export function isSubpathInMetadata(
  subpath: string,
  metadata: CachedMetadata | null | undefined
) {
  if (!metadata) {
    return false;
  }

  const { blocks, headings } = metadata;

  return (
    (blocks && subpath in blocks) ||
    (headings && isSubpathInHeadingCache(subpath, headings))
  );
}

function isSubpathInHeadingCache(
  subpath: string,
  headingCache: HeadingCache[]
) {
  const normalizedSubpaths = new Set(
    [subpath, ...getSubpathAliases(subpath)].map((value) =>
      normalizeSubpath(value)
    )
  );
  const normalizedLeaf = normalizeHeading(subpath);

  return getHeadingSnapshotsFromHeadingCache(headingCache).some(
    ({ heading, path }) =>
      normalizedSubpaths.has(normalizeSubpath(path)) ||
      getSubpathAliases(path).some((alias) =>
        normalizedSubpaths.has(normalizeSubpath(alias))
      ) ||
      normalizeHeading(heading) === normalizedLeaf
  );
}

export function getHeadingSnapshots(
  metadata: CachedMetadata | null | undefined
) {
  return getHeadingSnapshotsFromHeadingCache(metadata?.headings ?? []);
}

export function getHeadingSnapshotsFromText(
  text: string,
  parentSegments: string[] = []
) {
  const rawHeadings = text
    .split(/\r?\n/)
    .map((lineText, line) => parseHeadingLine(lineText, line))
    .filter((heading): heading is HeadingSnapshot => Boolean(heading));

  return buildHeadingSnapshots(rawHeadings, parentSegments);
}

export function getHeadingPathSegmentsAtLine(
  editor: Editor,
  line: number,
  movedHeadingLevel?: number
) {
  const stack: Array<{ heading: string; level: number }> = [];

  for (
    let currentLine = 0;
    currentLine < Math.min(line, editor.lineCount());
    currentLine += 1
  ) {
    const heading = parseHeadingLine(editor.getLine(currentLine), currentLine);

    if (!heading) {
      continue;
    }

    while (stack.length > 0 && stack.at(-1)!.level >= heading.level) {
      stack.pop();
    }

    stack.push({
      heading: heading.heading,
      level: heading.level,
    });
  }

  const candidateParents =
    typeof movedHeadingLevel === "number"
      ? stack.filter(({ level }) => level < movedHeadingLevel)
      : stack;

  if (candidateParents.length === 0) {
    return [];
  }

  return candidateParents.map(({ heading }) => heading);
}

export function getLastHeadingSegment(subpath: string) {
  const segments = subpath.split("#").filter(Boolean);
  return segments.at(-1) ?? subpath;
}

function getHeadingSnapshotsFromHeadingCache(headingCache: HeadingCache[]) {
  const rawHeadings = headingCache.map(
    ({ heading, level, position }): HeadingSnapshot => ({
      heading,
      path: heading,
      line: position.start.line,
      level,
    })
  );

  return buildHeadingSnapshots(rawHeadings);
}

function buildHeadingSnapshots(
  headings: HeadingSnapshot[],
  parentSegments: string[] = []
) {
  if (headings.length === 0) {
    return [];
  }

  const baseLevel = Math.min(...headings.map(({ level }) => level));
  const stack: Array<{ heading: string; level: number; actualLevel: number }> = [];

  return headings.map(({ heading, line, level }) => {
    const relativeLevel = level - baseLevel + 1;

    while (stack.length > 0 && stack.at(-1)!.level >= relativeLevel) {
      stack.pop();
    }

    stack.push({
      heading,
      level: relativeLevel,
      actualLevel: level,
    });

    return {
      heading,
      path: [...parentSegments, ...stack.map(({ heading }) => heading)].join("#"),
      line,
      level,
    };
  });
}

function parseHeadingLine(lineText: string, line: number) {
  const match = lineText.match(/^(#+)\s+(.*)$/);

  if (!match) {
    return null;
  }

  const [, markers, heading] = match;

  return {
    heading,
    path: heading,
    line,
    level: markers.length,
  };
}
