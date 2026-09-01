export type EditorialImage = Readonly<{
  alt: string;
  canonicalPath: "/reading/deepseek-harness/" | "/reading/hax/" | "/reading/headlong-microharness/" | "/reading/oracle-and-firm/";
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
  {
    alt: "One compacting serial thread contrasted with several windows handing summaries to a parent desk",
    canonicalPath: "/reading/oracle-and-firm/",
    caption: "An oracle keeps one thread; a firm splits work onto child windows that return summaries.",
    cardDescription: "Reading HRA as a Codex account loop, an oracle thread rather than a firm of sub-agents.",
    cardTitle: "A Codex account loop is an oracle thread, not a firm",
    credit,
    height: 864,
    imageSha256: "9972242c35269f3f7ce7617b30079047163c04228ca80afe855d2e9f0ec6b4b6",
    provenance: {
      job: "editorial-provenance/oracle-and-firm/job.json",
      prompt: "editorial-provenance/oracle-and-firm/prompt.txt",
      receipt: "editorial-provenance/oracle-and-firm/receipt.json",
    },
    src: "/images/editorial/oracle-and-firm.webp",
    title: "A Codex account loop is an oracle thread, not a firm",
    width: 1536,
  },
  {
    alt: "One compact linear tool contrasted with three separately bounded account session loops",
    canonicalPath: "/reading/hax/",
    caption: "A terminal-native coding agent and an isolated account loop organize different kinds of work.",
    cardDescription: "Reading hax as a Unix coding agent, not an isolated Codex account loop.",
    cardTitle: "A terminal-native coding agent is not a Codex account loop",
    credit,
    height: 864,
    imageSha256: "a4c1c180924564045da064dc7442309c48b2a92616c01a3d59d32932985add3a",
    provenance: {
      job: "editorial-provenance/hax/job.json",
      prompt: "editorial-provenance/hax/prompt.txt",
      receipt: "editorial-provenance/hax/receipt.json",
    },
    src: "/images/editorial/hax.webp",
    title: "A terminal-native coding agent is not a Codex account loop",
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
