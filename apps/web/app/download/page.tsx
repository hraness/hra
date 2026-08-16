import {
  LinkButton,
  ThemeToggle,
} from "@hra-internal/design-kit/react";
import { createPublicSiteMetadata } from "@hra-internal/web-discovery";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import { HRA_BRAND_ICON_PATH, hraSearchSite } from "../site";

export const metadata = createPublicSiteMetadata({
  ...hraSearchSite,
  description:
    "Build the HRA prerelease for Apple Silicon from its public source.",
  socialTitle: "Build HRA for Apple Silicon",
  title: "HRA for macOS",
}, { canonicalPath: "/download" }) satisfies Metadata;

export default function DownloadPage() {
  return (
    <main className="download-page" id="main-content">
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

        <section className="download-hero" aria-labelledby="download-title">
          <div className="download-hero__copy">
            <p className="download-channel">
              <span aria-hidden="true" />
              Public prerelease
            </p>
            <h1 id="download-title">Build HRA on your Mac.</h1>
            <p className="download-summary">
              The native HRA app is available as source for Apple Silicon. Binary
              downloads are not published yet.
            </p>
            <p className="download-trust-callout">
              <strong>Prerelease software.</strong> Expect breaking changes while
              the public build and release process settles.
            </p>
            <div className="download-primary-action">
              <LinkButton
                href="https://github.com/hraness/hra#develop-hra"
                size="large"
                variant="primary"
              >
                Build from source <span aria-hidden="true">↗</span>
              </LinkButton>
              <p>Apple Silicon · macOS 13 or newer</p>
            </div>
          </div>

          <aside className="download-release-card" aria-label="HRA source build details">
            <div className="download-release-card__topline">
              <span>macOS source build</span>
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
                <dd>macOS 13</dd>
              </div>
              <div>
                <dt>Toolchain</dt>
                <dd>Bun 1.3.14 · Zig 0.16.0</dd>
              </div>
              <div>
                <dt>Distribution</dt>
                <dd>Source only</dd>
              </div>
            </dl>
            <p className="download-release-disclosure">
              This repository builds the native app locally. It does not create,
              sign, notarize, or publish an official consumer artifact.
            </p>
          </aside>
        </section>

        <section className="download-install" aria-labelledby="install-title">
          <div className="download-section-heading">
            <p className="eyebrow">Local build</p>
            <h2 id="install-title">Run the checked public source.</h2>
          </div>
          <ol className="download-steps" role="list">
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>Clone the repository</h3>
                <p>Clone <code>github.com/hraness/hra</code> on an Apple Silicon Mac.</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>Install the pinned workspace</h3>
                <p>Use Bun 1.3.14 and run <code>bun install --frozen-lockfile</code>.</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <div>
                <h3>Build the native app</h3>
                <p>Install Zig 0.16.0 and run <code>bun run --cwd apps/desktop build:macos</code>.</p>
              </div>
            </li>
          </ol>
          <p className="download-security-note">
            Read the repository requirements before running the app. HRA can
            coordinate coding agents with local filesystem and process authority.
          </p>
        </section>

        <section className="download-trust-grid" aria-label="Source and release status">
          <article>
            <p className="eyebrow">Source</p>
            <h2>Inspect every component.</h2>
            <p>
              The product source, build commands, tests, security model, and
              third-party notices live together in the public repository.
            </p>
            <a href="https://github.com/hraness/hra">Browse the repository →</a>
          </article>
          <article>
            <p className="eyebrow">Binaries</p>
            <h2>Consumer downloads are still ahead.</h2>
            <p>
              This page will identify downloadable releases only after a public,
              reproducible signing and publication boundary exists.
            </p>
          </article>
        </section>

        <footer className="download-footer">
          <span>HRA prerelease</span>
          <a href="https://github.com/hraness/hra">github.com/hraness/hra</a>
        </footer>
      </div>
    </main>
  );
}
