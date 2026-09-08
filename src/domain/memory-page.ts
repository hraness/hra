import { canonicalSha256 } from "@hraness/oh";

export type MemoryPageContent = Readonly<{
  body: string;
  key: string;
  language?: string | undefined;
  summary: string;
  title: string;
}>;

export const memoryPageContentDigest = (value: MemoryPageContent): string => canonicalSha256({
  body: value.body,
  language: value.language ?? null,
  summary: value.summary,
  title: value.title,
  v: 1,
});

export const memoryPageKeyDigest = (key: string): string => canonicalSha256({ key, v: 1 });

export const memoryPagePhysicalKey = (key: string): string => `edition:${key}`;

export const memoryPageUserKey = (key: string): string | null =>
  key.startsWith("edition:")
    ? key.slice("edition:".length)
    : null;
