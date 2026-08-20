import {
  Skeleton,
  Spinner,
  ThemeToggle,
} from "@hra-internal/design-kit/react";

export default function Loading() {
  return (
    <main className="state-page" id="main-content">
      <ThemeToggle className="standalone-theme-toggle" />
      <section className="state-card state-card--loading" role="status">
        <div className="state-loading-row">
          <Spinner label="Loading" />
          <div>
            <Skeleton isText width="18rem" />
            <Skeleton isText width="11rem" />
          </div>
        </div>
      </section>
    </main>
  );
}
