export const themeColorSyncActiveAttribute = "data-hra-theme-color-active";
export const themeColorSyncDisabledAttribute = "data-hra-theme-color-disabled";

interface DisabledThemeColorMeta {
  readonly media: string | null;
}

interface ThemeColorMetaManager {
  readonly activeMetas: Set<HTMLMetaElement>;
  activeMeta: HTMLMetaElement | null;
  readonly disabledMetas: Map<HTMLMetaElement, DisabledThemeColorMeta>;
  readonly document: Document;
  readonly metaName: string;
  observer: MutationObserver | null;
  readonly owner: string;
  readonly registrations: Map<symbol, string>;
}

export interface ThemeColorMetaRegistration {
  readonly release: () => void;
  readonly update: (color: string) => void;
}

const managersByDocument = new WeakMap<Document, Map<string, ThemeColorMetaManager>>();
let ownerSequence = 0;

function exactThemeColorMetas(manager: ThemeColorMetaManager): HTMLMetaElement[] {
  return Array.from(manager.document.head.querySelectorAll<HTMLMetaElement>("meta[name]"))
    .filter((meta) => meta.name === manager.metaName);
}

function currentRegisteredColor(manager: ThemeColorMetaManager): string {
  let color: string | undefined;
  for (const registeredColor of manager.registrations.values()) color = registeredColor;
  if (color === undefined) throw new Error("Theme color synchronization has no active owner.");
  return color;
}

function restoreDisabledMeta(
  meta: HTMLMetaElement,
  original: DisabledThemeColorMeta,
): void {
  if (original.media === null) meta.removeAttribute("media");
  else meta.setAttribute("media", original.media);
  meta.removeAttribute(themeColorSyncDisabledAttribute);
}

function createActiveMeta(manager: ThemeColorMetaManager): HTMLMetaElement {
  const meta = manager.document.createElement("meta");
  meta.name = manager.metaName;
  meta.content = currentRegisteredColor(manager);
  meta.setAttribute(themeColorSyncActiveAttribute, manager.owner);
  manager.activeMetas.add(meta);

  const first = exactThemeColorMetas(manager)
    .find((candidate) => candidate.parentElement === manager.document.head);
  manager.document.head.insertBefore(meta, first ?? null);
  return meta;
}

function activeMetaIsOwned(manager: ThemeColorMetaManager): boolean {
  const active = manager.activeMeta;
  return active !== null
    && active.parentElement === manager.document.head
    && active.name === manager.metaName
    && !active.hasAttribute("media")
    && active.getAttribute(themeColorSyncActiveAttribute) === manager.owner;
}

function disableCompetingMeta(
  manager: ThemeColorMetaManager,
  meta: HTMLMetaElement,
): void {
  if (manager.disabledMetas.has(meta)) {
    if (meta.getAttribute(themeColorSyncDisabledAttribute) !== manager.owner) {
      meta.setAttribute(themeColorSyncDisabledAttribute, manager.owner);
    }
    if (meta.getAttribute("media") !== "not all") meta.setAttribute("media", "not all");
    return;
  }

  const ownedBy = meta.getAttribute(themeColorSyncDisabledAttribute);
  if (ownedBy !== null || meta.getAttribute("media")?.trim().toLowerCase() === "not all") return;

  manager.disabledMetas.set(meta, { media: meta.getAttribute("media") });
  meta.setAttribute(themeColorSyncDisabledAttribute, manager.owner);
  meta.setAttribute("media", "not all");
}

function reconcileThemeColorMetas(manager: ThemeColorMetaManager): void {
  if (manager.registrations.size === 0) return;
  for (const [meta, original] of manager.disabledMetas) {
    if (!manager.document.head.contains(meta) || meta.name !== manager.metaName) {
      restoreDisabledMeta(meta, original);
      manager.disabledMetas.delete(meta);
    }
  }

  if (!activeMetaIsOwned(manager)) manager.activeMeta = createActiveMeta(manager);
  const active = manager.activeMeta;
  if (active === null) return;

  const metas = exactThemeColorMetas(manager);
  const first = metas.find((meta) => meta.parentElement === manager.document.head);
  if (first !== undefined && first !== active) manager.document.head.insertBefore(active, first);

  const color = currentRegisteredColor(manager);
  if (active.content !== color) active.content = color;
  for (const meta of metas) {
    if (meta !== active) disableCompetingMeta(manager, meta);
  }
}

function observeThemeColorMetas(manager: ThemeColorMetaManager): void {
  const Observer = manager.document.defaultView?.MutationObserver;
  if (Observer === undefined) return;
  manager.observer = new Observer(() => reconcileThemeColorMetas(manager));
  manager.observer.observe(manager.document.head, {
    attributeFilter: [
      "content",
      "media",
      "name",
      themeColorSyncActiveAttribute,
      themeColorSyncDisabledAttribute,
    ],
    attributes: true,
    childList: true,
    subtree: true,
  });
}

function destroyThemeColorManager(manager: ThemeColorMetaManager): void {
  manager.observer?.disconnect();
  manager.observer = null;

  for (const meta of manager.activeMetas) meta.remove();
  for (const [meta, original] of manager.disabledMetas) restoreDisabledMeta(meta, original);
  manager.activeMetas.clear();
  manager.disabledMetas.clear();
  manager.activeMeta = null;

  const documentManagers = managersByDocument.get(manager.document);
  if (documentManagers?.get(manager.metaName) === manager) {
    documentManagers.delete(manager.metaName);
  }
}

/**
 * Owns one active unqualified meta while preserving adaptive server tags for
 * first paint and restoring them after the final synchronized owner unmounts.
 */
export function acquireThemeColorMeta(
  document: Document,
  metaName: string,
  registrationId: symbol,
  color: string,
): ThemeColorMetaRegistration {
  let documentManagers = managersByDocument.get(document);
  if (documentManagers === undefined) {
    documentManagers = new Map();
    managersByDocument.set(document, documentManagers);
  }

  let manager = documentManagers.get(metaName);
  if (manager === undefined) {
    ownerSequence += 1;
    manager = {
      activeMeta: null,
      activeMetas: new Set(),
      disabledMetas: new Map(),
      document,
      metaName,
      observer: null,
      owner: String(ownerSequence),
      registrations: new Map(),
    };
    documentManagers.set(metaName, manager);
  }

  manager.registrations.set(registrationId, color);
  reconcileThemeColorMetas(manager);
  if (manager.observer === null) observeThemeColorMetas(manager);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      manager.registrations.delete(registrationId);
      if (manager.registrations.size === 0) destroyThemeColorManager(manager);
      else reconcileThemeColorMetas(manager);
    },
    update: (nextColor) => {
      if (released || !manager.registrations.has(registrationId)) return;
      manager.registrations.set(registrationId, nextColor);
      reconcileThemeColorMetas(manager);
    },
  };
}
