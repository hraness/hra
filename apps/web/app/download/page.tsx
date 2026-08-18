import {
  LinkButton,
  ThemeToggle,
} from "@hra-internal/design-kit/react";
import { createPublicSiteMetadata } from "@hraness/web-discovery";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import {
  HRA_BRAND_ICON_PATH,
  HRA_RELEASE,
  HRA_RELEASE_CHECKSUM_URL,
  HRA_RELEASE_MANIFEST_URL,
  HRA_RELEASE_URL,
  hraSearchSite,
} from "../site";

export const metadata = createPublicSiteMetadata({
  ...hraSearchSite,
  description:
    "Download the HRA Apple Silicon prerelease, verify its checksum, or build it from public source.",
  socialTitle: "Download HRA for Apple Silicon",
  title: "HRA for macOS",
}, { canonicalPath: "/download" }) satisfies Metadata;

export default function DownloadPage() {
  const publishedUrls = HRA_RELEASE_URL !== null
    && HRA_RELEASE_CHECKSUM_URL !== null
    && HRA_RELEASE_MANIFEST_URL !== null
    ? {
        checksum: HRA_RELEASE_CHECKSUM_URL,
        dmg: HRA_RELEASE_URL,
        manifest: HRA_RELEASE_MANIFEST_URL,
      }
    : null;
  const published = publishedUrls !== null;
  return (
    <div className="download-page">
      <a className="landing-skip-link" href="#main-content">Skip to content</a>
      <div className="download-shell">
        <header className="download-header">
          <Link className="download-wordmark" href="/download" aria-label="HRA download">
            <span aria-hidden="true">
              <Image
                alt=""
                className="brand-icon-image"
                height={512}
                src={HRA_BRAND_ICON_PATH}
                width={512}
              />
            </span>
            <strong>HRA</strong>
          </Link>
          <div className="download-header__actions">
            <Link className="download-control-plane-link" href="/app">
              Open control plane
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content">
          <section className="download-hero" aria-labelledby="download-title">
          <div className="download-hero__copy">
            <p className="download-channel">
              <span aria-hidden="true" />
              Public prerelease
            </p>
            <h1 id="download-title">Download HRA for your Mac.</h1>
            <p className="download-summary">
              The native prerelease bundles HRA, Codex, and Git for Apple Silicon Macs running macOS {HRA_RELEASE.minimumMacOS} or newer.
            </p>
            <p className="download-trust-callout">
              <strong>Unknown developer.</strong> This candidate uses an ad-hoc code seal, but it is not Developer ID signed or notarized by Apple. {published
                ? "The published SHA-256 verifies the exact release bytes; macOS will still ask you to approve the app manually."
                : "Its release commit, tag, manifest, and artifact hashes are still awaiting publication."}
            </p>
            <div className="download-primary-action">
              {publishedUrls !== null
                ? (
                    <LinkButton
                      href={publishedUrls.dmg}
                      size="large"
                      variant="primary"
                    >
                      Download the DMG <span aria-hidden="true">↓</span>
                    </LinkButton>
                  )
                : (
                    <p>
                      <strong>Candidate verification in progress.</strong> Do not install an unpublished draft asset.
                    </p>
                  )}
              <p>Version {HRA_RELEASE.version} ({HRA_RELEASE.build}) · Apple Silicon · macOS {HRA_RELEASE.minimumMacOS}+</p>
            </div>
          </div>

          <aside className="download-release-card" aria-label="HRA prerelease details">
            <div className="download-release-card__topline">
              <span>macOS {HRA_RELEASE.version}</span>
              <span className="download-release-state download-release-state--pending">
                {published ? "Published prerelease" : "Candidate"}
              </span>
            </div>
            <div className="download-app-tile" aria-hidden="true">
              <Image
                alt=""
                className="brand-icon-image"
                height={512}
                src={HRA_BRAND_ICON_PATH}
                width={512}
              />
            </div>
            <dl className="download-release-facts">
              <div>
                <dt>Architecture</dt>
                <dd>Apple Silicon</dd>
              </div>
              <div>
                <dt>Minimum system</dt>
                <dd>macOS {HRA_RELEASE.minimumMacOS}</dd>
              </div>
              <div>
                <dt>Signing</dt>
                <dd>Ad-hoc · not notarized</dd>
              </div>
              <div>
                <dt>Distribution</dt>
                <dd>{published ? "GitHub prerelease" : "Not published"}</dd>
              </div>
            </dl>
            <p className="download-release-disclosure">
              {publishedUrls !== null
                ? <>The exact source, runtime pins, corresponding-source archives, <a href={publishedUrls.manifest}>release manifest</a>, and checksum are public.</>
                : <>The repository records the candidate identity. Direct downloads remain disabled until the exact source, annotated tag, manifest, checksum, and artifact hashes are published.</>} This is an early testing build, not a normal Apple-trusted release.
            </p>
          </aside>
          </section>

          <section className="download-install" aria-labelledby="install-title">
          <div className="download-section-heading">
            <p className="eyebrow">Install the prerelease</p>
            <h2 id="install-title">Verify it before you open it.</h2>
          </div>
          {publishedUrls !== null ? <ol className="download-steps" role="list">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>Download both files</h3>
                <p>Save the <a href={publishedUrls.dmg}>DMG</a> and its <a href={publishedUrls.checksum}>SHA-256 file</a> in the same folder.</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>Check the bytes</h3>
                <p>In Terminal, run <code>shasum -a 256 -c {HRA_RELEASE.asset}.sha256</code>. Continue only when it prints <code>OK</code>.</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <div>
                <h3>Copy HRA to Applications</h3>
                <p>Open the DMG and drag <strong>HRA</strong> into the Applications folder.</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">04</span>
              <div>
                <h3>Approve the unknown developer</h3>
                <p>Control-click HRA in Finder and choose <strong>Open</strong>. If macOS still blocks it, use <strong>System Settings → Privacy &amp; Security → Open Anyway</strong>.</p>
              </div>
            </li>
          </ol> : (
            <div className="download-steps">
              <p>
                HRA {HRA_RELEASE.version} ({HRA_RELEASE.build}) is a checked source candidate. Do not drag a second app beside an installed OPRTE predecessor, and do not install an unpublished draft asset.
              </p>
              <p>
                You can inspect or build the candidate from <a href={HRA_RELEASE.repository}>the canonical HRA repository</a> while release evidence is completed.
              </p>
            </div>
          )}
          <p className="download-security-note">
            HRA can run coding agents with local filesystem and process authority. Pair only repositories and Codex accounts you intend it to use.
          </p>
          </section>

          <section className="download-trust-grid" aria-label="Source and release status">
          <article>
            <p className="eyebrow">Build it yourself</p>
            <h2>Build HRA from source.</h2>
            <p>
              The public repository pins Bun, Zig, Codex, Git, native build inputs, and the package verifier. Build the same app locally if the ad-hoc release boundary is not right for you.
            </p>
            <a href="https://github.com/hraness/hra#develop-hra">Read the build instructions →</a>
          </article>
          <article>
            <p className="eyebrow">What remains</p>
            <h2>Developer ID signing is not available yet.</h2>
            <p>
              A later release needs a Developer ID certificate and Apple notarization before normal double-click installation can replace the unknown-developer flow. Automatic updates remain disabled until HRA owns a signed update channel.
            </p>
          </article>
          </section>
        </main>

        <footer className="download-footer">
          <span>HRA prerelease</span>
          <a href="https://github.com/hraness/hra">github.com/hraness/hra</a>
        </footer>
      </div>
    </div>
  );
}
