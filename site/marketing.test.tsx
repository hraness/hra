import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { findSection, publicContent, type PublicContent } from "./content.ts";
import { renderMarketingHeader, renderMarketingPage, renderReferenceLabel } from "./marketing.tsx";
import { heroExampleMeasureClassName } from "./marketing.stylex.ts";
import { sitePresentationClasses } from "./presentation.stylex.ts";

const referenceMarkup = '<div class="reference__intro"><p>Trusted &amp; escaped reference.</p></div><nav aria-label="Documentation"><a href="#fixture-section">Fixture section</a></nav><section id="fixture-section"><h2>Fixture section</h2><p>Unchanged reference body.</p></section>';

function classNames(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Expected nonempty rendered class names.");
  return value.split(" ");
}

describe("public server marketing composition", () => {
  test("preserves header destinations, order, active page and the install action", () => {
    for (const currentPath of ["/", "/privacy/"] as const) {
      const { document } = parseHTML(renderMarketingHeader(publicContent, currentPath));
      const header = document.querySelector("header");
      expect(header?.getAttribute("data-hraness-marketing")).toBe("header");
      expect(header?.querySelector(".hraness-marketing-header__brand")?.textContent).toBe(publicContent.productName);
      expect(header?.querySelector(".hraness-marketing-header__brand")?.getAttribute("href")).toBe("/");
      const links = [...document.querySelectorAll('nav[aria-label="Site"] > a')];
      expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
        ["/#how-it-works", "How it works"], ["/#install-command", "Install"], ["/#reference", "Reference"],
        ["/privacy/", "Privacy"], [publicContent.links.github, "GitHub"],
      ]);
      expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent))
        .toEqual([currentPath === "/" ? "How it works" : "Privacy"]);
      expect(header?.querySelector(".hraness-marketing-header__actions > a")?.getAttribute("href")).toBe("/#install-command");
      expect(header?.querySelector(".hraness-marketing-header__actions > a")?.textContent).toBe(`Install ${publicContent.productName}`);
      expect(document.querySelector("[style], style, script")).toBeNull();
    }
  });

  test("keeps marketing roles and the one trusted Reference wrapper in their original order", () => {
    const html = renderMarketingPage(publicContent, referenceMarkup);
    const { document } = parseHTML(html);
    const page = document.querySelector('[data-hraness-marketing="page"]');
    expect(page).not.toBeNull();
    expect([...page!.children].map((child) => child.id === "reference" ? "reference" : child.getAttribute("data-hraness-marketing")))
      .toEqual(["hero", "pillars", "section", "install", "trust", "questions", "maker", "cta", "reference"]);
    expect(document.querySelectorAll("#reference")).toHaveLength(1);
    expect(document.querySelector("#reference")?.parentElement === page).toBe(true);
    expect([...document.querySelector("#reference")!.children].map((child) => child.tagName)).toEqual(["DIV", "NAV", "SECTION"]);
    expect(html).toContain(referenceMarkup);
    expect(document.querySelector("[style], style, script")).toBeNull();
    expect(document.querySelector("h1")?.id).toBe("hra-title");
    expect(document.querySelector("h1")?.textContent).toBe(publicContent.hero.heading);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const heroClasses = classNames(document.querySelector('[data-hraness-marketing="hero"]')?.className);
    for (const name of classNames(heroExampleMeasureClassName())) expect(heroClasses).toContain(name);
    expect(document.querySelector(".hraness-marketing-facts")?.children).toHaveLength(4);
    expect(document.querySelector(".hraness-marketing-pillars")?.children).toHaveLength(3);
    expect([...document.querySelectorAll(".hraness-marketing-facts__label")].map((node) => node.textContent))
      .toEqual(publicContent.hero.facts.map((fact) => fact.label));
    expect([...document.querySelectorAll(".hraness-marketing-pillars__summary")].map((node) => node.textContent))
      .toEqual(publicContent.hero.pillars.map((pillar) => pillar.summary));
  });

  test("preserves both rollout notices, their precise placement and all conditional commands", () => {
    const { document } = parseHTML(renderMarketingPage(publicContent, referenceMarkup));
    const notice = document.querySelector(".hraness-marketing-hero__copy > aside.notice");
    expect(notice?.previousElementSibling?.classList.contains("hraness-marketing-hero__boundary")).toBe(true);
    expect(notice?.nextElementSibling).toBeNull();
    expect(notice?.querySelector("strong")?.textContent).toBe("Current daemon rollout blocked");
    expect(notice?.querySelector("p")?.textContent).toBe(publicContent.daemonRolloutNotice);
    expect(notice?.querySelector("a")?.getAttribute("href")).toBe("#install-and-update");
    expect(notice?.querySelector("a")?.parentElement?.textContent).toBe("Read the rollout and update runbook before running the examples below.");
    const note = document.querySelector(".hraness-marketing-install__heading-group > .install-note");
    expect(note?.previousElementSibling?.id).toBe("install-command-heading");
    expect(note?.previousElementSibling?.textContent).toBe("Install only after candidate admission.");
    expect(note?.nextElementSibling).toBeNull();
    expect(note?.textContent).toBe("This release candidate is not yet admitted. Only after immutable GitHub and npm release admission, use the command to download the exact release, verify its digest, and install it. Installing and checking the binary does not start the daemon. Initialization remains blocked by the rollout prerequisite.");
    const commands = document.querySelector(".hraness-marketing-install__commands");
    expect([...commands!.children].map((child) => child.tagName)).toEqual(["PRE", "PRE", "ASIDE", "P", "PRE"]);
    expect(commands?.querySelector("aside strong")?.textContent).toBe("Before initialization");
    expect(commands?.querySelector("aside p")?.textContent).toBe(publicContent.daemonRolloutNotice);
    expect(commands?.querySelector("aside a")?.textContent).toBe("Read the rollout and update runbook.");
    for (const [hook, command] of [
      ["install-command", publicContent.installCommand], ["doctor-command", publicContent.doctorCommand], ["init-command", publicContent.initCommand],
    ]) {
      expect(document.querySelector(`pre.${hook}`)?.textContent).toBe(command);
      expect(document.querySelector(`pre.${hook}`)?.getAttribute("tabindex")).toBe("0");
    }
    const firstSession = findSection(publicContent, "first-session").blocks.find((block) => block.kind === "commands");
    if (firstSession?.kind !== "commands") throw new Error("Missing public first-session commands.");
    expect(document.querySelector("pre.shell-transcript")?.textContent).toBe(firstSession.commands.join("\n"));
    expect(document.querySelectorAll(".hraness-marketing-hero__frame")).toHaveLength(1);
    expect(document.querySelector(".hraness-marketing-hero__frame > figure")?.classList.contains("hraness-marketing-proof-frame")).toBe(true);
    expect(document.querySelector(".hraness-marketing-proof-frame__caption > small")?.textContent).toBe(`v${publicContent.releaseVersion}`);
    expect([...document.querySelectorAll(".hraness-marketing-flow__code")].map((node) => node.textContent))
      .toEqual(publicContent.hero.steps.map((step) => step.command));
  });

  test("keeps every published marketing collection, action and summary attached to its native role", () => {
    const { document } = parseHTML(renderMarketingPage(publicContent, referenceMarkup));
    const textAt = (selector: string) => document.querySelector(selector)?.textContent;
    const textsAt = (selector: string) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
    for (const [role, text] of [
      ["eyebrow", publicContent.hero.eyebrow], ["name", publicContent.productName],
      ["summary", publicContent.hero.summary], ["example", publicContent.hero.example], ["boundary", publicContent.hero.boundary],
    ]) expect(textAt(`.hraness-marketing-hero__${role}`)).toBe(text);
    expect(textsAt(".hraness-marketing-facts__value")).toEqual(publicContent.hero.facts.map((fact) => fact.value));
    expect(textsAt(".hraness-marketing-facts__detail")).toEqual(publicContent.hero.facts.map((fact) => fact.detail));
    expect(textsAt(".hraness-marketing-pillars__label")).toEqual(publicContent.hero.pillars.map((pillar) => pillar.label));
    expect(textAt("#how-it-works-heading")).toBe(publicContent.hero.proofLabel);
    expect(textsAt(".hraness-marketing-flow__label")).toEqual(publicContent.hero.steps.map((step) => step.label));
    expect(textsAt(".hraness-marketing-flow__detail")).toEqual(publicContent.hero.steps.map((step) => step.detail));
    expect(textsAt(".hraness-marketing-trust-item__label")).toEqual(publicContent.trust.map((item) => item.label));
    expect(textsAt(".hraness-marketing-trust-item__detail")).toEqual(publicContent.trust.map((item) => item.detail));
    expect(textAt(".hraness-marketing-trust__summary"))
      .toBe(`${publicContent.productName} is infrastructure around the provider tools you chose, not a proxy in front of them.`);
    expect(textsAt("details > summary")).toEqual(publicContent.questions.map((question) => question.question));
    expect(textsAt(".hraness-marketing-question__answer")).toEqual(publicContent.questions.map((question) =>
      question.answer.map((part) => part.kind === "link" ? part.label : part.value).join("")));
    expect(textAt("#maker-heading")).toBe(publicContent.maker.heading);
    expect([...document.querySelectorAll(".hraness-marketing-maker__links a")].map((node) => [node.getAttribute("href"), node.textContent]))
      .toEqual(publicContent.maker.links.map((link) => [link.href, link.label]));
    const actionsAt = (selector: string) => [...document.querySelectorAll(selector)]
      .map((node) => [node.getAttribute("href"), node.textContent, node.getAttribute("data-emphasis")]);
    expect(actionsAt(".hraness-marketing-hero__actions > a")).toEqual([
      [publicContent.hero.primaryAction.href, publicContent.hero.primaryAction.label, "primary"],
      [publicContent.hero.secondaryAction.href, publicContent.hero.secondaryAction.label, "secondary"],
    ]);
    expect(actionsAt(".hraness-marketing-cta__actions > a")).toEqual([
      ["#install-command", `Install ${publicContent.productName}`, "primary"],
      [publicContent.links.github, "Read the source", "secondary"],
    ]);
    expect(textAt(".hraness-marketing-cta__summary")).toBe("After artifact admission, install and verify the candidate CLI. After the rollout prerequisite is satisfied, initialize it, add one account, and start a session that outlives the tab it began in.");
    expect(textAt(".hraness-marketing-cta__footnote")).toBe(publicContent.hero.boundary);
  });

  test("styles FAQ and Maker link-list anchors without restyling the Maker bio or adding focus overrides", () => {
    const sample: PublicContent = {
      ...publicContent,
      maker: {
        ...publicContent.maker,
        bio: [{ kind: "text", value: "Built by " }, { kind: "link", label: "Maker", href: "https://example.test/maker" }, { kind: "code", value: "safe <text>" }],
        links: [{ label: "Site", href: "https://example.test/site" }],
      },
      questions: [{ question: "A native question?", answer: [{ kind: "link", label: "Answer", href: "https://example.test/answer" }] }],
    };
    const { document } = parseHTML(renderMarketingPage(sample, referenceMarkup));
    expect(document.querySelector(".hraness-marketing-maker__body > p > a")?.hasAttribute("class")).toBe(false);
    expect(document.querySelector(".hraness-marketing-maker__body > p > code")?.textContent).toBe("safe <text>");
    expect(document.querySelector(".hraness-marketing-maker__links a")?.getAttribute("class")).toBe(sitePresentationClasses("proseLink"));
    expect(document.querySelector(".hraness-marketing-question__answer a")?.getAttribute("class")).toBe(sitePresentationClasses("proseLink"));
    expect(document.querySelectorAll("details > summary")).toHaveLength(1);
    expect(document.querySelector("details > summary")?.textContent).toBe("A native question?");
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("[style], style, script")).toBeNull();
  });

  test("escapes ordinary product text and rejects missing first-session evidence", () => {
    const heading = '<script data-untrusted="true">not markup</script>';
    const { document } = parseHTML(renderMarketingPage({ ...publicContent, hero: { ...publicContent.hero, heading } }, referenceMarkup));
    expect(document.querySelector("h1")?.textContent).toBe(heading);
    expect(document.querySelector("script")).toBeNull();
    const sample = {
      ...publicContent,
      sections: publicContent.sections.map((section) => section.id === "first-session"
        ? { ...section, blocks: section.blocks.filter((block) => block.kind !== "commands") }
        : section),
    };
    expect(() => renderMarketingPage(sample, referenceMarkup)).toThrow("Public content must publish the human-terminal first-session commands.");
  });

  test("renders the Reference label through the public body-size slot without a competing local font atom", () => {
    const { document } = parseHTML(renderReferenceLabel());
    const label = document.querySelector("p");
    expect(label?.textContent).toBe("Reference");
    expect(label?.classList.contains("hraness-marketing-section__label")).toBe(true);
    expect(label?.getAttribute("data-size")).toBe("body");
    const labelClasses = classNames(label?.className);
    for (const name of classNames(sitePresentationClasses("proseMeasure"))) expect(labelClasses).toContain(name);
    expect(document.querySelector("[style], style, script")).toBeNull();
  });
});
