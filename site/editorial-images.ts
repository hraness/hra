export type EditorialImage = Readonly<{
  alt: string;
  canonicalPath: "/reading/deepseek-harness/" | "/reading/headlong-microharness/";
  caption: string;
  cardDescription: string;
  cardTitle: string;
  credit: string;
  height: 864;
  imageSha256: string;
  provenance: Readonly<{
    job: string;
    prompt: string;
    receipt: string;
  }>;
  src: `/images/editorial/${string}.webp`;
  title: string;
  width: 1536;
}>;

const credit = "Editorial illustration generated for hra.sh with Atet.";

export const editorialImages = [
  {
    alt: "Modular plugin tiles contrasted with three separately bounded account session loops",
    canonicalPath: "/reading/deepseek-harness/",
    caption: "A plugin catalog and an isolated account loop organize different kinds of work.",
    cardDescription: "Reading DeepSeek Harness as a plugin-first reference, not an isolated Codex account loop.",
    cardTitle: "A plugin catalog is not a Codex account loop",
    credit,
    height: 864,
    imageSha256: "c67e16cf350507572d398b06eff27d8962dca21fcac405640d19f46048a80368",
    provenance: {
      job: "editorial-provenance/deepseek-harness/job.json",
      prompt: "editorial-provenance/deepseek-harness/prompt.txt",
      receipt: "editorial-provenance/deepseek-harness/receipt.json",
    },
    src: "/images/editorial/deepseek-harness.webp",
    title: "A plugin catalog is not a Codex account loop",
    width: 1536,
  },
  {
    alt: "One continuous persistence ribbon contrasted with three separate durable account session tracks",
    canonicalPath: "/reading/headlong-microharness/",
    caption: "Persistence is shared; a continuous thought stream and isolated account sessions remain different objects.",
    cardDescription: "Reading Headlong as a persistence design, not an isolated Codex account loop.",
    cardTitle: "A microharness for persistence is not a Codex account loop",
    credit,
    height: 864,
    imageSha256: "5676a6a3dc676798c7a46d2865e994817ee6addcb07e32d487bf437478bff8e9",
    provenance: {
      job: "editorial-provenance/headlong-microharness/job.json",
      prompt: "editorial-provenance/headlong-microharness/prompt.txt",
      receipt: "editorial-provenance/headlong-microharness/receipt.json",
    },
    src: "/images/editorial/headlong-microharness.webp",
    title: "A microharness for persistence is not a Codex account loop",
    width: 1536,
  },
] as const satisfies readonly EditorialImage[];

export type EditorialPath = (typeof editorialImages)[number]["canonicalPath"];

export const editorialImage = (canonicalPath: string): EditorialImage | undefined =>
  editorialImages.find((image) => image.canonicalPath === canonicalPath);

export const editorialImageUrl = (image: EditorialImage): string =>
  `https://hra.sh${image.src}`;

export const editorialImageSrcSet = (image: EditorialImage): string => {
  const stem = image.src.slice(0, -".webp".length);
  return `${stem}-384.webp 384w, ${stem}-768.webp 768w, ${image.src} ${image.width}w`;
};
