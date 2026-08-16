import {
  PageIntro,
  Skeleton,
  Spinner,
  ThemeToggle,
} from "@hra-internal/design-kit/react";

export default function Loading() {
  return (
    <main className="state-page" id="main-content">
      <ThemeToggle className="standalone-theme-toggle" />
      <section className="state-card state-card--loading" role="status">
        <PageIntro
          description="Restoring the server-authorized organization and task subscriptions."
          eyebrow="Human control plane"
          title="Opening HRA…"
        />
        <div className="state-loading-row">
          <Spinner label="Opening HRA" />
          <div>
            <Skeleton isText width="18rem" />
            <Skeleton isText width="11rem" />
          </div>
        </div>
      </section>
    </main>
  );
}
