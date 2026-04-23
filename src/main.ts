import {
  CachedMetadata,
  Editor,
  LinkCache,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";
import { isInstanceOf, isNotNull } from "typed-assert";
import {
  BacklinksBySource,
  BrokenLinkResult,
  HeadingSnapshot,
  IndexedHeadingLink,
  LinkReference,
  PersistentLinksData,
  PluginState,
  SerializedHeadingRedirects,
} from "./types";
import {
  createHeadingKey,
  createRepairNotice,
  createUpdateNotice,
  getBlockIds,
  getHeadingPathSegmentsAtLine,
  getHeadingSnapshots,
  getHeadingSnapshotsFromText,
  getLastHeadingSegment,
  getSubpathAliases,
  isBlockLink,
  isHeadingLink,
  isSubpathInMetadata,
  normalizeSubpath,
  parseLinkText,
  redirectLinksInTextToNewPaths,
  splitHeadingKey,
} from "./utils";

const DEFAULT_STATE: PluginState = {
  headingRedirects: {},
};

export default class PersistentLinksPlugin extends Plugin {
  private static readonly EMPTY_BACKLINKS_BY_SOURCE: BacklinksBySource = new Map();
  private static readonly INITIAL_METADATA_WAIT_MS = 1500;
  private static readonly RECENT_MOVE_WINDOW_MS = 15000;
  sourceFile: TFile | null = null;
  private pendingCutContext:
    | {
        allHeadings: HeadingSnapshot[];
        fromLine: number;
        headings: HeadingSnapshot[];
        sourcePath: string;
        text: string;
        toLine: number;
      }
    | null = null;
  private recentRemovedContext:
    | {
        allHeadings: HeadingSnapshot[];
        headings: HeadingSnapshot[];
        sourcePath: string;
        timestamp: number;
      }
    | null = null;
  private data: PluginState = DEFAULT_STATE;
  private headingSnapshots = new Map<string, HeadingSnapshot[]>();
  private outgoingHeadingLinksBySource = new Map<string, IndexedHeadingLink[]>();
  private backlinksByTargetFile = new Map<string, BacklinksBySource>();
  private headingLinkCounts = new Map<string, number>();
  private fileSubpathKeysByPath = new Map<string, string[]>();
  private filePathsBySubpathKey = new Map<string, Set<string>>();
  private isRebuildingState = false;
  private isInitialized = false;
  private hasHydratedFromResolved = false;
  private initializationPromise: Promise<void> | null = null;
  private lastSavedState = "";
  private redirectsDirty = false;
  private resolvedRedirectCache = new Map<string, PluginState["headingRedirects"][string] | null>();

  async onload() {
    const storedData = (await this.loadData()) as PersistentLinksData | null;

    this.data = {
      headingRedirects: this.deserializeRedirects(storedData),
    };
    this.lastSavedState = storedData?.redirects
      ? JSON.stringify(this.serializeData(this.data.headingRedirects))
      : "";
    this.redirectsDirty = Boolean(
      storedData?.headingRedirects || Object.keys(this.data.headingRedirects).length
    );

    this.addCommand({
      id: "repair-links-in-file",
      name: "Repair links in current file",
      editorCallback: (editor) => {
        this.repairLinksInFile(editor);
      },
    });

    const body = document.querySelector("body");
    isNotNull(body);

    this.registerDomEvent(body, "cut", () => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

      this.sourceFile = activeView?.file ?? null;

      if (!activeView?.editor || !activeView.file) {
        this.pendingCutContext = null;
        return;
      }

      const selectedText = activeView.editor.getSelection();

      if (!selectedText) {
        this.pendingCutContext = null;
        return;
      }

      const normalizedSelectedText = this.normalizeClipboardText(selectedText);
      const allHeadings = getHeadingSnapshotsFromText(activeView.editor.getValue());

      this.pendingCutContext = {
        allHeadings,
        fromLine: activeView.editor.getCursor("from").line,
        headings: allHeadings.filter(
          ({ line }) =>
            line >= activeView.editor.getCursor("from").line &&
            line <= activeView.editor.getCursor("to").line
        ),
        sourcePath: activeView.file.path,
        text: normalizedSelectedText,
        toLine: activeView.editor.getCursor("to").line,
      };
    });

    this.registerEvent(
      this.app.workspace.on("editor-paste", (event, editor) => {
        void this.handleEditorPaste(event, editor);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        void this.handleMetadataChanged(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        void this.handleMetadataResolved();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.handleFileRenamed(file, oldPath);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          void this.handleFileDeleted(file.path);
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      if (!this.isInitialized) {
        void this.initializeStateIfNeeded();
      }
    });
  }

  private async initializeStateIfNeeded() {
    if (this.isInitialized) {
      return;
    }

    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = (async () => {
      await this.waitForInitialMetadataWindow();
      await this.rebuildState();
      this.isInitialized = true;
      await this.saveSettings();
    })();

    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async handleMetadataResolved() {
    if (this.hasHydratedFromResolved) {
      return;
    }

    this.hasHydratedFromResolved = true;
    await this.forceRefreshState();
  }

  private async waitForInitialMetadataWindow() {
    if (this.hasHydratedFromResolved) {
      return;
    }

    await new Promise<void>((resolve) => {
      let isSettled = false;
      let timeoutId = 0;
      const onResolved = () => {
        finish();
      };

      const finish = () => {
        if (isSettled) {
          return;
        }

        isSettled = true;

        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }

        this.app.metadataCache.off("resolved", onResolved);
        resolve();
      };

      this.app.metadataCache.on("resolved", onResolved);

      timeoutId = window.setTimeout(
        finish,
        PersistentLinksPlugin.INITIAL_METADATA_WAIT_MS
      );
    });
  }

  private async forceRefreshState() {
    await this.rebuildState();
    this.isInitialized = true;
    await this.saveSettings();
  }

  private repairLinksInFile(editor: Editor) {
    const activeFileCache = this.app.metadataCache.getFileCache(
      this.getActiveFile()
    );

    if (!activeFileCache) {
      new Notice("No links to repair");
      return;
    }

    const { links = [], embeds = [] } = activeFileCache;
    const { fixable, broken } = this.findNewPathsForBrokenLinks([
      ...links,
      ...embeds,
    ]);

    if (fixable.length > 0) {
      editor.setValue(
        redirectLinksInTextToNewPaths(fixable, editor.getValue())
      );
    }

    new Notice(createRepairNotice(fixable.length, broken.length));
  }

  private findNewPathsForBrokenLinks(links: LinkCache[]) {
    return links
      .map((link) => ({ link, ...parseLinkText(link.link) }))
      .filter(({ subpath }) => subpath)
      .filter(this.isLinkPathBroken)
      .map(({ link, subpath }) => ({
        link,
        destination:
          this.getMappedHeadingDestination(link.link) ??
          this.findFileWithSubpathInCache(subpath, link.link),
      }))
      .reduce(
        (result: BrokenLinkResult, { link, destination }) => {
          destination
            ? result.fixable.push({
                link,
                newPath: destination.path,
                newSubpath: destination.subpath,
              })
            : result.broken.push(link);
          return result;
        },
        { fixable: [], broken: [] }
      );
  }

  private findFileWithSubpathInCache(subpath: string, linkText: string) {
    const candidates = this.getCandidatePathsForSubpath(subpath, linkText);

    for (const candidatePath of candidates) {
      const candidate = this.app.vault.getAbstractFileByPath(candidatePath);

      if (
        candidate instanceof TFile &&
        isSubpathInMetadata(subpath, this.app.metadataCache.getFileCache(candidate))
      ) {
        return {
          path: this.app.metadataCache.fileToLinktext(
            candidate,
            this.getActiveFile().path
          ),
          subpath,
        };
      }
    }

    if (this.isInitialized) {
      return null;
    }

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (
        isSubpathInMetadata(subpath, this.app.metadataCache.getFileCache(file))
      ) {
        return {
          path: this.app.metadataCache.fileToLinktext(
            file,
            this.getActiveFile().path
          ),
          subpath,
        };
      }
    }

    return null;
  }

  private getCandidatePathsForSubpath(subpath: string, linkText: string) {
    const subpathKey = this.createSubpathIndexKey(subpath, linkText);
    return [...(this.filePathsBySubpathKey.get(subpathKey) ?? [])];
  }

  private getFileFromPathRelativeToActiveFile(path: string) {
    if (!path) {
      return this.getActiveFile();
    }

    return this.app.metadataCache.getFirstLinkpathDest(
      path,
      this.getActiveFile().path
    );
  }

  private isLinkPathBroken = ({
    path,
    subpath,
  }: {
    path: string;
    subpath: string;
  }) => {
    const toFile = this.getFileFromPathRelativeToActiveFile(path);

    if (toFile === null) {
      return true;
    }

    return !isSubpathInMetadata(
      subpath,
      this.app.metadataCache.getFileCache(toFile)
    );
  };

  private handleEditorPaste = async (
    event: ClipboardEvent,
    editor: Editor
  ) => {
    await this.initializeStateIfNeeded();
    const clipboardContents = this.normalizeClipboardText(
      event?.clipboardData?.getData("text") ?? ""
    );

    if (!clipboardContents) {
      return;
    }

    const sourceFile =
      this.sourceFile ?? this.getRecentSourceFileForClipboard(clipboardContents);

    if (!sourceFile) {
      return;
    }

    const targetFile = this.getActiveFile();

    if (targetFile.path === sourceFile.path) {
      return;
    }

    const movedHeadingRedirects = this.getMovedHeadingRedirects(
      sourceFile,
      targetFile,
      clipboardContents,
      editor
    );
    const sourceSnapshots = this.getSourceHeadingSnapshotsForMove(sourceFile.path);
    const backlinksToUpdate = this.getMovedBacklinksToUpdate(
      sourceFile.path,
      clipboardContents,
      movedHeadingRedirects,
      sourceSnapshots
    );

    await this.registerMovedHeadings(
      sourceFile,
      targetFile,
      movedHeadingRedirects,
      sourceSnapshots,
      false
    );

    if (backlinksToUpdate.length === 0) {
      this.sourceFile = null;
      this.pendingCutContext = null;
      return;
    }

    window.setTimeout(() => {
      void this.redirectMovedLinks(
        backlinksToUpdate,
        sourceFile.path,
        targetFile,
        movedHeadingRedirects,
        sourceSnapshots
      ).then(() => {
        new Notice(createUpdateNotice(backlinksToUpdate));
      });
    }, 0);

    this.sourceFile = null;
    this.pendingCutContext = null;
    this.recentRemovedContext = null;
  };

  private async redirectMovedLinks(
    links: Array<{ filePath: string; links: LinkReference[] }>,
    sourceFilePath: string,
    targetFile: TFile,
    movedHeadingRedirects: Array<{ from: string; to: string }>,
    sourceSnapshots: HeadingSnapshot[]
  ) {
    const redirectMap = new Map<string, string>();

    for (const { from, to } of movedHeadingRedirects) {
      for (const variant of this.getHeadingRedirectVariants(
        from,
        to,
        sourceSnapshots
      )) {
        redirectMap.set(createHeadingKey("", variant.from), variant.to);
      }
    }

    return Promise.all(
      links.map(async ({ filePath, links: linksInFile }) => {
        const contents = await this.readFile(filePath);
        const targetFilePath = this.app.metadataCache.fileToLinktext(
          targetFile,
          filePath
        );
        const linksWithNewPath = linksInFile.map((link) => ({
          link,
          newPath: targetFilePath,
          newSubpath: isHeadingLink(link.link)
            ? redirectMap.get(createHeadingKey("", parseLinkText(link.link).subpath))
            : undefined,
        }));
        const updatedContents = redirectLinksInTextToNewPaths(
          linksWithNewPath,
          contents
        );

        return this.updateFile(filePath, updatedContents);
      })
    );
  }

  private async handleMetadataChanged(file: TFile) {
    await this.initializeStateIfNeeded();

    const previousHeadings = this.headingSnapshots.get(file.path) ?? [];
    const backlinksToFile = this.getBacklinksToFile(file.path);
    const previousHeadingPaths = new Set(
      previousHeadings.map(({ path }) => createHeadingKey("", path))
    );

    this.indexFile(file);
    const currentHeadings = this.headingSnapshots.get(file.path) ?? [];
    const currentHeadingPaths = new Set(
      currentHeadings.map(({ path }) => createHeadingKey("", path))
    );
    const removedHeadings = previousHeadings.filter(
      ({ path }) => !currentHeadingPaths.has(createHeadingKey("", path))
    );
    const addedHeadings = currentHeadings.filter(
      ({ path }) => !previousHeadingPaths.has(createHeadingKey("", path))
    );

    if (removedHeadings.length > 0 && addedHeadings.length === 0) {
      this.recentRemovedContext = {
        allHeadings: previousHeadings,
        headings: removedHeadings,
        sourcePath: file.path,
        timestamp: Date.now(),
      };
    } else if (addedHeadings.length > 0 && removedHeadings.length === 0) {
      await this.maybeHandleRecentHeadingMove(file, addedHeadings);
    } else if (
      this.recentRemovedContext?.sourcePath === file.path &&
      previousHeadingPaths.size > 0
    ) {
      this.recentRemovedContext = null;
    }

    if (previousHeadings.length > 0) {
      const redirects = this.findHeadingRedirects(
        file,
        previousHeadings,
        currentHeadings
      );

      if (redirects.length > 0) {
        for (const { from, to } of redirects) {
          for (const variant of this.getHeadingRedirectVariants(
            from,
            to,
            previousHeadings
          )) {
            if (
              !this.hasBacklinksToHeadingInSnapshots(
                file.path,
                variant.from,
                previousHeadings
              )
            ) {
              continue;
            }

            this.registerHeadingRedirect(
              file.path,
              variant.from,
              file.path,
              variant.to
            );
          }
        }

        await this.updateBacklinksForHeadingRedirects(
          file,
          redirects,
          backlinksToFile,
          previousHeadings
        );
      }
    }

    await this.saveSettings();
  }

  private async handleFileRenamed(file: TFile, oldPath: string) {
    await this.initializeStateIfNeeded();

    if (oldPath === file.path) {
      return;
    }

    const previousHeadings = this.headingSnapshots.get(oldPath) ?? [];

    this.removeIndexedLinksForSource(oldPath);
    this.removeIndexedSubpathsForFile(oldPath);
    this.headingSnapshots.delete(oldPath);

    this.moveBacklinksToRenamedTarget(oldPath, file.path);
    this.moveHeadingCountsForRenamedTarget(oldPath, file.path, previousHeadings);
    this.renameRedirectPaths(oldPath, file.path);

    this.indexFile(file);
    await this.saveSettings();
  }

  private async handleFileDeleted(filePath: string) {
    await this.initializeStateIfNeeded();

    const previousHeadings = this.headingSnapshots.get(filePath) ?? [];

    this.removeIndexedLinksForSource(filePath);
    this.removeIndexedSubpathsForFile(filePath);
    this.removeBacklinksForDeletedTarget(filePath);
    this.removeHeadingCountsForDeletedTarget(filePath, previousHeadings);
    this.headingSnapshots.delete(filePath);
    this.removeRedirectsForDeletedPath(filePath);

    if (this.sourceFile?.path === filePath) {
      this.sourceFile = null;
    }

    await this.saveSettings();
  }

  private async rebuildState() {
    if (this.isRebuildingState) {
      return;
    }

    this.isRebuildingState = true;

    try {
      this.headingSnapshots.clear();
      this.outgoingHeadingLinksBySource.clear();
      this.backlinksByTargetFile.clear();
      this.headingLinkCounts.clear();
      this.fileSubpathKeysByPath.clear();
      this.filePathsBySubpathKey.clear();

      for (const file of this.app.vault.getMarkdownFiles()) {
        this.indexFile(file);
      }
    } finally {
      this.isRebuildingState = false;
    }
  }

  private indexFile(file: TFile) {
    this.headingSnapshots.set(file.path, this.getHeadingSnapshotsForFile(file));
    this.reindexSubpathsForFile(file);
    this.reindexLinksForFile(file);
  }

  private getHeadingSnapshotsForFile(file: TFile) {
    return getHeadingSnapshots(this.app.metadataCache.getFileCache(file));
  }

  private findHeadingRedirects(
    file: TFile,
    previousHeadings: HeadingSnapshot[],
    currentHeadings: HeadingSnapshot[]
  ) {
    const previousHeadingCountsByName = this.getHeadingCountsByName(
      previousHeadings
    );
    const previousHeadingKeys = new Set(
      previousHeadings.map(({ path }) => createHeadingKey("", path))
    );
    const currentHeadingKeys = new Set(
      currentHeadings.map(({ path }) => createHeadingKey("", path))
    );
    const currentHeadingsByLine = new Map(
      currentHeadings.map((heading) => [heading.line, heading])
    );
    const uniqueCurrentNewHeadingsByName =
      this.getUniqueCurrentNewHeadingsByName(
        currentHeadings,
        previousHeadingKeys
      );

    return previousHeadings
      .map((previousHeading) => {
        const previousHeadingKey = createHeadingKey("", previousHeading.path);

        if (currentHeadingKeys.has(previousHeadingKey)) {
          return null;
        }

        const movedHeadingWithSameName =
          previousHeadingCountsByName.get(previousHeading.heading) === 1
            ? uniqueCurrentNewHeadingsByName.get(previousHeading.heading)
            : undefined;

        if (movedHeadingWithSameName) {
          return {
            from: previousHeading.path,
            to: movedHeadingWithSameName.path,
          };
        }

        const updatedHeading = currentHeadingsByLine.get(previousHeading.line);

        if (!updatedHeading) {
          return null;
        }

        const updatedHeadingKey = createHeadingKey("", updatedHeading.path);

        if (
          previousHeadingKey === updatedHeadingKey ||
          previousHeadingKeys.has(updatedHeadingKey)
        ) {
          return null;
        }

        if (
          !this.hasBacklinksToHeadingInSnapshots(
            file.path,
            previousHeading.path,
            previousHeadings
          )
        ) {
          return null;
        }

        return {
          from: previousHeading.path,
          to: updatedHeading.path,
        };
      })
      .filter(
        (
          redirect
        ): redirect is {
          from: string;
          to: string;
        } => Boolean(redirect)
      );
  }

  private getUniqueCurrentNewHeadingsByName(
    currentHeadings: HeadingSnapshot[],
    previousHeadingKeys: Set<string>
  ) {
    const headingsByName = new Map<string, HeadingSnapshot[]>();

    for (const heading of currentHeadings) {
      if (previousHeadingKeys.has(createHeadingKey("", heading.path))) {
        continue;
      }

      const existingHeadings = headingsByName.get(heading.heading);

      if (existingHeadings) {
        existingHeadings.push(heading);
      } else {
        headingsByName.set(heading.heading, [heading]);
      }
    }

    return new Map(
      [...headingsByName.entries()]
        .filter(([, headings]) => headings.length === 1)
        .map(([headingName, [heading]]) => [headingName, heading] as const)
    );
  }

  private getHeadingCountsByName(headings: HeadingSnapshot[]) {
    const counts = new Map<string, number>();

    for (const { heading } of headings) {
      counts.set(heading, (counts.get(heading) ?? 0) + 1);
    }

    return counts;
  }

  private getBacklinksToFile(targetPath: string): BacklinksBySource {
    return (
      this.backlinksByTargetFile.get(targetPath) ??
      PersistentLinksPlugin.EMPTY_BACKLINKS_BY_SOURCE
    );
  }

  private hasBacklinksToHeading(filePath: string, heading: string) {
    return this.hasBacklinksToHeadingInSnapshots(
      filePath,
      heading,
      this.headingSnapshots.get(filePath) ?? []
    );
  }

  private hasBacklinksToHeadingInSnapshots(
    filePath: string,
    heading: string,
    snapshots: HeadingSnapshot[]
  ) {
    const directCount =
      this.headingLinkCounts.get(createHeadingKey(filePath, heading)) ?? 0;

    if (directCount > 0) {
      return true;
    }

    for (const alias of getSubpathAliases(heading)) {
      if (
        this.countHeadingsWithSubpathAliasInSnapshots(snapshots, alias) === 1 &&
        (this.headingLinkCounts.get(createHeadingKey(filePath, alias)) ?? 0) > 0
      ) {
        return true;
      }
    }

    const leafHeading = getLastHeadingSegment(heading);

    if (leafHeading === heading) {
      return false;
    }

    if (this.countHeadingsWithLeafInSnapshots(snapshots, leafHeading) !== 1) {
      return false;
    }

    return (
      (this.headingLinkCounts.get(createHeadingKey(filePath, leafHeading)) ?? 0) > 0
    );
  }

  private countHeadingsWithLeafInSnapshots(
    snapshots: HeadingSnapshot[],
    heading: string
  ) {
    return snapshots.filter(
      ({ heading: currentHeading }) => currentHeading === heading
    ).length;
  }

  private countHeadingsWithSubpathAliasInSnapshots(
    snapshots: HeadingSnapshot[],
    subpathAlias: string
  ) {
    return snapshots.filter(({ path }) =>
      getSubpathAliases(path).includes(subpathAlias)
    ).length;
  }

  private getHeadingMatchKeys(
    filePath: string,
    heading: string,
    snapshots: HeadingSnapshot[]
  ) {
    const keys = [createHeadingKey(filePath, heading)];

    for (const alias of getSubpathAliases(heading)) {
      if (this.countHeadingsWithSubpathAliasInSnapshots(snapshots, alias) === 1) {
        keys.push(createHeadingKey(filePath, alias));
      }
    }

    const leafHeading = getLastHeadingSegment(heading);

    if (this.countHeadingsWithLeafInSnapshots(snapshots, leafHeading) === 1) {
      keys.push(createHeadingKey(filePath, leafHeading));
    }

    return [...new Set(keys)];
  }

  private getHeadingRedirectVariants(
    from: string,
    to: string,
    snapshots: HeadingSnapshot[]
  ) {
    const variants: Array<{ from: string; to: string }> = [{ from, to }];
    const fromAliases = getSubpathAliases(from);
    const toAliases = getSubpathAliases(to);

    for (const [index, alias] of fromAliases.entries()) {
      if (this.countHeadingsWithSubpathAliasInSnapshots(snapshots, alias) !== 1) {
        continue;
      }

      variants.push({
        from: alias,
        to: toAliases[index] ?? to,
      });
    }

    const leafHeading = getLastHeadingSegment(from);

    if (
      leafHeading !== from &&
      this.countHeadingsWithLeafInSnapshots(snapshots, leafHeading) === 1
    ) {
      variants.push({
        from: leafHeading,
        to: getLastHeadingSegment(to),
      });
    }

    return variants.filter(
      ({ from: variantFrom }, index, allVariants) =>
        allVariants.findIndex(({ from }) => from === variantFrom) === index
    );
  }

  private getSourceHeadingSnapshotsForMove(sourceFilePath: string) {
    if (
      this.pendingCutContext &&
      this.pendingCutContext.sourcePath === sourceFilePath
    ) {
      return this.pendingCutContext.allHeadings;
    }

    if (
      this.recentRemovedContext &&
      this.recentRemovedContext.sourcePath === sourceFilePath
    ) {
      return this.recentRemovedContext.allHeadings;
    }

    return this.headingSnapshots.get(sourceFilePath) ?? [];
  }

  private getMovedHeadingRedirects(
    sourceFile: TFile,
    targetFile: TFile,
    clipboardContents: string,
    editor: Editor
  ) {
    const sourceHeadings = this.getSelectedHeadingSnapshots(sourceFile, clipboardContents);

    if (sourceHeadings.length === 0) {
      return [];
    }

    const movedRootLevel = sourceHeadings[0]?.level;
    const targetParentSegments = getHeadingPathSegmentsAtLine(
      editor,
      editor.getCursor("from").line,
      movedRootLevel
    );
    const targetHeadings = getHeadingSnapshotsFromText(
      clipboardContents,
      targetFile.path === sourceFile.path ? [] : targetParentSegments
    );

    return sourceHeadings
      .map((sourceHeading, index) => {
        const targetHeading = targetHeadings[index];

        if (!targetHeading) {
          return null;
        }

        return {
          from: sourceHeading.path,
          to: targetHeading.path,
        };
      })
      .filter(
        (
          redirect
        ): redirect is {
          from: string;
          to: string;
        } => Boolean(redirect)
      );
  }

  private getSelectedHeadingSnapshots(sourceFile: TFile, clipboardContents: string) {
    if (
      this.pendingCutContext &&
      this.pendingCutContext.sourcePath === sourceFile.path &&
      this.pendingCutContext.text === clipboardContents
    ) {
      return this.pendingCutContext.headings;
    }

    if (
      this.recentRemovedContext &&
      this.recentRemovedContext.sourcePath === sourceFile.path &&
      this.isRecentRemovedContextMatch(clipboardContents)
    ) {
      return this.recentRemovedContext.headings;
    }

    const allHeadings =
      this.headingSnapshots.get(sourceFile.path) ?? this.getHeadingSnapshotsForFile(sourceFile);

    const clipboardHeadings = getHeadingSnapshotsFromText(clipboardContents);

    if (clipboardHeadings.length === 0) {
      return [];
    }

    const firstHeading = clipboardHeadings[0];
    const matchedIndex = allHeadings.findIndex(
      ({ heading }) => heading === firstHeading.heading
    );

    if (matchedIndex < 0) {
      return [];
    }

    return allHeadings.slice(matchedIndex, matchedIndex + clipboardHeadings.length);
  }

  private async maybeHandleRecentHeadingMove(
    targetFile: TFile,
    addedHeadings: HeadingSnapshot[]
  ) {
    if (!this.recentRemovedContext) {
      return;
    }

    if (
      Date.now() - this.recentRemovedContext.timestamp >
      PersistentLinksPlugin.RECENT_MOVE_WINDOW_MS
    ) {
      this.recentRemovedContext = null;
      return;
    }

    if (this.recentRemovedContext.sourcePath === targetFile.path) {
      return;
    }

    const redirects = this.matchRemovedHeadingsToAddedHeadings(addedHeadings);

    if (redirects.length === 0) {
      return;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(
      this.recentRemovedContext.sourcePath
    );

    if (!(sourceFile instanceof TFile)) {
      this.recentRemovedContext = null;
      return;
    }

    const sourceSnapshots = this.recentRemovedContext.allHeadings;
    const backlinksToUpdate = this.getBacklinksToUpdateForRedirects(
      this.recentRemovedContext.sourcePath,
      redirects,
      sourceSnapshots
    );

    await this.registerMovedHeadings(
      sourceFile,
      targetFile,
      redirects,
      sourceSnapshots
    );

    if (backlinksToUpdate.length > 0) {
      await this.redirectMovedLinks(
        backlinksToUpdate,
        this.recentRemovedContext.sourcePath,
        targetFile,
        redirects,
        sourceSnapshots
      );
    }

    this.recentRemovedContext = null;
  }

  private matchRemovedHeadingsToAddedHeadings(addedHeadings: HeadingSnapshot[]) {
    if (!this.recentRemovedContext) {
      return [];
    }

    const matched: Array<{ from: string; to: string }> = [];
    let searchStartIndex = 0;

    for (const removedHeading of this.recentRemovedContext.headings) {
      const matchIndex = addedHeadings.findIndex(
        (addedHeading, index) =>
          index >= searchStartIndex &&
          addedHeading.heading === removedHeading.heading
      );

      if (matchIndex < 0) {
        return [];
      }

      matched.push({
        from: removedHeading.path,
        to: addedHeadings[matchIndex].path,
      });
      searchStartIndex = matchIndex + 1;
    }

    return matched;
  }

  private getRecentSourceFileForClipboard(clipboardContents: string) {
    if (!this.isRecentRemovedContextMatch(clipboardContents)) {
      return null;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(
      this.recentRemovedContext!.sourcePath
    );

    return sourceFile instanceof TFile ? sourceFile : null;
  }

  private isRecentRemovedContextMatch(clipboardContents: string) {
    if (!this.recentRemovedContext) {
      return false;
    }

    if (
      Date.now() - this.recentRemovedContext.timestamp >
      PersistentLinksPlugin.RECENT_MOVE_WINDOW_MS
    ) {
      this.recentRemovedContext = null;
      return false;
    }

    const clipboardHeadings = getHeadingSnapshotsFromText(clipboardContents);

    if (clipboardHeadings.length === 0) {
      return false;
    }

    if (clipboardHeadings.length !== this.recentRemovedContext.headings.length) {
      return false;
    }

    return clipboardHeadings.every((heading, index) => {
      const removedHeading = this.recentRemovedContext!.headings[index];
      return heading.heading === removedHeading.heading;
    });
  }

  private normalizeClipboardText(text: string) {
    return text.replace(/\r\n?/g, "\n");
  }

  private getBacklinksToUpdateForRedirects(
    sourceFilePath: string,
    redirects: Array<{ from: string; to: string }>,
    sourceSnapshots: HeadingSnapshot[]
  ) {
    const movedHeadingKeys = new Set(
      redirects.flatMap(({ from }) =>
        this.getHeadingMatchKeys(sourceFilePath, from, sourceSnapshots)
      )
    );

    return [...this.getBacklinksToFile(sourceFilePath).entries()]
      .map(([filePath, links]) => ({
        filePath,
        links: links.filter((link) => {
          if (!isHeadingLink(link.link)) {
            return false;
          }

          const { subpath } = parseLinkText(link.link);

          if (!subpath) {
            return false;
          }

          return movedHeadingKeys.has(createHeadingKey(sourceFilePath, subpath));
        }),
      }))
      .filter(({ links }) => links.length > 0);
  }

  private getMovedBacklinksToUpdate(
    sourceFilePath: string,
    clipboardContents: string,
    movedHeadingRedirects: Array<{ from: string; to: string }>,
    sourceSnapshots: HeadingSnapshot[]
  ) {
    const blockIds = new Set(getBlockIds(clipboardContents));
    const movedHeadingKeys = new Set(
      movedHeadingRedirects.flatMap(({ from }) =>
        this.getHeadingMatchKeys(sourceFilePath, from, sourceSnapshots)
      )
    );

    return [...this.getBacklinksToFile(sourceFilePath).entries()]
      .map(([filePath, links]) => ({
        filePath,
        links: links.filter((link) => {
          if (isBlockLink(link.link)) {
            return [...blockIds].some((blockId) => link.link.includes(blockId));
          }

          if (!isHeadingLink(link.link)) {
            return false;
          }

          const { subpath } = parseLinkText(link.link);

          if (!subpath) {
            return false;
          }

          return movedHeadingKeys.has(createHeadingKey(sourceFilePath, subpath));
        }),
      }))
      .filter(({ links }) => links.length > 0);
  }

  private async registerMovedHeadings(
    sourceFile: TFile,
    targetFile: TFile,
    redirects: Array<{ from: string; to: string }>,
    sourceSnapshots: HeadingSnapshot[],
    persist = true
  ) {
    let hasChanges = false;

    for (const { from, to } of redirects) {
      if (!this.hasBacklinksToHeading(sourceFile.path, from)) {
        continue;
      }

      for (const variant of this.getHeadingRedirectVariants(
        from,
        to,
        sourceSnapshots
      )) {
        if (
          !this.hasBacklinksToHeadingInSnapshots(
            sourceFile.path,
            variant.from,
            sourceSnapshots
          )
        ) {
          continue;
        }

        this.registerHeadingRedirect(
          sourceFile.path,
          variant.from,
          targetFile.path,
          variant.to
        );
        hasChanges = true;
      }
    }

    if (hasChanges && persist) {
      await this.saveSettings();
    }
  }

  private registerHeadingRedirect(
    fromPath: string,
    fromHeading: string,
    toPath: string,
    toHeading: string
  ) {
    const sourceKey = createHeadingKey(fromPath, fromHeading);
    const destination = {
      path: toPath,
      subpath: toHeading,
    };

    if (
      createHeadingKey(destination.path, destination.subpath ?? "") === sourceKey
    ) {
      if (sourceKey in this.data.headingRedirects) {
        this.redirectsDirty = true;
      }
      this.clearResolvedRedirectCache();
      delete this.data.headingRedirects[sourceKey];
      return;
    }

    if (
      this.data.headingRedirects[sourceKey]?.path !== destination.path ||
      this.data.headingRedirects[sourceKey]?.subpath !== destination.subpath
    ) {
      this.redirectsDirty = true;
      this.clearResolvedRedirectCache();
    }
    this.data.headingRedirects[sourceKey] = destination;
  }

  private getMappedHeadingDestination(linkText: string) {
    if (!isHeadingLink(linkText)) {
      return null;
    }

    const { path, subpath } = parseLinkText(linkText);

    if (!subpath) {
      return null;
    }

    let currentFile = this.getFileFromPathRelativeToActiveFile(path);
    let currentSubpath = subpath;

    if (!currentFile) {
      return null;
    }

    const latestDestination = this.resolveFinalDestinationForKey(
      createHeadingKey(currentFile.path, currentSubpath)
    );

    if (!latestDestination) {
      return null;
    }

    currentSubpath = latestDestination.subpath ?? currentSubpath;

    const resolvedDestination = this.app.vault.getAbstractFileByPath(
      latestDestination.path
    );

    if (resolvedDestination instanceof TFile) {
      currentFile = resolvedDestination;
    }

    return {
      path: this.app.metadataCache.fileToLinktext(
        currentFile,
        this.getActiveFile().path
      ),
      subpath: currentSubpath,
    };
  }

  private async updateBacklinksForHeadingRedirects(
    targetFile: TFile,
    redirects: Array<{ from: string; to: string }>,
    backlinks: BacklinksBySource,
    sourceSnapshots: HeadingSnapshot[]
  ) {
    const redirectMap = new Map<string, string>();

    for (const { from, to } of redirects) {
      for (const variant of this.getHeadingRedirectVariants(
        from,
        to,
        sourceSnapshots
      )) {
        redirectMap.set(
          createHeadingKey(targetFile.path, variant.from),
          variant.to
        );
      }
    }

    const updates = [...backlinks.entries()]
      .map(([filePath, links]) => ({
        filePath,
        links: links
          .filter(({ link }) => isHeadingLink(link))
          .map((link) => {
            const { subpath } = parseLinkText(link.link);

            if (!subpath) {
              return null;
            }

            const redirectedHeading = redirectMap.get(
              createHeadingKey(targetFile.path, subpath)
            );

            if (!redirectedHeading) {
              return null;
            }

            return {
              link,
              newPath: this.app.metadataCache.fileToLinktext(targetFile, filePath),
              newSubpath: redirectedHeading,
            };
          })
          .filter((link): link is NonNullable<typeof link> => Boolean(link)),
      }))
      .filter(({ links }) => links.length > 0);

    await Promise.all(
      updates.map(async ({ filePath, links }) => {
        const contents = await this.readFile(filePath);
        const updatedContents = redirectLinksInTextToNewPaths(links, contents);
        return this.updateFile(filePath, updatedContents);
      })
    );
  }

  private reindexLinksForFile(file: TFile) {
    this.removeIndexedLinksForSource(file.path);

    const indexedLinks = this.extractIndexedHeadingLinks(file);

    if (indexedLinks.length === 0) {
      return;
    }

    this.outgoingHeadingLinksBySource.set(file.path, indexedLinks);

    for (const indexedLink of indexedLinks) {
      const backlinks =
        this.backlinksByTargetFile.get(indexedLink.targetPath) ?? new Map();
      const linksFromSource = backlinks.get(indexedLink.sourcePath);

      if (linksFromSource) {
        linksFromSource.push(indexedLink.link);
      } else {
        backlinks.set(indexedLink.sourcePath, [indexedLink.link]);
      }
      this.backlinksByTargetFile.set(indexedLink.targetPath, backlinks);

      this.adjustHeadingLinkCount(
        createHeadingKey(indexedLink.targetPath, indexedLink.subpath),
        1
      );
    }
  }

  private removeIndexedLinksForSource(sourcePath: string) {
    const previousLinks = this.outgoingHeadingLinksBySource.get(sourcePath);

    if (!previousLinks) {
      return;
    }

    const affectedTargets = new Set(
      previousLinks.map(({ targetPath }) => targetPath)
    );

    for (const previousLink of previousLinks) {
      this.adjustHeadingLinkCount(
        createHeadingKey(previousLink.targetPath, previousLink.subpath),
        -1
      );
    }

    for (const targetPath of affectedTargets) {
      const backlinks = this.backlinksByTargetFile.get(targetPath);

      if (!backlinks) {
        continue;
      }

      backlinks.delete(sourcePath);

      if (backlinks.size === 0) {
        this.backlinksByTargetFile.delete(targetPath);
      }
    }

    this.outgoingHeadingLinksBySource.delete(sourcePath);
  }

  private extractIndexedHeadingLinks(file: TFile): IndexedHeadingLink[] {
    return this.getLinksFromMetadata(this.app.metadataCache.getFileCache(file))
      .filter(({ link }) => isHeadingLink(link))
      .map((link) => {
        const { subpath } = parseLinkText(link.link);
        const targetFile = this.resolveLinkedFile(file, link.link);

        if (!subpath || !targetFile) {
          return null;
        }

        return {
          sourcePath: file.path,
          targetPath: targetFile.path,
          subpath,
          link: this.toLinkReference(link),
        };
      })
      .filter(
        (
          indexedLink
        ): indexedLink is IndexedHeadingLink => Boolean(indexedLink)
      );
  }

  private adjustHeadingLinkCount(headingKey: string, delta: number) {
    const nextCount = (this.headingLinkCounts.get(headingKey) ?? 0) + delta;

    if (headingKey in this.data.headingRedirects) {
      this.redirectsDirty = true;
    }

    if (nextCount <= 0) {
      this.headingLinkCounts.delete(headingKey);
      return;
    }

    this.headingLinkCounts.set(headingKey, nextCount);
  }

  private reindexSubpathsForFile(file: TFile) {
    this.removeIndexedSubpathsForFile(file.path);

    const subpathKeys = this.getSubpathKeysForFile(file);

    if (subpathKeys.length === 0) {
      return;
    }

    this.fileSubpathKeysByPath.set(file.path, subpathKeys);

    for (const subpathKey of subpathKeys) {
      const paths = this.filePathsBySubpathKey.get(subpathKey) ?? new Set<string>();
      paths.add(file.path);
      this.filePathsBySubpathKey.set(subpathKey, paths);
    }
  }

  private removeIndexedSubpathsForFile(filePath: string) {
    const previousKeys = this.fileSubpathKeysByPath.get(filePath);

    if (!previousKeys) {
      return;
    }

    for (const previousKey of previousKeys) {
      const paths = this.filePathsBySubpathKey.get(previousKey);

      if (!paths) {
        continue;
      }

      paths.delete(filePath);

      if (paths.size === 0) {
        this.filePathsBySubpathKey.delete(previousKey);
      }
    }

    this.fileSubpathKeysByPath.delete(filePath);
  }

  private getSubpathKeysForFile(file: TFile) {
    const headingKeys = (this.headingSnapshots.get(file.path) ?? []).flatMap(
      ({ heading, path }) => [
        this.createSubpathIndexKey(heading, "heading"),
        this.createSubpathIndexKey(path, "heading"),
        ...getSubpathAliases(path).map((alias) =>
          this.createSubpathIndexKey(alias, "heading")
        ),
      ]
    );
    const metadata = this.app.metadataCache.getFileCache(file);
    const blockKeys = Object.keys(metadata?.blocks ?? {}).map((blockId) =>
      this.createSubpathIndexKey(blockId, "block")
    );

    return [...new Set([...headingKeys, ...blockKeys])];
  }

  private createSubpathIndexKey(
    subpath: string,
    linkOrType: string
  ) {
    return isBlockLink(linkOrType) || linkOrType === "block"
      ? `b:${subpath}`
      : `h:${normalizeSubpath(subpath)}`;
  }

  private moveBacklinksToRenamedTarget(oldPath: string, newPath: string) {
    const backlinks = this.backlinksByTargetFile.get(oldPath);

    if (!backlinks) {
      return;
    }

    const mergedBacklinks = this.backlinksByTargetFile.get(newPath) ?? new Map();

    for (const [sourcePath, links] of backlinks.entries()) {
      const existingLinks = mergedBacklinks.get(sourcePath);

      if (existingLinks) {
        existingLinks.push(...links);
      } else {
        mergedBacklinks.set(sourcePath, [...links]);
      }
    }

    this.backlinksByTargetFile.set(newPath, mergedBacklinks);
    this.backlinksByTargetFile.delete(oldPath);
  }

  private moveHeadingCountsForRenamedTarget(
    oldPath: string,
    newPath: string,
    previousHeadings: HeadingSnapshot[]
  ) {
    const uniqueHeadings = new Set(
      previousHeadings.flatMap(({ heading, path }) => [heading, path])
    );

    for (const heading of uniqueHeadings) {
      const oldKey = createHeadingKey(oldPath, heading);
      const count = this.headingLinkCounts.get(oldKey);

      if (!count) {
        continue;
      }

      this.headingLinkCounts.delete(oldKey);
      this.headingLinkCounts.set(createHeadingKey(newPath, heading), count);
    }
  }

  private removeBacklinksForDeletedTarget(filePath: string) {
    this.backlinksByTargetFile.delete(filePath);
  }

  private removeHeadingCountsForDeletedTarget(
    filePath: string,
    previousHeadings: HeadingSnapshot[]
  ) {
    const uniqueHeadings = new Set(
      previousHeadings.flatMap(({ heading, path }) => [heading, path])
    );

    for (const heading of uniqueHeadings) {
      this.headingLinkCounts.delete(createHeadingKey(filePath, heading));
    }
  }

  private renameRedirectPaths(oldPath: string, newPath: string) {
    const updatedRedirects: PluginState["headingRedirects"] = {};
    let changed = false;

    for (const [sourceKey, destination] of Object.entries(
      this.data.headingRedirects
    )) {
      const { path, subpath } = splitHeadingKey(sourceKey);
      const nextSourceKey =
        path === oldPath ? createHeadingKey(newPath, subpath) : sourceKey;
      const nextPath = destination.path === oldPath ? newPath : destination.path;

      changed =
        changed ||
        nextSourceKey !== sourceKey ||
        nextPath !== destination.path;

      updatedRedirects[nextSourceKey] = {
        path: nextPath,
        subpath: destination.subpath,
      };
    }

    if (changed) {
      this.redirectsDirty = true;
      this.clearResolvedRedirectCache();
    }
    this.data.headingRedirects = updatedRedirects;
  }

  private removeRedirectsForDeletedPath(filePath: string) {
    const updatedRedirects: PluginState["headingRedirects"] = {};
    let changed = false;

    for (const [sourceKey, destination] of Object.entries(
      this.data.headingRedirects
    )) {
      const { path } = splitHeadingKey(sourceKey);

      if (path === filePath || destination.path === filePath) {
        changed = true;
        continue;
      }

      updatedRedirects[sourceKey] = destination;
    }

    if (changed) {
      this.redirectsDirty = true;
      this.clearResolvedRedirectCache();
    }
    this.data.headingRedirects = updatedRedirects;
  }

  private resolveLinkedFile(sourceFile: TFile, linkText: string) {
    const { path } = parseLinkText(linkText);

    if (!path) {
      return sourceFile;
    }

    return this.app.metadataCache.getFirstLinkpathDest(path, sourceFile.path);
  }

  private getLinksFromMetadata(metadata: CachedMetadata | null) {
    return [...(metadata?.links ?? []), ...(metadata?.embeds ?? [])];
  }

  private getFile(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    isInstanceOf(file, TFile);
    return file;
  }

  private async readFile(path: string) {
    return this.app.vault.read(this.getFile(path));
  }

  private async updateFile(path: string, newContents: string) {
    return this.app.vault.modify(this.getFile(path), newContents);
  }

  private getActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    isNotNull(activeFile);
    return activeFile;
  }

  private async saveSettings() {
    if (!this.redirectsDirty) {
      return;
    }

    this.data.headingRedirects = this.compactHeadingRedirects();
    this.clearResolvedRedirectCache();
    const persistedData = this.serializeData(this.data.headingRedirects);
    const serializedState = JSON.stringify(persistedData);

    if (serializedState === this.lastSavedState) {
      this.redirectsDirty = false;
      return;
    }

    this.lastSavedState = serializedState;
    this.redirectsDirty = false;
    await this.saveData(persistedData);
  }

  private compactHeadingRedirects() {
    const compacted: PluginState["headingRedirects"] = {};
    const sourceKeys = Object.keys(this.data.headingRedirects);

    for (const sourceKey of sourceKeys) {
      if (!this.headingLinkCounts.has(sourceKey)) {
        continue;
      }

      const finalDestination = this.resolveFinalDestinationForKey(sourceKey);

      if (!finalDestination?.subpath) {
        continue;
      }

      if (!this.destinationExists(finalDestination)) {
        continue;
      }

      if (
        createHeadingKey(finalDestination.path, finalDestination.subpath) ===
        sourceKey
      ) {
        continue;
      }

      compacted[sourceKey] = finalDestination;
    }

    if (Object.keys(compacted).length !== sourceKeys.length) {
      this.redirectsDirty = true;
    }

    return compacted;
  }

  private resolveFinalDestinationForKey(sourceKey: string) {
    if (this.resolvedRedirectCache.has(sourceKey)) {
      return this.resolvedRedirectCache.get(sourceKey) ?? null;
    }

    let currentKey = sourceKey;
    let latestDestination = this.data.headingRedirects[sourceKey] ?? null;
    const visited = new Set<string>();

    while (latestDestination && !visited.has(currentKey)) {
      visited.add(currentKey);

      const nextKey = latestDestination.subpath
        ? createHeadingKey(latestDestination.path, latestDestination.subpath)
        : null;

      if (!nextKey || !this.data.headingRedirects[nextKey]) {
        return latestDestination;
      }

      currentKey = nextKey;
      latestDestination = this.data.headingRedirects[nextKey];
    }

    this.resolvedRedirectCache.set(sourceKey, latestDestination);
    return latestDestination;
  }

  private destinationExists(destination: {
    path: string;
    subpath?: string;
  }) {
    const file = this.app.vault.getAbstractFileByPath(destination.path);

    if (!(file instanceof TFile)) {
      return false;
    }

    return destination.subpath
      ? isSubpathInMetadata(
          destination.subpath,
          this.app.metadataCache.getFileCache(file)
        )
      : true;
  }

  private deserializeRedirects(storedData: PersistentLinksData | null) {
    const redirects: PluginState["headingRedirects"] = {};

    if (storedData?.redirects) {
      for (const [sourcePath, sourceRedirects] of Object.entries(
        storedData.redirects
      )) {
        for (const [normalizedSubpath, destination] of Object.entries(
          sourceRedirects
        )) {
          redirects[createHeadingKey(sourcePath, normalizedSubpath)] = {
            path: destination[0],
            subpath: destination[1],
          };
        }
      }

      return redirects;
    }

    return {
      ...storedData?.headingRedirects,
    };
  }

  private serializeData(
    headingRedirects: PluginState["headingRedirects"]
  ): PersistentLinksData {
    return {
      redirects: this.serializeRedirects(headingRedirects),
    };
  }

  private serializeRedirects(
    headingRedirects: PluginState["headingRedirects"]
  ): SerializedHeadingRedirects {
    const redirects: SerializedHeadingRedirects = {};

    for (const [sourceKey, destination] of Object.entries(headingRedirects)) {
      if (!destination.subpath) {
        continue;
      }

      const { path, subpath } = splitHeadingKey(sourceKey);
      const sourceRedirects = redirects[path] ?? {};

      sourceRedirects[subpath] = [destination.path, destination.subpath];
      redirects[path] = sourceRedirects;
    }

    return redirects;
  }

  private toLinkReference(link: LinkCache): LinkReference {
    return {
      link: link.link,
      original: link.original,
      position: link.position,
    };
  }

  private clearResolvedRedirectCache() {
    this.resolvedRedirectCache.clear();
  }
}
