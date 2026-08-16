import {
  LinkButton,
  ThemeToggle,
} from "@hra-internal/design-kit/react";
import { createPublicSiteMetadata } from "@hra-internal/web-discovery";
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
              <strong>Unknown developer.</strong> This build has an ad-hoc code seal, but it is not Developer ID signed or notarized by Apple. The published SHA-256 verifies the exact release bytes; macOS will still ask you to approve the app manually.
            </p>
            <div className="download-primary-action">
              <LinkButton
                href={HRA_RELEASE_URL}
                size="large"
                variant="primary"
              >
                Download the DMG <span aria-hidden="true">↓</span>
              </LinkButton>
              <p>Version {HRA_RELEASE.version} ({HRA_RELEASE.build}) · Apple Silicon · macOS {HRA_RELEASE.minimumMacOS}+</p>
            </div>
          </div>

          <aside className="download-release-card" aria-label="HRA prerelease details">
            <div className="download-release-card__topline">
              <span>macOS {HRA_RELEASE.version}</span>
              <span className="download-release-state download-release-state--pending">
                Prerelease
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
                <dd>GitHub prerelease</dd>
              </div>
            </dl>
            <p className="download-release-disclosure">
              The exact source, runtime pins, corresponding-source archives, <a href={HRA_RELEASE_MANIFEST_URL}>release manifest</a>, and checksum are public. This is an early testing build, not a normal Apple-trusted release.
            </p>
          </aside>
          </section>

          <section className="download-install" aria-labelledby="install-title">
          <div className="download-section-heading">
            <p className="eyebrow">Install the prerelease</p>
            <h2 id="install-title">Verify it before you open it.</h2>
          </div>
          <ol className="download-steps" role="list">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>Download both files</h3>
                <p>Save the <a href={HRA_RELEASE_URL}>DMG</a> and its <a href={HRA_RELEASE_CHECKSUM_URL}>SHA-256 file</a> in the same folder.</p>
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
          </ol>
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
